# PlayerHaat API

REST API for **PlayerHaat** — a Bangladesh-wide platform (village to city) where local players build profiles,
captains post "player needed" requests, players (including paid *khep* players) apply, and both sides rate each
other after the match. Football and cricket first; the first client is a Flutter app (`../app`).

Node 22 · TypeScript (strict) · Express 5 · PostgreSQL · Prisma 6 · Zod → OpenAPI · Cloudinary · FCM · pino

## Quick start

```bash
cp .env.example .env
npm install
npm run db:up                  # Postgres 17 in Docker on :5442  (or point DATABASE_URL at any Postgres)
npx prisma migrate deploy
npm run db:seed                # 8 divisions, 64 districts, 494 upazilas, 4,537 unions, sports, config
npm run db:seed:demo           # optional: demo users/requests around Kuakata (password: Demo1234)
npm run dev                    # http://localhost:4000   ·   Swagger UI at /docs
```

In development nothing external is required: emails and SMS codes are **logged** instead of sent, push is skipped,
and image upload answers `503 STORAGE_NOT_CONFIGURED` until you add Cloudinary keys.

| Script | What it does |
|---|---|
| `npm run dev` | watch mode (tsx) |
| `npm run build` / `npm start` | compile to `dist/` / run it |
| `npm test` | 467 tests against a real Postgres (see below) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:seed` / `db:seed:demo` | reference data / demo data (demo refuses to run in production) |
| `npm run admin:grant -- you@x.com` | make a user an admin (`--revoke` to undo) |
| `npm run docs:errors` | regenerate `docs/ERROR_CODES.md` |
| `npm run loadtest:seed` / `loadtest:explain` | bulk data + query-plan review (see `docs/PERFORMANCE.md`) |

## Testing

Tests hit a **real PostgreSQL** (no mocks for the database) because the interesting behaviour — row locks,
unique constraints, keyset pagination, advisory locks — lives there. External services (mail, SMS, FCM,
Cloudinary, Google/Apple token checks) are replaced with in-memory fakes.

```bash
docker compose --profile test up -d db-test                 # throwaway DB on :5443 (tmpfs)
npm test
# or any local Postgres — the name MUST end in _test (tests truncate tables; a guard enforces it):
TEST_DATABASE_URL=postgresql://localhost/playerhaat_test npm test
```

Concurrency is tested for real (six simultaneous accepts for three spots, simultaneous ratings, double refresh,
racing first sign-ins), and the important tests were checked by temporarily breaking the code they guard.

## What's in the box

```
src/modules/   auth · users · players · requests · applications · ratings · notifications ·
               media · reports · locations · sports · app-config · admin · maintenance
src/lib/       prisma, logger, jwt, password (argon2id), storage (Cloudinary behind an interface),
               push (FCM), sms (HTTP gateway), mailer, openapi, pagination
src/middlewares/  auth, validate (Zod), rate-limit, upload (multer + magic-byte check), error-handler
prisma/        schema.prisma · migrations/ · seed/ (full Bangladesh location data included)
deploy/        nginx config · well-known (deep-link) templates · backup script     ecosystem.config.cjs  (PM2)
docs/          DEPLOYMENT.md · PERFORMANCE.md · ERROR_CODES.md (generated)
scripts/       loadtest/ (k6 + EXPLAIN harness) · gen-error-docs
```

Each module has `*.routes.ts` (wiring + rate limits), `*.service.ts` (business rules), `*.schema.ts` (Zod
validation **and** its OpenAPI docs — one source of truth). Controllers stay thin.

## API

Base path `/api/v1`. Interactive docs: `GET /docs` (Swagger UI) and `GET /openapi.json` — **off in production**
unless `DOCS_ENABLED=true`. 70+ endpoints; the groups:

| Group | Highlights |
|---|---|
| **auth** | email + password · **phone OTP** · Google · Apple · refresh rotation · logout / logout-all · forgot/reset · link/unlink methods · delete account |
| **users** | `GET/PATCH /users/me` (includes `role` and the next `onboardingStep`), avatar upload, delete |
| **recruiters** | recruiter onboarding profile (`/recruiters/me`), public recruiter card, ask for verification |
| **contact** | `POST /players/:id/contact` shows a number in one tap (the player chooses *anyone* or *only people I accept*); `GET /players/me/contact-views` is who looked |
| **invites** | recruiter invites a player (optionally to an event); accepting shares both numbers and opens chat |
| **shortlist** | a recruiter's private saved players, with notes; `shortlisted` on every search card |
| **events** | recruiters launch events (`kind: EVENT`); players tap *interested* (an application without the form); count + faces on the event; owners can **boost** (paid) and `/requests/featured` lists running boosts |
| **chat** | recruiter ⇄ player over REST (poll while open, push otherwise); respects the contact setting; player can block; reportable |
| **teams** | create, join by code, captain tools; posts can be made for a team |
| **verification** | recruiters and player *stats* can be verified by an admin from links / document photos |
| **billing** | credits, packs, pay by bKash / Nagad / Rocket and submit the transaction id (admin confirms); manual payment only |
| **players** | create/update my profile, **sport profiles** (one per sport: positions, experience, headline, stats, achievements, own visibility and rating, khep, availability), photos + video links, public profile, **search** (cursor-paginated; says which sport profile matched) |
| **requests** | create, edit, cancel, fill, complete, nearby feed, mine |
| **applications** | apply, withdraw, applicants, accept/reject (atomic fill), mine |
| **ratings** | two-way, 7-day window, no-show strikes, pending list, public reviews |
| **notifications** | register FCM token, inbox, mark read |
| **reports / admin** | report content; admin: users + role changes, player/recruiter directories, suspend, hide profile / sport profile / request, verified badges, report queue, platform stats, audit log, app config |
| **reference** | `/locations/*` (division → union, bn/en search), `/sports` (positions + the stat fields each sport accepts, with bn/en labels), `/recruiter-types` (codes + bn/en labels), `/app-config` (flags + min version) |

### Roles & access control

| Role | Where | Can |
|---|---|---|
| `PLAYER` | mobile app | own a player profile with one **sport profile per sport**, apply to requests, search/view players, post requests, rate |
| `RECRUITER` | mobile app | finish recruiter onboarding (`/recruiters/me`), then search/view players, post requests, rate. Cannot create or edit player profiles, or apply |
| `ADMIN` | dashboard only (`/api/v1/admin/*`, UI in `../web/admin`) | everything under `/admin`; **refused (403) on every mobile endpoint** |

* Chosen once at sign-up (`role: PLAYER \| RECRUITER` on register / Google / Apple / phone verify; default `PLAYER`, applies to new accounts only). `ADMIN` is not accepted there. Admins are made with `npm run admin:grant` (shell access) and can't be created, changed or removed through the API.
* The role is read from the database on every request, never trusted from the token. Mobile routers are mounted behind `requireAppUser` in `src/routes.ts`, so a new router is closed to admins by default; stricter guards (`requirePlayer`, `requireRecruiter`) sit on the routes that need them.
* Admin accounts can't use `/auth/login`, Google/Apple or phone sign-in (403 `AUTH_ADMIN_DASHBOARD_ONLY`); the dashboard signs in at `POST /admin/auth/login` (email + password, throttled, identical 401 for non-admins) and then uses `/auth/refresh`.
* Recruiters must complete their profile before `GET /players` / `GET /players/:id` (403 `RECRUITER_PROFILE_REQUIRED`).
* A **sport profile** is a `PlayerSport` row: unique per (player, sport), with its own positions, skill, experience, headline, current team, per-sport stats (shape validated per sport in `src/modules/players/sport-stats.ts`; self-declared, not verified), achievements (max 20), visibility switch, admin-hide flag and rating earned in that sport's matches. Adding a sport is a seed row, plus an optional stats entry. The app builds each sport's stats form from `GET /sports` → `statFields` and takes recruiter types from `GET /recruiter-types`, both with bn/en labels, so new sports, stats and recruiter types need no app release (a test fails if a stat has no label; a missing recruiter-type label is a compile error).
* Search known limits: the name filter `q` is an unindexed `ILIKE` (add `pg_trgm` if it gets hot); stats aren't filterable; player-to-player search still works for `PLAYER` accounts (captains use it).

### Money: contact, boost and credits

Everything is free until an admin turns it on in app config. Then: `contact_credits_enabled` + `contact_free_per_day` + `contact_credit_cost` price *opening a number* (free allowance first, re-opening is free, people the player accepted are always free); `boost_enabled` + `boost_credit_cost` + `boost_hours` price boosting a request. Credits live in an append-only ledger (`CreditTransaction`) whose sum is `User.creditBalance` (never negative, even under concurrent spends). Top-ups are mobile-banking payments an admin verifies in `GET /admin/payments`; each transaction id can buy credits once. See `docs/DEPLOYMENT.md` for the payment numbers and the domains.

### Conventions

* **Envelope.** Success `{ "data": …, "meta": { nextCursor, limit, … } }`; failure
  `{ "error": { "code", "message", "details" } }`. Clients translate `code` ([`docs/ERROR_CODES.md`](docs/ERROR_CODES.md),
  96 codes, generated from the source and checked by a test) — `message` is for developers.
* **Auth.** `Authorization: Bearer <access JWT>` (15 min). Refresh tokens are opaque, single-use and rotated;
  replaying a used one revokes the whole session family. **Clients must serialize refreshes** (two parallel
  refreshes look like a replay and log the user out). Suspensions and role changes apply immediately — the
  status/role are re-read on every request.
* **Money** is whole BDT. **Times** are UTC ISO-8601; the app shows Asia/Dhaka.
* **Phones** are E.164 (`+8801XXXXXXXXX`); `017…`, `8801…`, `+880 17…` are all accepted on input.
* **Pagination** is cursor-based: pass `meta.nextCursor` back as `?cursor=`. `null` means last page. Cursors are
  opaque and tied to their sort order.
* **IDs of people are never exposed** to other users — profiles and requests have their own ids, and user ids
  appear only in admin responses. Phone numbers are revealed to each other only after an application is accepted.
* **Idempotency.** Accepting/rejecting/withdrawing twice is a no-op, not an error; reapplying after a withdrawal
  revives the same application.

## Security notes

* Passwords: argon2id (OWASP parameters). OTP and verification codes are HMAC'd, expire, lock after 5 wrong tries.
* Login answers identically for wrong password and unknown email; forgot-password never reveals which emails exist.
* A password planted on an unverified email is wiped when the real owner signs in with Google/Apple (pre-hijack defence).
* Uploads: 5 MB cap, magic-byte sniffing (the declared type is not trusted), stored under the uploader's own folder;
  ownership is checked from the public id, never from a client-sent URL.
* Strict request bodies: unknown fields are a 422, so nobody can PATCH their own `role`, `verifiedBadge` or rating.
* Rate limits per route, keyed by **user** when signed in (carrier-grade NAT means many phones share one IP), plus
  Nginx limits at the edge. Phone OTP has a global daily ceiling against SMS-pumping fraud. Table in `docs/PERFORMANCE.md`.
* Production refuses to boot with a bad config (example JWT secret, no SMTP, no CORS origins, rate limiting off).
* `npm audit --omit=dev` reports three *high* findings, all in the Prisma **CLI**'s dependency chain
  (`deepmerge-ts`, a stack-exhaustion advisory) — build-time tooling that never sees request data; the fix is
  Prisma 7, a major upgrade planned separately.

## Operations

* **Deploy:** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Ubuntu + PM2 + Nginx + Let's Encrypt, backups, checklist.
* **Performance:** [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — dataset, query plans before/after, load-test results.
* **Background jobs** (in-process, worker 0 only): rating reminders (every 15 min), expiring stale requests (hourly),
  purging expired tokens/codes/old notifications (daily), sweeping orphaned uploads (daily).
* **Health:** `/health` (liveness) and `/health/ready` (checks the DB).
* **Moderation:** every admin action is written to an append-only audit table in the same transaction as the change.

## Known limits / not built

* Teams (`teamId` on requests) have a data model but no endpoints yet.
* An admin can't void an individual rating/no-show strike (they can suspend, hide and resolve reports).
* Phone numbers added via `PATCH /users/me` are unverified; verified numbers come from OTP sign-in/linking.
* Rate-limit counters are per worker; Nginx's are exact (see `docs/DEPLOYMENT.md`).
* Real Cloudinary, FCM, SMS-gateway, Google and Apple integrations are exercised only through fakes in tests —
  smoke-test each with real credentials before launch.
