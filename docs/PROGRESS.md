# Progress (no-demo-data-production-ready)

Done (committed on release/v1 in all repos): phone-OTP flag + /app-config methods + add-email; client phone hiding (web/app);
Step 1 audit (docs/DEMO_DATA_AUDIT.md); Step 3 seed split, seed-dev, admin:create, cleanup-demo-and-e2e, prod boot guard + test;
gallery/localhost prod gating; admin dashboard date range.

Next: Step 4b ratings (reveal, fair averages, single no-show source, disputes, reply, admin) — server first with tests,
then app/web/admin UI; Step 4 functional verification; Step 5 hardening (builds, leak greps, DEPLOY_CHECKLIST, RELEASE_NOTES).
Then prompts/web-desktop-premium-and-gaps.md.

Test env: export TEST_DATABASE_URL="postgresql://ta-shanto@localhost:5432/playerhaat_test?schema=public"; npx vitest run

## Update: Step 4b (ratings) done on server + web + app + admin
Server tests 814 pass (tests/ratings-v2.test.ts covers reveal, fairness, strikes, disputes, replies, admin).
Remaining: Step 4 (verify flows from empty DB, e2e), Step 5 (prod builds, leak grep, DEPLOY_CHECKLIST, RELEASE_NOTES per repo),
then prompts/web-desktop-premium-and-gaps.md. Not built (later idea): teammate ratings.
Reconcile: `pnpm ratings:reconcile -- --dry-run`.

## Status at end of this session
Done: phone-OTP off, audit, seed split + CLIs, prod guards, ratings v2 (server/web/app/admin), deploy checklist, release notes.
Web e2e (desktop+mobile, real API on :4000, web on :3000 built with NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1):
10 failed, 10 passed, 4 skipped. NOT yet diagnosed whether they pre-date this work. Known: journey.spec.ts:26 expects a
PlayerMedia type 'VIDEO_LINK' (media model changed to YouTube ids earlier), so that spec is stale. Others (events "featured until"/boost,
media profile-cover/media-manager, play attendance/available-today, notifications request/new, verification private-image on mobile) need a look.
Next: `cd web && pnpm exec playwright test e2e/journey.spec.ts --project=desktop` to iterate; fix specs/UI; add admin Playwright (1440x900);
Android emulator run with screenshots to app/test/screens/; then prompts/web-desktop-premium-and-gaps.md.
Dev servers: API `cd server && npm run dev` (log /tmp/api.log), web `cd web && pnpm exec next start -p 3000`.

## e2e diagnosis (this session)
The earlier "10 failed" were the harness, not the app or the specs: (1) `E2E_DATABASE_URL` was unset so `sql()` hit the wrong database
(`ph_web`), (2) a second run tripped the API's in-memory sign-up rate limiter (103 × 429, 18 on /auth/register). Fixes: helpers now
refuse to run without `E2E_DATABASE_URL`; teardown points at the renamed cleanup script; README says to start the API with
`RATE_LIMIT_ENABLED=false` for e2e; `pnpm test:e2e:local` reads the DB URL from server/.env.
New: web/e2e/ratings.spec.ts; admin/e2e (Playwright, 2FA enrolment with on-screen secret, every page, disputes queue).
Empty reference-only DB prepared: playerhaat_empty (0 users) for the from-empty walkthrough.
Gotcha: `pkill -f "tsx watch"` kills only the watcher; its child keeps port 4000 with the OLD env. Restart with
`lsof -nP -iTCP:4000 -sTCP:LISTEN -t | xargs kill` first, then `RATE_LIMIT_ENABLED=false npm run dev`, and verify with a burst of
POST /auth/register (expect 201s, not 429). Same for `next start` on :3000 (process name is `next-server`).

## Feature batch (user request: address search, logic checks, media, reviews, dashboards, then roadmap items)
DONE + committed (server+web, with tests/e2e): address type-to-search (server `/locations/search` multi-word + parents; web picker; app already had a search box and now gets the better results);
public reviews (anonymous, first name only), organiser reviews + rating on organiser card, `/public/top-players` (3+ revealed reviews) + web `/top`, honest "top" headings;
dashboards (`GET /dashboard`, web Home panel for player and organiser); profile photo e2e + desktop "Remove photo" bug fixed; achievements on public profile (web already had edit/show; roadmap H8 was a false positive).
QUEUE (in order): H1 first-party errors+analytics, H2 game share card, H3 PWA, H4 waitlist, H5 recurring games, H7 results/scores, cheap wins (ground-fee split, rain alert, .ics, data saver), competition set (team pages, challenges, leaderboards, tournaments).
APP PARITY still to do for: dashboard, reviews on organiser card, /top, share, waitlist, recurring, results, .ics (Flutter). App already has type-to-search address.
Servers: API `RATE_LIMIT_ENABLED=false ADMIN_REQUIRE_2FA=true npm run dev` (log /tmp/api.log), web `next start -p 3000` after `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1 pnpm build`.
