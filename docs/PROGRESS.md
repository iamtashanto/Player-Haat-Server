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
