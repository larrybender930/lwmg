/**
 * Where is the download bottleneck? Run this ON a migrater server.
 *
 *   node bench.js                 # claims one real task, benchmarks it, releases it
 *   node bench.js <url>           # benchmarks a specific URL
 *   MB=48 node bench.js           # pull more per configuration (default 24)
 *
 * It downloads the same amount of data over 1, 4, 8 and 16 connections and
 * compares. Reading the result:
 *
 *   per-connection MB/s stays FLAT while the total climbs
 *       -> the CDN is shaping each connection. More connections = more speed.
 *          Raise CONCURRENCY in config.js.
 *
 *   per-connection MB/s DIVIDES and the total stays flat
 *       -> you are against a shared ceiling: this server's link, the route to
 *          the CDN edge, or a per-IP cap at the CDN. More connections on THIS
 *          box will not help. More servers (different IPs) will.
 *
 * Downloads to nothing — no disk writes, no Wasabi, no database writes. It does
 * briefly claim one task so it has a real URL, then hands it straight back.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const config = require('./config');
const api = require('./api');
const state = require('./state');

const MB = 1024 * 1024;
const BUDGET = (Number(process.env.MB) || 24) * MB;
const LANES = [1, 4, 8, 16];
const fmt = (n) => n.toFixed(1);

function openRange(urlString, start, end, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get({
      protocol: url.protocol, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      headers: { 'User-Agent': 'lugawatch-migrater/1.0', Accept: '*/*', Range: `bytes=${start}-${end}` },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); req.destroy();
        return resolve(openRange(new URL(res.headers.location, url).toString(), start, end, hops + 1));
      }
      resolve({ req, res });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
  });
}

async function pull(url, start, end) {
  const t0 = process.hrtime.bigint();
  const { req, res } = await openRange(url, start, end);
  if (res.statusCode !== 206 && res.statusCode !== 200) {
    res.resume(); req.destroy();
    throw new Error(`HTTP ${res.statusCode}`);
  }
  let bytes = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => { bytes += chunk.length; });
    res.on('end', resolve);
    res.on('error', reject);
  });
  req.destroy();
  return { bytes, seconds: Number(process.hrtime.bigint() - t0) / 1e9 };
}

async function describeSource(url) {
  const { req, res } = await openRange(url, 0, 0);
  const size = Number(/\/(\d+)$/.exec(res.headers['content-range'] || '')?.[1]) || 0;
  const info = {
    status: res.statusCode,
    size,
    type: res.headers['content-type'] || '?',
    server: res.headers.server || '?',
    ranges: res.statusCode === 206,
  };
  res.resume(); req.destroy();
  return info;
}

async function main() {
  let url = process.argv[2];
  let claimed = null;
  let workerId = null;

  if (!url) {
    state.acquireLock();
    workerId = state.resolveWorkerId();
    await api.ensureAuth();
    const data = await api.requestOk('POST', '/king/migration/claim', { workerId, limit: 1 });
    claimed = data.tasks && data.tasks[0];
    if (!claimed) throw new Error('nothing left to claim — pass a URL instead: node bench.js <url>');
    url = claimed.sourceUrl;
    console.log(`\nborrowed task ${claimed.taskId}: ${claimed.title}`);
  }

  try {
    const info = await describeSource(url);
    console.log(`\nsource : ${url.slice(0, 100)}${url.length > 100 ? '…' : ''}`);
    console.log(`server : ${info.server}`);
    console.log(`type   : ${info.type}`);
    console.log(`size   : ${info.size ? fmt(info.size / MB) + ' MB' : 'unknown'}`);
    console.log(`ranges : ${info.ranges ? 'supported ✓' : 'NOT SUPPORTED — resume and this benchmark need them'}`);

    if (!info.ranges || !info.size) {
      console.log('\nCannot benchmark this source.');
      if (String(info.type).includes('html')) {
        console.log('It answered with HTML, which usually means the link has expired.');
      }
      return;
    }

    console.log(`\npulling ${fmt(BUDGET / MB)} MB per configuration\n`);
    console.log('lanes   total MB/s   per-connection MB/s   vs 1 lane');
    console.log('─────   ──────────   ───────────────────   ─────────');

    let baseline = null;
    for (const lanes of LANES) {
      const perLane = Math.floor(BUDGET / lanes);
      if (perLane < 1) continue;
      const stride = Math.floor(info.size / lanes);

      const t0 = process.hrtime.bigint();
      const results = await Promise.all(Array.from({ length: lanes }, (_, i) => {
        const start = Math.min(i * stride, Math.max(0, info.size - perLane - 1));
        return pull(url, start, start + perLane - 1).catch((error) => ({ error: error.message }));
      }));
      const wall = Number(process.hrtime.bigint() - t0) / 1e9;

      const ok = results.filter((r) => !r.error);
      if (!ok.length) { console.log(`${String(lanes).padStart(5)}   all lanes failed: ${results[0].error}`); continue; }

      const total = ok.reduce((a, r) => a + r.bytes, 0) / MB / wall;
      const per = ok.reduce((a, r) => a + r.bytes / MB / r.seconds, 0) / ok.length;
      if (baseline === null) baseline = total;

      console.log(
        `${String(lanes).padStart(5)}   ${fmt(total).padStart(10)}   ${fmt(per).padStart(19)}   ${fmt(total / baseline).padStart(8)}x` +
        (ok.length !== results.length ? `   (${results.length - ok.length} failed)` : '')
      );
    }

    console.log(`
If per-connection speed held steady while the total climbed, the CDN is shaping
each connection — raise CONCURRENCY in config.js and re-run.

If per-connection speed fell while the total stayed flat, this server is against
a shared ceiling. More connections here will not help; more servers will.
`);
  } finally {
    if (claimed) {
      await api.request('POST', `/king/migration/tasks/${claimed.taskId}/release`, { workerId })
        .then(() => console.log(`released task ${claimed.taskId}\n`))
        .catch((e) => console.log(`could not release task ${claimed.taskId}: ${e.message}\n`));
    }
  }
}

main().catch((error) => { console.error(`\nbench failed: ${error.message}\n`); process.exit(1); });
