# Performance review

Measured on the development laptop (Apple Silicon, 10 cores, 16 GB) with Postgres 18, **k6, the API and
Postgres all on the same machine** — so read these as *relative* results and sanity checks, not as capacity
planning for a VPS. Method and tools are in `scripts/loadtest/`.

## Dataset

`npm run loadtest:seed` builds a throwaway database (`*_bench` only — it refuses anything else): the full
national location data, plus **100,020 users, 90,020 player profiles, 116,975 sport entries, 60,000
requests, 171,128 applications, 48,697 ratings, 300,000 notifications and 200,000 sessions**. 30% of profiles
sit in 10 "hot" upazilas, because real platforms cluster in cities and that is where queries hurt.

## Query plans: before and after

`npm run loadtest:explain` runs `EXPLAIN (ANALYZE, BUFFERS)` on the hot queries. The player-search and matching
cases execute **the exact SQL the app builds**; the others are hand-written equivalents of the Prisma queries.

| Query | Before | After | What changed |
|---|---:|---:|---|
| Search — hot upazila, football GK + khep | **181.6 ms** | **7.2 ms** | location-first composite index |
| Search — hot upazila, page 2 (activity cursor) | 28.3 ms | 2.2 ms | same |
| Search — national, no filters | 11.5 ms | 0.9 ms | `id` added to the sort index (no sort step) |
| Search — cold upazila | 8.1 ms | 0.5 ms | |
| Search — district + min rating, by activity | 1.8 ms | 0.8 ms | |
| Rating-reminder job, candidate query | 137.5 ms | 5.6 ms | `(status, completedAt)` |
| Purge old notifications | 25.8 ms | 3.2 ms | `createdAt` index |
| Matching (push fan-out), hot district | 36.0 ms | 26.0 ms | left alone — background job, cost is the district's size |
| Feed, my requests/applications, inbox, reviews | < 2 ms | < 1 ms | already indexed |

**The problem that mattered:** for a busy upazila, the planner walked the *national* rating index and discarded
43,000 profiles to find 21 that matched. A composite index that **leads with the place and then follows the
sort order** (`upazilaId, avgRating DESC, ratingCount DESC, id`) lets it stay inside the upazila and stop early.
Each search index ends in `id` — the unique tie-breaker the keyset cursor uses — so no sort node is needed and
deep pages cost the same as the first. The migration is `…_search_indexes`; the four obsolete indexes were dropped.

Known and accepted: `purge refresh tokens` and `expire stale requests` still seq-scan a 200k / 60k-row table in
~1–4 ms (they run hourly/daily, in chunks). `location search` is a 4,500-row scan in 0.25 ms; add `pg_trgm` only
if the table grows by orders of magnitude.

## Load test (`scripts/loadtest/search.k6.js`)

Mixed traffic: 85% player search (six realistic filter shapes, a third of searchers go to page 2), 10% request
feed, 5% inbox. 20 signed-in users, **no think time** — every virtual user fires as fast as it can, so 100 VUs
here is far more pressure than 100 real people (who pause between taps). Rate limiting is off for the test
(it would answer 429 — which is the point of it).

| Setup | Peak VUs | Req/s | Search p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| 1 Node process | 50 | 573 | 48 ms | **184 ms** | 275 ms | 0 |
| 1 Node process | 100 (saturated) | 475 | 125 ms | 342 ms | 502 ms | 0 |
| 4 workers, Prisma default pool (21 connections each) | 100 | 687 | 19 ms | 516 ms | 969 ms | 0 |
| 4 workers, **`connection_limit=6` each** | 100 | **935** | 54 ms | **197 ms** | 288 ms | 0 |
| 4 workers, default pool, **`pm2 reload` fired mid-test** | 60 | 682 | 14 ms | 315 ms | 645 ms | **0** (51,345 requests) |

What these say:

* **One process, moderate load:** search p95 is 184 ms at 50 back-to-back users; the script's 250 ms p95 threshold
  only trips at saturation.
* **The connection pool matters more than the worker count.** Four workers each opening Prisma's default 21
  connections put 84 connections on a 10-core Postgres; the median improved but the tail got *worse* than a single
  process (p95 516 ms). Capping each worker at 6 connections fixed it: 935 req/s and p95 197 ms — nearly double the
  single process, with a tighter tail. That is why `.env.example` ships `connection_limit=5` and `DEPLOYMENT.md`
  says to budget total connections at roughly 2–3× the database's cores. Measure on your VPS and adjust.
* **`pm2 reload` under load drops nothing:** all four worker PIDs were replaced mid-test (checked before/after)
  and every one of 51,345 requests succeeded.
* Caveat: k6, Postgres and the workers share one laptop, so absolute numbers will differ on a VPS; the *shape*
  (indexes matter most, pool size next, then workers) is what to take away.

## Rate limits (what protects the server)

| Where | Limit | Key |
|---|---|---|
| Nginx (shared across workers) | 30 req/s per IP, 60 req/min on `/auth/` | IP |
| App, all routes | 1,500 / 15 min | IP (generous: carriers share IPs) |
| App, signed in | 1,200 reads + 300 writes / 15 min | **user** |
| `GET /players` (search) | 60 / min | user |
| `GET /requests` (feed) | 120 / min | user |
| `GET /locations/search` | 60 / min | IP |
| Login | 10 / 15 min | IP + email |
| Register | 30 / hour | IP |
| Phone code | 5 / hour per number, 40 / hour per IP, 60 s cooldown, 2,000 / day total | number, IP, global |
| Forgot / reset password | 5 / hour, 10 / 15 min | IP + email |
| Post a request / apply / rate / report | 20 / h, 60 / h, 60 / h, 20 / day | user |
| Image uploads | 30 / 15 min | user |

In-app counters are per worker (a budget is up to *workers ×* larger); Nginx's are exact.

## Reproduce

```bash
createdb playerhaat_bench && export DATABASE_URL=postgresql://localhost/playerhaat_bench
npx prisma migrate deploy && npm run db:seed && npm run loadtest:seed
npm run loadtest:explain before            # plans → scripts/loadtest/plans-before.txt
npm run build && NODE_ENV=test PORT=4020 LOG_LEVEL=silent node dist/server.js &
BASE_URL=http://localhost:4020/api/v1 k6 run scripts/loadtest/search.k6.js
```

## Data retention (what is deleted automatically)
The daily job `purge-expired-data` keeps the tables that grow with traffic small. Nothing here needs a user setting.

| Table | Kept for |
|---|---|
| Notification (alerts inbox) | read: 30 days; unread: 90 days; never more than the newest 300 per person. People can also delete or clear alerts themselves |
| PushJob (push log) | 30 days after it finished |
| TelemetryEvent (crash and usage) | 90 days |
| RefreshToken | 7 days after expiry |
| VerificationCode | 2 days after expiry or use |
| ProfileView ("who viewed me") | 180 days |

Kept on purpose: chat messages, ratings, games, payments and the admin audit log (they are records, not logs). If chat grows large, archive by game age later.

## Indexes
Every foreign key that is filtered, joined or cascaded on has an index (audited 13 Nov 2026, migration `20261113220000_indexes_and_retention`). Re-check with the query in that audit when adding a relation: a foreign key with no index makes deleting the parent row (a user, a team) scan the child table.
