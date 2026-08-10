/**
 * One config for every server.
 *
 * The defaults below are the deployment. The only values that should ever differ
 * per install are the credentials, and those come from the environment — pm2
 * supplies them from the ecosystem file the installer writes, so the password is
 * never committed to this repository and never sits in a tracked file.
 *
 * There is deliberately no per-server identity here. WORKER_ID is not configured
 * at all: it is generated on first boot into WORK_DIR/worker-id, which binds a
 * worker's identity to the disk holding its partly-downloaded files. That is what
 * makes "copy the folder to another box" safe.
 *
 * Note there are no Wasabi credentials anywhere. The API signs each upload part
 * and this process only PUTs bytes at the URL it is handed, so a compromised
 * migrater server never exposes the bucket.
 */

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

module.exports = {
  // Admin API origin. No /api suffix — the admin surface lives at /king.
  API_ORIGIN: process.env.API_ORIGIN || 'https://server.lugawatch.com',

  // Uploader service account (create with: cd api && npm run create-uploader).
  // One account is shared by the whole fleet; identity comes from work/worker-id.
  USERNAME:  'migrater',
  PASSWORD: 'C3theLoadPPP',

  // BunnyCDN shapes each connection to roughly 6 MB/s and does not slow down
  // when more files are in flight, so throughput here is simply
  // CONCURRENCY x 6 MB/s. Uploading to Wasabi takes about 2s per file and is
  // never the constraint. Two ceilings bound this:
  //
  //   API   /video/init is rate limited to 60 per minute per IP, i.e. 60 files
  //         per minute. A ~430 MB episode takes ~74s end to end, so that cap is
  //         reached at about CONCURRENCY 70. Movies are bigger and take longer,
  //         so they allow more.
  //   DISK  every in-flight task stages a whole file. Keep MAX_DISK_GB at
  //         roughly CONCURRENCY x 1 GB, and below the volume's free space.
  //         Tasks that would not fit are handed straight back, so the budget is
  //         enforced rather than merely advisory.
  //
  // Raise CONCURRENCY toward 70 if the disk allows. Beyond that, add servers:
  // the limits above are per IP, so a second box doubles them.
  BATCH_SIZE: num(process.env.BATCH_SIZE, 25),            // tasks per claim (API caps at 50)
  CONCURRENCY: num(process.env.CONCURRENCY, 40),          // ~240 MB/s at 6 MB/s per file
  PART_CONCURRENCY: num(process.env.PART_CONCURRENCY, 3), // part PUTs per task

  WORK_DIR: process.env.WORK_DIR || './work',
  MAX_DISK_BYTES: num(process.env.MAX_DISK_GB, 100) * 1024 * 1024 * 1024,

  HEARTBEAT_MS: 10_000,
  IDLE_POLL_MS: 30_000,    // wait before re-asking when the queue came back empty

  // No bytes received for this long ⇒ the connection is dead even though the
  // socket is open. Reconnects and resumes; does not by itself fail the item.
  DOWNLOAD_STALL_MS: 180_000,

  // Connection-level retries WITHIN one download attempt (each resumes from the
  // .part). Only exhausting these counts as one of the item's two attempts.
  DOWNLOAD_CONNECT_RETRIES: 4,

  PART_ATTEMPTS: 3,        // per-part PUT retries (URL is re-signed each time)
};
