/**
 * Ownership of WORK_DIR: the lockfile, this worker's identity, the per-task
 * sidecars, and the boot-time sweep.
 *
 * The identity question matters more than it looks. A worker reclaims its own
 * in-flight tasks by worker_id, and those tasks' half-downloaded files live on
 * THIS disk — so identity must be a property of the disk, not of a config file
 * that gets copied to the next server. Hence: generated once, stored in
 * WORK_DIR/worker-id, and a lockfile so two processes can never share one.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const config = require('./config');
const { InfraError } = require('./errors');

const WORK_DIR = path.resolve(__dirname, config.WORK_DIR);
const LOCK_FILE = path.join(WORK_DIR, '.lock');
const ID_FILE = path.join(WORK_DIR, 'worker-id');
const TOKEN_FILE = path.join(WORK_DIR, 'token');

const partPath = (taskId) => path.join(WORK_DIR, `${taskId}.part`);
const filePath = (taskId) => path.join(WORK_DIR, `${taskId}.mp4`);
const sidecarPath = (taskId) => path.join(WORK_DIR, `${taskId}.json`);

function ensureWorkDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

/**
 * Refuse to start if another process already owns this directory.
 *
 * Two processes sharing a WORK_DIR would both reclaim the same tasks on boot and
 * upload the same files twice. `wx` makes creation atomic, so the check has no
 * race. A leftover lock from a crash is detected by asking the OS whether that PID
 * still exists — a fact, not a timeout — and only then taken over.
 */
function acquireLock() {
  ensureWorkDir();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = fs.openSync(LOCK_FILE, 'wx');
      fs.writeFileSync(handle, String(process.pid));
      fs.closeSync(handle);

      const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ } };
      process.on('exit', release);
      return release;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const owner = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (Number.isInteger(owner) && isProcessAlive(owner)) {
        throw new InfraError(
          `${WORK_DIR} is already in use by pid ${owner}. Each migrater process needs its own WORK_DIR.`
        );
      }

      // The owner is gone (killed, or the machine rebooted). Reclaim and retry.
      fs.unlinkSync(LOCK_FILE);
    }
  }

  throw new InfraError(`Could not acquire ${LOCK_FILE}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return error.code === 'EPERM';
  }
}

/** Stable across restarts, unique per work directory. */
function resolveWorkerId() {
  ensureWorkDir();

  if (fs.existsSync(ID_FILE)) {
    const existing = fs.readFileSync(ID_FILE, 'utf8').trim();
    if (existing) return existing;
  }

  const id = `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(ID_FILE, id);
  return id;
}

// ─── Auth token ──────────────────────────────────────────────────────────────
//
// The token is cached on disk, and this is not an optimisation — it is what keeps
// a worker out of the login rate limiter. /king/auth/login allows 5 attempts per
// 15 minutes per IP (and 5 per 15 minutes for the username, shared across the
// whole fleet). A worker that logged in on every boot would lock itself out after
// five restarts, and a crash loop would then be unable to authenticate at all.
// The JWT is valid for 7 days, so reusing it across restarts costs zero attempts.

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function writeToken(token) {
  ensureWorkDir();
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

function clearToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone */ }
}

// ─── Per-task sidecar ────────────────────────────────────────────────────────
// Only what the SOURCE told us, which is the one thing the API cannot tell us on
// resume: the validators needed to send If-Range so a source file that changed
// underneath us is detected instead of being spliced into the old download.
// sessionId/key/partSize live in movie_upload_sessions and come back from /resume.

function readSidecar(taskId) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(taskId), 'utf8'));
  } catch {
    return null;
  }
}

function writeSidecar(taskId, data) {
  const tmp = `${sidecarPath(taskId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, sidecarPath(taskId));
}

function cleanupTask(taskId) {
  const targets = [partPath(taskId), filePath(taskId), sidecarPath(taskId)];
  // A crash between writeFileSync and renameSync leaves a .json.tmp behind; it
  // would otherwise sit in the work dir until the next boot sweep.
  targets.push(`${sidecarPath(taskId)}.tmp`);
  for (const target of targets) {
    try { fs.unlinkSync(target); } catch { /* not there */ }
  }
}

function sizeOf(target) {
  try { return fs.statSync(target).size; } catch { return 0; }
}

/** Bytes currently staged, for the disk budget. */
function diskUsed() {
  ensureWorkDir();
  let total = 0;
  for (const name of fs.readdirSync(WORK_DIR)) {
    if (name.endsWith('.part') || name.endsWith('.mp4')) {
      total += sizeOf(path.join(WORK_DIR, name));
    }
  }
  return total;
}

/**
 * Delete files belonging to tasks this worker did not get back from /resume.
 *
 * Those are leftovers from claims an admin requeued while we were down — the item
 * belongs to someone else now (or to nobody), so keeping its bytes would leak disk
 * forever and re-uploading them would be someone else's work done twice.
 */
function sweepOrphans(adoptedTaskIds) {
  ensureWorkDir();
  const keep = new Set(adoptedTaskIds.map(String));
  const orphans = new Set();

  for (const name of fs.readdirSync(WORK_DIR)) {
    const match = name.match(/^(\d+)\.(part|mp4|json)(\.tmp)?$/);
    if (!match) continue;
    if (!keep.has(match[1])) orphans.add(match[1]);
  }

  for (const taskId of orphans) cleanupTask(taskId);
  return [...orphans];
}

module.exports = {
  WORK_DIR,
  acquireLock,
  resolveWorkerId,
  readToken,
  writeToken,
  clearToken,
  partPath,
  filePath,
  readSidecar,
  writeSidecar,
  cleanupTask,
  sizeOf,
  diskUsed,
  sweepOrphans,
};
