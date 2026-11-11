# Progress (no-demo-data-production-ready)

Done (committed on release/v1 in all repos): phone-OTP flag + /app-config methods + add-email; client phone hiding (web/app);
Step 1 audit (docs/DEMO_DATA_AUDIT.md); Step 3 seed split, seed-dev, admin:create, cleanup-demo-and-e2e, prod boot guard + test;
gallery/localhost prod gating; admin dashboard date range.

Next: Step 4b ratings (reveal, fair averages, single no-show source, disputes, reply, admin) — server first with tests,
then app/web/admin UI; Step 4 functional verification; Step 5 hardening (builds, leak greps, DEPLOY_CHECKLIST, RELEASE_NOTES).
Then prompts/web-desktop-premium-and-gaps.md.

Test env: export TEST_DATABASE_URL="postgresql://ta-shanto@localhost:5432/playerhaat_test?schema=public"; npx vitest run
