/**
 * Push a verified local file to Wasabi through the API's presigned multipart
 * endpoints — the exact path the Upload Center's browser client uses, so the
 * bucket-facing behaviour is code already proven in production.
 *
 * This process holds no Wasabi credentials. It asks the API to sign each part and
 * PUTs bytes at the URL it is handed, which is why a compromised migrater server
 * cannot reach the bucket.
 *
 * Two rules are non-negotiable and both come from how the URLs are signed:
 *
 *   1. A part PUT must send NO Content-Type. The API signs UploadPart without one
 *      (the browser sends a bare Blob, whose type is empty), so adding a value
 *      here yields SignatureDoesNotMatch. That is why these use node's raw https
 *      client rather than a library that helpfully sets headers.
 *
 *   2. Every part's ETag must be kept and sent back, sorted ascending, or the
 *      multipart upload cannot be completed.
 *
 * Resume is Wasabi's own ListParts, via GET /video/parts: whatever already landed
 * is never uploaded twice, so a restarted worker costs nothing.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const config = require('./config');
const api = require('./api');
const { InfraError } = require('./errors');

const MAX_PART_URLS_PER_REQUEST = 50;   // the API's own cap

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 16 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 16 }),
};

/** PUT one byte range at a presigned URL and return the ETag Wasabi assigns it. */
function putPart(signedUrl, filePath, start, length) {
  return new Promise((resolve, reject) => {
    const url = new URL(signedUrl);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(url, {
      method: 'PUT',
      // Content-Length only. Anything else risks breaking the signature.
      headers: { 'Content-Length': length },
      agent: agents[url.protocol],
      timeout: 15 * 60_000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Part upload failed (${res.statusCode}): ${body.slice(0, 300)}`));
        }
        const etag = res.headers.etag;
        if (!etag) return reject(new Error('Wasabi returned no ETag for this part'));
        resolve(etag);
      });
    });

    req.on('timeout', () => req.destroy(new Error('Part upload timed out')));
    req.on('error', reject);

    const source = fs.createReadStream(filePath, { start, end: start + length - 1 });
    source.on('error', (error) => { req.destroy(); reject(error); });
    source.pipe(req);
  });
}

/**
 * Start a session, or adopt the one from a previous run.
 *
 * A session that no longer answers (aborted, superseded, expired) means starting
 * a new one — and /video/init aborts whatever was open for this slot first, so
 * the dead upload's parts are released rather than left billing.
 */
async function ensureSession(uploadBase, existingSessionId, fileName, fileSize) {
  if (existingSessionId) {
    // A session whose multipart upload is gone makes the API's ListParts throw,
    // which surfaces as a 500 — so this must swallow failures and fall through to
    // a fresh session rather than propagate. Retries are pointless here for the
    // same reason: we are only asking whether the old session is still usable.
    try {
      const probe = await api.request(
        'GET', `${uploadBase}/video/parts?sessionId=${existingSessionId}`, undefined, { retries: 1 }
      );
      if (probe.status === 200) {
        const partSize = Number(probe.data.partSize);
        const totalParts = Number(probe.data.totalParts);

        // The session was sized for the file we had LAST time. If the local file
        // is now a different size — the source changed and we re-downloaded — its
        // part layout no longer describes this file, and reusing it would upload
        // wrongly-sized parts into an object the API then rejects on its length
        // check and DELETES. That deletion is billed for 90 days, so the mismatch
        // has to be caught here, before a single part is pushed.
        const expected = Math.max(1, Math.ceil(fileSize / partSize));
        if (Number.isFinite(partSize) && partSize > 0 && totalParts === expected) {
          return {
            sessionId: existingSessionId,
            partSize,
            totalParts,
            landed: probe.data.parts || [],
          };
        }
      }
    } catch {
      // Fall through: /video/init below aborts whatever was open for this slot,
      // so the dead upload's parts are released rather than left billing.
    }
  }

  const created = await api.requestOk('POST', `${uploadBase}/video/init`, {
    fileName,
    fileSize,
    contentType: 'video/mp4',
  });

  return {
    sessionId: created.sessionId,
    partSize: Number(created.partSize),
    totalParts: Number(created.totalParts),
    landed: [],
  };
}

/**
 * @returns {Promise<{sessionId: string, key: string, size: string}>}
 */
async function uploadToWasabi(uploadBase, filePath, fileSize, fileName, {
  sessionId: existingSessionId,
  onSession,
  onProgress,
  isCancelled = () => false,
} = {}) {
  const session = await ensureSession(uploadBase, existingSessionId, fileName, fileSize);
  const { sessionId, partSize, totalParts } = session;

  if (onSession) onSession(sessionId);

  // Parts Wasabi already holds. Resuming from these is what makes a restart free.
  const etags = new Map();
  let uploadedBytes = 0;
  for (const part of session.landed) {
    etags.set(Number(part.PartNumber), part.ETag);
    uploadedBytes += Number(part.Size) || 0;
  }

  const pending = [];
  for (let n = 1; n <= totalParts; n++) if (!etags.has(n)) pending.push(n);

  if (onProgress) onProgress(uploadedBytes, fileSize);

  const urlCache = new Map();

  async function signBatch(partNumbers) {
    const data = await api.requestOk('POST', `${uploadBase}/video/part-urls`, {
      sessionId,
      partNumbers,
    });
    for (const { partNumber, url } of data.urls) urlCache.set(Number(partNumber), url);
  }

  async function urlFor(partNumber, { fresh = false } = {}) {
    if (fresh || !urlCache.has(partNumber)) await signBatch([partNumber]);
    return urlCache.get(partNumber);
  }

  // Pre-sign in batches so the common path costs one API call per 50 parts.
  for (let i = 0; i < pending.length; i += MAX_PART_URLS_PER_REQUEST) {
    await signBatch(pending.slice(i, i + MAX_PART_URLS_PER_REQUEST));
  }

  let cursor = 0;
  let failure = null;

  const worker = async () => {
    while (cursor < pending.length && !failure) {
      if (isCancelled()) {
        failure = failure || new Error('Cancelled');
        return;
      }

      const partNumber = pending[cursor++];
      const start = (partNumber - 1) * partSize;
      const length = Math.min(partSize, fileSize - start);

      let lastError = null;
      for (let attempt = 1; attempt <= config.PART_ATTEMPTS; attempt++) {
        try {
          // Re-sign on every retry: a failed PUT is most often a URL that expired
          // while it sat in the queue behind a multi-gigabyte part.
          const url = await urlFor(partNumber, { fresh: attempt > 1 });
          const etag = await putPart(url, filePath, start, length);
          etags.set(partNumber, etag);
          uploadedBytes += length;
          if (onProgress) onProgress(uploadedBytes, fileSize);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < config.PART_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          }
        }
      }

      if (lastError) {
        failure = failure || new InfraError(`Part ${partNumber}: ${lastError.message}`);
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(config.PART_CONCURRENCY, Math.max(1, pending.length)) }, worker)
  );

  if (failure) throw failure;

  const parts = [...etags.entries()]
    .map(([PartNumber, ETag]) => ({ PartNumber, ETag }))
    .sort((a, b) => a.PartNumber - b.PartNumber);

  if (parts.length !== totalParts) {
    throw new InfraError(`Only ${parts.length} of ${totalParts} parts uploaded`);
  }

  // The API completes the multipart upload, HEADs the object to check its length
  // against what we declared, reads its first bytes back to confirm a real MP4
  // header, and only then writes the wasabi_key. A 4xx here is its verdict and
  // must not be retried; api.request already retries only network errors and 5xx.
  const response = await api.request('POST', `${uploadBase}/video/complete`, { sessionId, parts });
  if (response.status !== 200) {
    const error = new InfraError(
      `Complete failed (${response.status}): ${response.data?.error || 'unknown'}`
    );
    error.status = response.status;
    throw error;
  }

  return { sessionId, key: response.data.key, size: response.data.size };
}

/** Best-effort: release an abandoned multipart upload so its parts stop billing. */
async function abortSession(uploadBase, sessionId) {
  if (!sessionId) return;
  try {
    await api.request('POST', `${uploadBase}/video/abort`, { sessionId });
  } catch {
    // The hourly cleanup cron on the API is the backstop.
  }
}

module.exports = { uploadToWasabi, abortSession };
