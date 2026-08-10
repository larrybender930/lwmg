# Going to production — Wasabi migration

Covers the API (v1.5.0), the webapp (v2.5.0) and the migrater fleet. Follow in
order: everything through step 4 is read-only, and step 8 moves exactly one file.

There is no staging for this, so the first item **is** the test. Do not skip step 8.

---

## 1. Verify the production Wasabi config — do this first

The single most expensive mistake available. `NODE_ENV` decides the key prefix, and
a wrong value silently files every object under `movies-test/` / `series-test/`
with no undo that isn't billed for 90 days.

On the production API server:

```bash
cd api && node -e "
require('dotenv').config();
const w = require('./src/services/wasabi');
console.log('NODE_ENV     :', process.env.NODE_ENV);
console.log('bucket       :', w.BUCKET);
console.log('isConfigured :', w.isConfigured());
console.log('sample key   :', require('./src/utils/mediaKeys').buildMovieKey(1, 'x'));
"
```

Required:

- [ ] `NODE_ENV` is exactly `production`
- [ ] bucket is `lean-content`
- [ ] `isConfigured` is `true` (otherwise every `/video/init` returns 503)
- [ ] sample key starts `movies/`, **not** `movies-test/`

## 2. Baseline the bucket

```bash
cd api && npm run wasabi:audit          # read-only
```

- [ ] record object count and GB per prefix — this is your before-picture
- [ ] **zero** pre-existing open multipart uploads (anything already open is
      unrelated to this work and is already costing money)
- [ ] `WASABI_CLEANUP_ENABLED` stays `false`; leave the orphan sweep in dry-run
      for the duration of the migration

## 3. Know the size of the job

```bash
cd api && node -e "
require('dotenv').config();
const { query, pool } = require('./src/config/db');
(async () => {
  const r = await query(\`
    SELECT (SELECT COUNT(*) FROM movies WHERE wasabi_key IS NULL
              AND playing_url IS NOT NULL AND playing_url <> '') AS movies_todo,
           (SELECT COUNT(*) FROM series s
              CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.episodes,'[]'::jsonb)) ep
             WHERE ep.value->>'wasabi_key' IS NULL
               AND COALESCE(ep.value->>'url', ep.value->>'playingurl') IS NOT NULL
               AND COALESCE(ep.value->>'pending','false') <> 'true') AS episodes_todo\`);
  console.log(r.rows[0]); await pool.end();
})();
"
```

- [ ] note the two numbers — that is exactly what will be moved, and roughly what
      it will cost in Wasabi storage
- [ ] the query returns in well under 30s (the pool-wide `statement_timeout`)

## 4. Check the migrater servers

- [ ] free disk ≥ `MAX_DISK_BYTES` plus headroom (default 100 GiB)
- [ ] Node 18+
- [ ] outbound access to the source CDNs (`*.b-cdn.net` and friends) and to
      `server.lugawatch.com`

---

## 5. Deploy the API

No new dependencies. The change is additive: one new table, three new indexes, one
new router mounted at `/king/migration`.

```bash
cd api
git pull
npm install                # nothing new, but keeps the lockfile honest
npm run db:migrate
pm2 reload <api-app-name>
```

⚠️ **`db:migrate` runs every file in its list, not just the new one.** If these
have not yet been applied in production they will execute now:

- `migration_upload_center.sql` — additive columns only (`transfer_attempts`,
  `bytes_uploaded`, `tmdb_id`). Harmless.
- `migration_referral_reward_backfill.sql` — **data-mutating**: it settles stuck
  referrals and grants 5 free movies each. Idempotent (it claims on
  `watch_time_completed = false`), but if it has not run in production yet, this
  is when it happens. Check whether you want that in the same release.

Then:

- [ ] `migration_tasks` and `uq_migration_tasks_slot` exist
- [ ] API restarted cleanly, no errors in logs
- [ ] `GET /king/migration/stats` returns 200 for an admin token and its numbers
      match step 3

## 6. Create the service account

**One account for the whole fleet** — worker identity comes from each server's
`work/worker-id`, not the login.

```bash
cd api && npm run create-uploader
```

- [ ] account created with role `uploader`
- [ ] it can log in and reach `/king/upload` (a 403 means the role is wrong)
- [ ] its credentials are the ones in `migrater/config.js`, and that is pushed

## 7. Deploy the webapp

No new dependencies.

```bash
cd webapp && git pull && npm install && npm run build
pm2 reload <webapp-app-name>
```

- [ ] **Migration** appears in the admin sidebar (admins only)
- [ ] `/king/migration` loads; Not started / Done match step 3
- [ ] the four status chips sum to the backlog

---

## 8. First item — one worker, one file

Do not skip this and do not scale before it passes.

Set `CONCURRENCY: 1` and `BATCH_SIZE: 1` in `config.js` and push, so this server
takes exactly one item. Then, on the VPS:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/larrybender930/lwmg/main/migrater/install.sh)
pm2 logs migrater
```

Watch one item all the way through and confirm each:

- [ ] `claimed 1 task(s)` then `downloaded <size>` — a `.part` appears in `work/`
      and grows, then disappears
- [ ] the source URL was fetched with its spaces encoded (many contain literal
      spaces — the most likely first-run failure)
- [ ] a `movie_upload_sessions` row appears only **after** the download completes
- [ ] `✅ movies/<id>/luga_movie_… (N.NN GB)` — note the `movies/` prefix
- [ ] `npm run wasabi:audit` shows **exactly one** new object and **zero** open
      multipart uploads
- [ ] **play the title on the site.** Wasabi wins over `playing_url` once
      `wasabi_key` is set, so this is the real end-user check
- [ ] the dashboard shows it under Done and the task row is gone

Then raise `CONCURRENCY` / `BATCH_SIZE` in `config.js`, push, and re-run the
install command on the server to pick it up.

## 9. Scale out

- [ ] add each server by pasting the same install command — it handles pm2 save
      and startup itself
- [ ] to use more of one machine raise `CONCURRENCY` in `config.js`, never run a
      second process (the work-dir lock will refuse it)
- [ ] after a few hundred items, `npm run wasabi:audit` again: object count must
      equal completed items exactly, with no orphaned multipart uploads. Drift
      means something is writing speculatively — stop and investigate

## 10. How to tell if something went off the rails

Most ways this can go wrong are quiet: nothing crashes, the dashboard still looks
busy, and the damage shows up on a viewer's screen or a Wasabi invoice weeks
later. One command answers the questions that catch those:

```bash
cd api && npm run migration:health      # read-only, safe any time
```

It prints progress, per-worker heartbeats, whether failures share one cause, and
then reconciles the bucket against the database. Run it after the first item,
after the first few hundred, and daily while the fleet is running. Its verdict
line is either `✅ Nothing off the rails.` or a numbered list of what to look at.

The four findings that matter, in order of how much they cost:

| Finding | What it means |
|---|---|
| **FOREIGN PREFIX** | A `wasabi_key` is filed under a prefix this environment does not manage — the API wrote it with the wrong `NODE_ENV`. **Stop the fleet.** This is the mistake step 1 exists to prevent, and every further item makes it more expensive. |
| **MISSING** | A row points at an object that is not in the bucket. Those titles will not play, and nothing else surfaces this — the row looks perfectly healthy in SQL. |
| **UNREFERENCED** | Objects in the bucket that nothing points at. They bill for storage and serve nobody. A steady count is fine (in-flight uploads are excluded); a growing one means writes are being abandoned. |
| **open multiparts with no live session** | Parts bill until aborted. The hourly cleanup cron should clear these; if the count climbs, it is not running. |

Live signals, without running anything:

- **`N consecutive failures — pausing Xs`** in a worker log is the canary for a
  systemic problem — the source CDN is down, or credentials are wrong. The worker
  is protecting the backlog by slowing down; find the cause before it resumes.
- **`Login cooldown` / `Login rate limited`** — bad credentials, or too many
  restarts. The worker keeps using its cached token if it still has one.
- **`disk budget full`** — raise `MAX_DISK_BYTES` or add disk.
- **An orange worker chip** on the dashboard — no heartbeat for 5+ minutes.
- **A climbing `pm2 list` restart counter** — a crash loop. `pm2 logs` will show
  the same startup banner repeating.

What healthy looks like: Done rising steadily, In progress equal to the sum of
every worker's `CONCURRENCY`, all worker chips green with heartbeats under a
minute, Failed growing slowly and only from genuinely dead links, and
`migration:health` reporting zero missing, zero unreferenced, zero foreign.

The one thing no counter can tell you is whether a migrated file actually plays.
Spot-check a few titles on the site early on — that is the only end-to-end check
of the whole chain.

### Acting on it, from `/king/migration`

- **Retry** — puts one failed item back in the pool with a clean slate.
- **Stuck items** — releases claims held by a worker that has gone silent. Use it
  only when that server is genuinely gone; it shows you exactly what it would
  release, and how long each has been quiet, before you commit. Releasing a claim
  a live worker still holds is the one way to make two servers transfer the same
  file.

---

## Stopping and rolling back

**Pause everything:** `pm2 stop migrater` on each server. In-flight items stay
claimed to that worker and resume when it restarts; nothing is lost and nothing
needs a human.

**Remove a server for good:** `pm2 delete migrater`, then use **Stuck items** on
the dashboard to release whatever it was holding.

**Roll back the code:** the change is additive — revert the API and webapp, and
the workers simply get 404s and idle. To remove it entirely:

```sql
DROP TABLE IF EXISTS migration_tasks;
DROP INDEX IF EXISTS idx_movies_needs_wasabi;
```

Content already migrated keeps its `wasabi_key` and keeps playing — `playing_url`
is never cleared, so nothing is stranded either way. Migration is not reversible
per item and does not need to be.

## Known limits

- `/king/upload` is rate-limited to 600 requests/minute **per IP**; each migrater
  server has its own, so this only matters if many share one NAT address.
- `/king/auth/login` allows 5 attempts per 15 minutes per IP, and 5 per username
  across the whole fleet. The token is cached in `work/token`, so each server logs
  in about once a week — but cold-starting ~20 servers at once may make a few wait
  and retry. Stagger them if you ever do that.
- The disk budget is a snapshot, so two tasks starting together can overshoot by
  up to one file each — bounded by `CONCURRENCY`.
