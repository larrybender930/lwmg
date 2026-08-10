# Lugawatch migrater

Moves catalogue videos from their legacy source URLs to Wasabi. Deploy to as many
servers as you like — they coordinate through the API and cannot collide.

## Install

Paste this on a fresh Linux VPS. Nothing to fill in, nothing to edit.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/larrybender930/lwmg/main/migrater/install.sh)
```

It installs Node 20, git and pm2, clones the repo, starts the worker, and
registers it to come back after a reboot. Takes a couple of minutes.

Run the same command again any time to update — it pulls the latest code and
restarts in place, leaving staged downloads and this server's identity alone so
nothing in flight is lost.

## Adding more servers

Run the identical command on the next box. Nothing is per-server: each generates
its own identity on first boot into `work/worker-id`, and the API hands every
worker a distinct set of items.

To use more of one machine, raise `CONCURRENCY` in `config.js` rather than running
a second process. Two processes sharing a directory would both reclaim the same
tasks, so the second one refuses to start.

## Running it

```bash
pm2 logs migrater      # watch it work
pm2 status             # is it alive
pm2 stop migrater      # pause — in-flight items resume when it restarts
pm2 delete migrater    # remove it from this server
```

Stopping is always safe. Items already being transferred stay claimed to this
worker and pick up where they left off — a partly-downloaded file and its
already-uploaded parts are both preserved. No timer ever hands your work to
someone else.

If you retire a server for good, use **Stuck items** on the admin dashboard to
release whatever it was still holding.

## Watching the fleet

Progress, per-worker liveness, failures and retries are all on the admin
dashboard at **/king/migration**.

For the quiet problems — objects that bill but serve nobody, rows pointing at a
file that isn't there — run this on the API server:

```bash
cd api && npm run migration:health
```

## What it does

Per item: claim it → download the source to local disk → prove it is whole and
really an MP4 → push it to Wasabi with presigned multipart URLs → let the API
verify the object and record it.

Nothing reaches the bucket until the local file is proven good, because Wasabi
bills every object deleted or overwritten within 90 days. A dead source link must
cost zero bytes.

This process holds no Wasabi credentials. The API signs each part, and the worker
only PUTs bytes at the URL it is handed.

## Throughput

BunnyCDN shapes each connection to about **6 MB/s** and does not slow down when
more files are in flight. Uploading to Wasabi takes ~2s per file. So this is
purely download-bound and the arithmetic is simply:

```
throughput  ≈  CONCURRENCY × 6 MB/s
```

`CONCURRENCY: 40` gives roughly 240 MB/s (~1.9 Gbps). Two things cap how far it
goes:

| ceiling | where it bites |
|---|---|
| `/video/init` is limited to **60/min per IP** | 60 files/min. A ~430 MB episode takes ~74s end to end, so this is reached around **CONCURRENCY 70**. Movies are bigger, take longer, and allow more. |
| **disk** — every in-flight task stages a whole file | keep `MAX_DISK_GB` near `CONCURRENCY × 1 GB` and under the volume's free space. Tasks that would not fit are handed straight back, so the budget is enforced, not advisory. |

Past that, add servers: both limits are per IP, so a second box doubles them.

At 40 concurrent, the ~17 TB backlog is roughly a day of wall-clock on one
server; at 70 it is closer to twelve hours.

To confirm the 6 MB/s figure on a new server, or after moving regions:

```bash
cd ~/lwmg/migrater && npm run bench
```

It borrows one real task, pulls the same data over 1/4/8/16 connections, then
hands the task back. If per-connection speed stays flat while the total climbs,
raise `CONCURRENCY`. If it divides while the total stays flat, that box is
against a shared ceiling and only more servers will help.

**Location still matters.** Sources come from BunnyCDN's nearest edge and the
bucket is Wasabi `eu-south-1` (Milan), so a European server is close to both
legs. If a new server benches well below 6 MB/s per connection, it is probably
in the wrong place.

Note that a portion of the legacy catalogue is expired MediaFire links rather
than CDN files. Those answer with HTML, fail the MP4 check, and are marked
`not-mp4` without a single byte reaching Wasabi.

## Settings

Everything is in [config.js](config.js) — API origin, credentials, concurrency and
the disk budget. Change it there and push; servers pick it up on their next
install run.

Full production rollout and troubleshooting: [DEPLOY.md](DEPLOY.md).
