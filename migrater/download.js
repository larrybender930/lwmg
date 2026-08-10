/**
 * Fetch a source video to local disk, resumably.
 *
 * The file is the source MP4 exactly as served — one ordinary HTTP GET, no
 * chunking, no transformation. It lands on `{taskId}.part` and is renamed to
 * `{taskId}.mp4` only once the bytes on disk equal the length the source
 * declared. That rename is the whole point: a killed download leaves a truncated
 * file whose `ftyp` header is still perfectly valid, and we declare the file's own
 * size to the upload API — so both of the API's guards would pass and we would
 * publish a movie that cuts off partway. The suffix makes "complete" a fact.
 *
 * Two other things earn their keep here:
 *
 *   - The MP4 check runs on the FIRST 12 BYTES OFF THE WIRE, so an HLS playlist or
 *     a CDN's HTML error page (both of which arrive as 200 OK, where no status
 *     check would catch them) costs nothing and fails the item immediately.
 *
 *   - Connection-level failures retry internally, resuming from the .part via
 *     Range/If-Range. Only exhausting those counts as one of the item's two
 *     attempts, so a flaky link does not permanently fail good content.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const config = require('./config');
const state = require('./state');
const { NotMp4Error, SourceError } = require('./errors');

const MAX_REDIRECTS = 5;

// ISO-BMFF: an "ftyp" box at offset 4, brand at offset 8. Same set the API checks
// in uploadController.isMp4Header — keep them in step.
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'mmp4',
]);

function isMp4Header(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.slice(4, 8).toString('ascii') !== 'ftyp') return false;
  return MP4_BRANDS.has(buf.slice(8, 12).toString('ascii'));
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

/**
 * Source URLs in the catalogue contain literal spaces
 * ("…/THE CONFESSION EMMY.2026.mp4"). Passing one through raw produces a malformed
 * request line and a 400/404 from the CDN; URL normalisation percent-encodes them.
 */
function normalizeUrl(raw) {
  return new URL(String(raw).trim()).toString();
}

/** A filename the upload API will accept: it insists on an .mp4 suffix. */
function fileNameFor(rawUrl, fallback) {
  let name = '';
  try {
    name = decodeURIComponent(new URL(normalizeUrl(rawUrl)).pathname.split('/').pop() || '');
  } catch {
    name = '';
  }
  name = name.replace(/[\r\n"\\]/g, '').trim();
  if (!name) name = String(fallback || 'video').replace(/[\r\n"\\/]/g, '').trim() || 'video';
  if (!/\.mp4$/i.test(name)) name += '.mp4';
  return name.slice(-200);
}

function open(urlString, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'lugawatch-migrater/1.0', Accept: '*/*', ...headers },
      agent: agents[url.protocol],
      timeout: 60_000,
    }, (res) => resolve({ req, res }));

    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** GET with manual redirect following — node's http client does not follow. */
async function openFollowing(urlString, headers) {
  let current = urlString;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { req, res } = await open(current, headers);

    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();               // drain so the socket can be reused
      req.destroy();
      current = new URL(res.headers.location, current).toString();
      continue;
    }

    return { req, res, finalUrl: current };
  }

  throw new SourceError(`Too many redirects from ${urlString}`);
}

/**
 * @returns {Promise<{path: string, size: number, fileName: string}>}
 */
async function downloadSource(task, { onProgress, budgetBytes } = {}) {
  const url = normalizeUrl(task.sourceUrl);
  const part = state.partPath(task.taskId);
  const finished = state.filePath(task.taskId);
  const fileName = fileNameFor(task.sourceUrl, task.title);

  // Staleness first: bytes fetched from a different URL are unrelated to this
  // task, whether they are a partial or a finished file. Checking this before
  // trusting anything on disk is what makes the shortcut below safe.
  let sidecar = state.readSidecar(task.taskId);
  if (sidecar && sidecar.sourceUrl !== url) {
    state.cleanupTask(task.taskId);
    sidecar = null;
  }

  // Already downloaded and proven whole on a previous run — nothing to do.
  const doneSize = state.sizeOf(finished);
  if (doneSize > 0) return { path: finished, size: doneSize, fileName };

  let lastError = null;

  for (let attempt = 1; attempt <= config.DOWNLOAD_CONNECT_RETRIES; attempt++) {
    try {
      return await attemptDownload({ url, part, finished, fileName, task, sidecar, onProgress, budgetBytes });
    } catch (error) {
      // A bad source and a full disk are both final — only connection trouble is
      // worth another go.
      if (error instanceof NotMp4Error) throw error;
      if (error.permanent) throw error;

      lastError = error;
      sidecar = state.readSidecar(task.taskId);
      if (attempt < config.DOWNLOAD_CONNECT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  throw new SourceError(lastError?.message || 'Download failed');
}

function attemptDownload({ url, part, finished, fileName, task, sidecar, onProgress, budgetBytes }) {
  return new Promise((resolve, reject) => {
    let offset = state.sizeOf(part);

    // Resuming without a validator risks splicing two different files together, so
    // a source that gave us no ETag or Last-Modified starts over instead.
    const validator = sidecar?.etag || sidecar?.lastModified || null;
    if (offset > 0 && !validator) {
      try { fs.unlinkSync(part); } catch { /* not there */ }
      offset = 0;
    }

    // A .part too short to hold an ftyp box cannot be checked, and resuming it
    // would make the check below read 12 bytes off a shorter file and wrongly
    // condemn a perfectly good source as "not an MP4". Those few bytes are worth
    // nothing anyway.
    if (offset > 0 && offset < 12) {
      try { fs.unlinkSync(part); } catch { /* not there */ }
      offset = 0;
    }

    const headers = {};
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      headers['If-Range'] = validator;
    }

    openFollowing(url, headers).then(({ req, res }) => {
      // Declared before settle(): several early exits below call settle() before
      // the download loop starts, and a `let` referenced above its declaration
      // would throw instead of reporting the real error.
      let stallTimer = null;
      let settled = false;

      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        req.destroy();
        if (error) reject(error); else resolve(value);
      };

      const status = res.statusCode;

      if (status === 416) {
        // Our .part is at or past the file's length — it cannot be trusted.
        res.resume();
        try { fs.unlinkSync(part); } catch { /* not there */ }
        return settle(Object.assign(new Error('Stale partial file, restarting'), { permanent: false }));
      }

      if (status !== 200 && status !== 206) {
        res.resume();
        const error = new SourceError(`Source returned HTTP ${status}`);
        // 4xx is the origin's verdict; retrying the connection will not change it.
        error.permanent = status >= 400 && status < 500;
        return settle(error);
      }

      // A 200 to a ranged request means the origin ignored it (or the file
      // changed and If-Range invalidated our copy): start clean.
      let writeOffset = offset;
      if (status === 200 && offset > 0) {
        try { fs.unlinkSync(part); } catch { /* not there */ }
        writeOffset = 0;
      }

      // A 206 must actually start where we asked. A server that answers 206 from
      // a different offset would have us write its bytes at the wrong position —
      // and that corruption is invisible downstream: the file would still be the
      // right LENGTH with an intact ftyp header, so the API's size check and
      // magic-byte check would both pass and an unplayable movie would go live.
      // Cheap to verify, so verify.
      let rangeTotal = null;
      if (status === 206) {
        const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(res.headers['content-range'] || '');
        if (!match || Number(match[1]) !== writeOffset) {
          res.resume();
          try { fs.unlinkSync(part); } catch { /* not there */ }
          return settle(new Error(
            `Source resumed at the wrong offset (asked ${writeOffset}, got "${res.headers['content-range'] || 'no Content-Range'}")`
          ));
        }
        if (match[3] !== '*') rangeTotal = Number(match[3]);
      }

      const contentLength = Number(res.headers['content-length']);
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        res.resume();
        // Without a declared length there is no way to prove the download is
        // whole, and an unprovable file must never reach the bucket.
        return settle(Object.assign(
          new SourceError('Source did not declare a Content-Length'),
          { permanent: true }
        ));
      }

      // Content-Range's third field is the authoritative FULL size; Content-Length
      // is only the size of this slice. Deriving the total from the slice would
      // make a server that returns a short slice look complete — bytes received
      // would equal the total we computed, the rename would fire, and a truncated
      // movie would be uploaded. Trust the full size when the server states it.
      const total = rangeTotal != null && rangeTotal > 0
        ? rangeTotal
        : writeOffset + contentLength;

      // Only the bytes still to fetch count against the budget — whatever is
      // already in the .part is included in the caller's disk usage figure.
      if (budgetBytes != null && contentLength > budgetBytes) {
        res.resume();
        return settle(Object.assign(
          new Error(`Needs ${contentLength} more bytes, only ${budgetBytes} of disk budget left`),
          { permanent: true, budget: true }
        ));
      }

      if (writeOffset === 0) {
        state.writeSidecar(task.taskId, {
          sourceUrl: url,
          etag: res.headers.etag || null,
          lastModified: res.headers['last-modified'] || null,
          declaredSize: total,
          fileName,
        });
      }

      // On a resume the first bytes arrived last time, so the header is checked
      // against the file we already have rather than the wire.
      let headerChecked = writeOffset > 0;
      if (headerChecked && !localHeaderIsMp4(part)) {
        res.resume();
        return settle(new NotMp4Error('Staged file is not an MP4'));
      }

      let sniff = Buffer.alloc(0);
      let written = writeOffset;

      const sink = fs.createWriteStream(part, { flags: writeOffset > 0 ? 'r+' : 'w', start: writeOffset });
      sink.on('error', (error) => settle(error));

      const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          // Settle first, for the same reason as the MP4 check above: tearing the
          // socket down can emit 'aborted' synchronously and replace this message.
          settle(new Error(`No data for ${config.DOWNLOAD_STALL_MS}ms`));
          sink.destroy();
        }, config.DOWNLOAD_STALL_MS);
      };
      resetStall();

      res.on('data', (chunk) => {
        resetStall();

        if (!headerChecked) {
          sniff = Buffer.concat([sniff, chunk]);
          if (sniff.length >= 12) {
            headerChecked = true;
            if (!isMp4Header(sniff)) {
              // settle() BEFORE tearing the socket down: destroy() can emit
              // 'aborted' synchronously, and that generic (retryable) error would
              // otherwise win the race and mask this permanent verdict — turning
              // "not an MP4" into something we would pointlessly retry.
              settle(new NotMp4Error('Source is not an MP4 file'));
              sink.destroy();
              try { fs.unlinkSync(part); } catch { /* not there */ }
              return;
            }
          }
        }

        written += chunk.length;
        if (onProgress) onProgress(written, total);
      });

      res.on('error', (error) => { sink.destroy(); settle(error); });

      // A source that drops the socket mid-file does not always surface as
      // 'error'. Without this the attempt would sit until the stall timer fires
      // minutes later instead of reconnecting straight away.
      res.on('aborted', () => {
        sink.destroy();
        settle(new Error('Source closed the connection early'));
      });

      res.pipe(sink);

      sink.on('finish', () => {
        clearTimeout(stallTimer);

        const onDisk = state.sizeOf(part);
        if (onDisk !== total) {
          return settle(new Error(`Truncated: ${onDisk} of ${total} bytes`));
        }
        if (!headerChecked || !localHeaderIsMp4(part)) {
          try { fs.unlinkSync(part); } catch { /* not there */ }
          return settle(new NotMp4Error('Source is not an MP4 file'));
        }

        // Only now is the file provably whole, and only now does it get a name
        // that says so.
        fs.renameSync(part, finished);
        settle(null, { path: finished, size: onDisk, fileName });
      });
    }).catch(reject);
  });
}

function localHeaderIsMp4(target) {
  let fd = null;
  try {
    fd = fs.openSync(target, 'r');
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    return read === 12 && isMp4Header(buf);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

module.exports = { downloadSource, fileNameFor, normalizeUrl, isMp4Header };
