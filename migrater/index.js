/**
 * Lugawatch migrater — moves catalogue videos from their legacy source URLs to
 * Wasabi. Run one per server with pm2; run as many servers as you like.
 *
 * Per item: claim it from the API, download the source MP4 to local disk, prove it
 * is whole and really an MP4, then push it to Wasabi with presigned multipart URLs
 * and let the API verify and record it. Nothing is written to the bucket until the
 * file on disk has been proven good, because Wasabi bills every object deleted or
 * overwritten inside 90 days.
 *
 * Concurrency safety comes from the API: a claim is a row this worker owns, taken
 * atomically. Nothing here times anything out. If this process dies, its claims
 * stay put and it reclaims them by identity on the next boot; only a human (or the
 * worker itself) ever hands work back.
 */

const config = require('./config');
const api = require('./api');
const state = require('./state');
const download = require('./download');
const upload = require('./upload');
const { NotMp4Error, RevokedError } = require('./errors');

// An upload that dies on our side (Wasabi hiccup, API 5xx) is retried here rather
// than surrendered, because we still hold the claim and the parts already in
// Wasabi make the retry nearly free. Giving the task back would mean the next
// worker re-downloads the whole file.
const UPLOAD_ATTEMPTS = 3;

// A systemic outage — the source CDN down, Wasabi refusing, the API unreachable —
// would otherwise let the claim loop march through the whole backlog at full
// speed, spending both download attempts on every item and marking thousands
// permanently failed within minutes. After this many consecutive failures with no
// success in between, the loop backs off instead of burning the queue.
const FAILURE_STREAK_PAUSE = 5;
const MAX_STREAK_PAUSE_MS = 15 * 60 * 1000;

// Long enough to hand back the tasks that cost nothing, short enough that pm2's
// kill timeout does not SIGKILL us mid-sentence.
const SHUTDOWN_GRACE_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const active = new Map();   // taskId -> progress entry
let workerId = null;
let stopping = false;
let consecutiveFailures = 0;

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Readable at both ends of the range — episodes are MBs, films are GBs. */
const size = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
};

function describe(task) {
  const episode = task.episodeNumber ? ` E${task.episodeNumber}` : '';
  return `[${task.taskId}] ${task.title || 'untitled'}${episode}`;
}

// ─── One item, start to finish ───────────────────────────────────────────────

async function runTask(task) {
  const entry = {
    task,
    phase: task.phase || 'downloading',
    bytesDone: task.bytesDone || 0,
    bytesTotal: task.bytesTotal || 0,
    sessionId: task.sessionId || null,
    cancelled: false,
    completed: false,
  };
  active.set(String(task.taskId), entry);

  try {
    // 1. Source → disk. Returns only once the bytes on disk match the length the
    //    source declared, under a name that says so. A task resumed mid-upload
    //    already has its .mp4, and this returns it untouched.
    entry.phase = 'downloading';
    //    The budget is a snapshot, so two tasks starting together can jointly
    //    overshoot by at most one file each — bounded by CONCURRENCY, and tiny
    //    next to MAX_DISK_BYTES.
    const budget = Math.max(0, config.MAX_DISK_BYTES - state.diskUsed());
    const file = await download.downloadSource(task, {
      budgetBytes: budget,
      onProgress: (done, total) => { entry.bytesDone = done; entry.bytesTotal = total; },
    });
    log(`${describe(task)} downloaded ${size(file.size)}`);

    if (entry.cancelled || stopping) throw new RevokedError('Cancelled');

    // 2. The last gate before any Wasabi write: still ours, still needed, and for
    //    an episode still the same slot.
    const start = await api.request('POST', `/king/migration/tasks/${task.taskId}/start`, {
      workerId,
      fileSize: file.size,
    });
    if ([404, 409, 410].includes(start.status)) {
      throw new RevokedError(start.data?.error || `start refused (${start.status})`);
    }
    if (start.status !== 200) {
      throw new Error(`start failed (${start.status}): ${start.data?.error || 'unknown'}`);
    }

    // 3. Disk → Wasabi, resuming whatever already landed.
    entry.phase = 'uploading';
    entry.bytesDone = 0;
    entry.bytesTotal = file.size;

    let result = null;
    let uploadError = null;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      try {
        result = await upload.uploadToWasabi(
          start.data.uploadBase, file.path, file.size, file.fileName,
          {
            sessionId: entry.sessionId,
            onSession: (id) => { entry.sessionId = id; },
            onProgress: (done, total) => { entry.bytesDone = done; entry.bytesTotal = total; },
            isCancelled: () => entry.cancelled || stopping,
          }
        );
        uploadError = null;
        break;
      } catch (error) {
        if (entry.cancelled || stopping) throw new RevokedError('Cancelled');
        uploadError = error;
        log(`${describe(task)} upload attempt ${attempt}/${UPLOAD_ATTEMPTS} failed: ${error.message}`);
        if (attempt < UPLOAD_ATTEMPTS) await sleep(5000 * attempt);
      }
    }
    if (uploadError) throw uploadError;

    // The object is on Wasabi and the API has recorded it. From here the session
    // must never be aborted, whatever else goes wrong.
    entry.completed = true;

    // 4. Release the claim. The API only accepts this once the catalogue really
    //    carries a wasabi_key — written by the same verification the dashboard uses.
    const done = await api.request('POST', `/king/migration/tasks/${task.taskId}/done`, {
      workerId,
      sessionId: result.sessionId,
    });
    if (done.status === 404) {
      // Someone requeued us mid-flight, but the video landed anyway. Whoever holds
      // the task now will see the wasabi_key and close it out.
      log(`${describe(task)} completed after being requeued — nothing to do`);
    } else if (done.status !== 200) {
      throw new Error(`done failed (${done.status}): ${done.data?.error || 'unknown'}`);
    } else {
      log(`${describe(task)} ✅ ${result.key} (${result.size})`);
    }

    state.cleanupTask(task.taskId);
    consecutiveFailures = 0;
  } catch (error) {
    await handleFailure(task, entry, error);
  } finally {
    active.delete(String(task.taskId));
  }
}

async function handleFailure(task, entry, error) {
  // Shutting down is not a failure. The partly-downloaded file, the multipart
  // upload and the claim all survive, so the restart continues where this left
  // off. Cleaning up here is precisely what would make a pm2 restart cost a full
  // re-download and re-upload.
  if (stopping) {
    log(`${describe(task)} paused for shutdown — local file and upload session kept`);
    return;
  }

  // Ran out of disk before the file would fit — hand it straight back so a server
  // with room can take it. Costs the item nothing.
  if (error.budget) {
    log(`${describe(task)} skipped: ${error.message}`);
    state.cleanupTask(task.taskId);
    await safeCall('POST', `/king/migration/tasks/${task.taskId}/release`, { workerId });
    return;
  }

  if (error instanceof RevokedError) {
    log(`${describe(task)} dropped: ${error.message}`);
    if (!entry.completed) await upload.abortSession(task.uploadBase, entry.sessionId);
    state.cleanupTask(task.taskId);
    return;
  }

  const kind = error instanceof NotMp4Error ? 'not-mp4' : (error.kind === 'source' ? 'source' : 'infra');
  log(`${describe(task)} failed (${kind}): ${error.message}`);

  // An abandoned multipart upload keeps billing until it is aborted — but a
  // COMPLETED one must be left alone: aborting it would mark a good session dead.
  if (!entry.completed) await upload.abortSession(task.uploadBase, entry.sessionId);
  state.cleanupTask(task.taskId);

  await safeCall('POST', `/king/migration/tasks/${task.taskId}/fail`, {
    workerId,
    kind,
    error: error.message,
  });

  consecutiveFailures++;
}

/** Reporting a failure must never itself become an unhandled failure. */
async function safeCall(method, path, body) {
  try {
    return await api.request(method, path, body);
  } catch (error) {
    log(`${method} ${path} failed: ${error.message}`);
    return null;
  }
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

let heartbeatInFlight = false;

/**
 * Progress for the dashboard, and a liveness signal an admin can read.
 *
 * It also refreshes each upload session's updated_at on the API side: the hourly
 * cleanup cron aborts sessions untouched for 24h, and nothing else touches one
 * during a direct-to-Wasabi upload, so a genuinely live long transfer needs this
 * to avoid being reaped mid-flight.
 */
async function heartbeat() {
  // A slow API can make a heartbeat outlast its own interval; without this guard
  // they would pile up and turn a hiccup into a request storm.
  if (heartbeatInFlight || active.size === 0 || stopping) return;
  heartbeatInFlight = true;

  try {
    const tasks = [...active.values()].map((entry) => ({
      taskId: entry.task.taskId,
      phase: entry.phase,
      bytesDone: entry.bytesDone,
      bytesTotal: entry.bytesTotal,
      sessionId: entry.sessionId,
    }));

    const response = await safeCall('POST', '/king/migration/heartbeat', { workerId, tasks });
    if (!response || response.status !== 200) return;

    for (const taskId of response.data.revoked || []) {
      const entry = active.get(String(taskId));
      if (entry) {
        log(`[${taskId}] revoked by the API — stopping`);
        entry.cancelled = true;
      }
    }
  } finally {
    heartbeatInFlight = false;
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function claimLoop() {
  while (!stopping) {
    try {
      // Back off when everything is failing, so an outage cannot chew through the
      // backlog marking items permanently failed.
      if (consecutiveFailures >= FAILURE_STREAK_PAUSE) {
        const pause = Math.min(
          60_000 * 2 ** (consecutiveFailures - FAILURE_STREAK_PAUSE),
          MAX_STREAK_PAUSE_MS
        );
        log(`${consecutiveFailures} consecutive failures — pausing ${Math.round(pause / 1000)}s`);
        await sleep(pause);
        if (stopping) break;
      }

      const free = config.CONCURRENCY - active.size;
      if (free <= 0) {
        await sleep(2000);
        continue;
      }

      const used = state.diskUsed();
      if (used >= config.MAX_DISK_BYTES) {
        log(`disk budget full (${size(used)}), waiting`);
        await sleep(config.IDLE_POLL_MS);
        continue;
      }

      // Only ever claim what we can actually start. Holding idle claims would
      // keep other servers off that work for no reason.
      const data = await api.requestOk('POST', '/king/migration/claim', {
        workerId,
        limit: Math.min(free, config.BATCH_SIZE),
      });

      if (!data.tasks || data.tasks.length === 0) {
        await sleep(config.IDLE_POLL_MS);
        continue;
      }

      log(`claimed ${data.tasks.length} task(s)`);
      for (const task of data.tasks) {
        runTask(task).catch((error) => log(`[${task.taskId}] unexpected: ${error.message}`));
      }
    } catch (error) {
      // Includes the login cooldown, which is exactly when slowing down matters.
      log(`claim loop error: ${error.message}`);
      await sleep(config.IDLE_POLL_MS);
    }
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

/**
 * Authenticate without ever crash-looping.
 *
 * Exiting on a failed login would have pm2 restart us straight into another
 * attempt, and five of those inside 15 minutes locks the account out of the login
 * endpoint entirely. Waiting in-process is both cheaper and recoverable.
 */
async function authenticate() {
  for (let attempt = 1; !stopping; attempt++) {
    try {
      await api.ensureAuth();
      return;
    } catch (error) {
      const wait = Math.min(60_000 * attempt, MAX_STREAK_PAUSE_MS);
      log(`authentication failed: ${error.message} — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

async function main() {
  // Refuses to start if another process owns this directory — two workers sharing
  // one would both reclaim the same tasks and upload everything twice.
  state.acquireLock();
  workerId = state.resolveWorkerId();

  log(`migrater starting — worker ${workerId}, work dir ${state.WORK_DIR}`);
  log(`api ${config.API_ORIGIN}, concurrency ${config.CONCURRENCY}, disk budget ${size(config.MAX_DISK_BYTES)}`);

  await authenticate();

  // Everything this worker still owns from before it went down. The API closes out
  // anything that actually finished, so what comes back genuinely needs work.
  let resumed = { tasks: [] };
  try {
    resumed = await api.requestOk('POST', '/king/migration/resume', { workerId });
  } catch (error) {
    // Starting fresh is safe — the claims stay ours and the next boot readopts
    // them — but sweeping now would delete files those claims still need.
    log(`resume failed (${error.message}); continuing without readopting or sweeping`);
    resumed = null;
  }

  if (resumed) {
    const adopted = (resumed.tasks || []).map((task) => task.taskId);

    // Files for tasks we did not get back belong to nobody now; keeping them would
    // leak disk and re-uploading them would duplicate someone else's work.
    const swept = state.sweepOrphans(adopted);
    if (swept.length) log(`swept ${swept.length} orphaned staging file set(s)`);

    if (adopted.length) {
      log(`resuming ${adopted.length} task(s) from the previous run`);
      for (const task of resumed.tasks) {
        runTask(task).catch((error) => log(`[${task.taskId}] unexpected: ${error.message}`));
      }
    }
  }

  setInterval(() => { heartbeat().catch(() => {}); }, config.HEARTBEAT_MS);

  await claimLoop();
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

/**
 * Stop claiming, then give back only the tasks that have cost nothing yet.
 *
 * Anything with real progress is KEPT — file, multipart upload and claim all stay
 * exactly where they are, so the restart resumes for free. handleFailure's first
 * branch is what guarantees that: during shutdown it cleans up nothing.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  log(`${signal} received — stopping`);

  const releases = [];
  for (const entry of active.values()) {
    if (entry.phase === 'downloading' && entry.bytesDone === 0) {
      releases.push(safeCall('POST', `/king/migration/tasks/${entry.task.taskId}/release`, { workerId }));
    }
  }

  // Bounded: pm2 SIGKILLs after its kill timeout, and an unreachable API must not
  // make us hang until then. Anything unreleased simply stays ours to resume.
  await Promise.race([Promise.all(releases), sleep(SHUTDOWN_GRACE_MS)]);

  log(`${active.size} task(s) left claimed for this worker to resume on restart`);
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

// Let pm2 restart us rather than limping on in an unknown state — boot resumes
// every claim we still hold, and the cached token means a restart costs no login.
process.on('uncaughtException', (error) => {
  log('uncaught exception:', error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  log('unhandled rejection:', error);
  process.exit(1);
});

main().catch((error) => {
  log('fatal:', error.message);
  process.exit(1);
});
