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
