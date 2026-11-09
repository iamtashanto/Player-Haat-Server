# Progress on `continue-audit-build` (branch `feat/audit-media-location-notify`)

Updated after the last commit below. Pick up from **Next**.

## Done (server, all tests green: typecheck + vitest)
- **Media provider:** `src/lib/storage/tashanto.ts` (default when `MEDIA_API_KEY` is set), 7 tests, verified live (upload/serve/delete).
- **Audit:** `docs/SYSTEM_AUDIT.md`, `scripts/audit-smoke.mjs`.
- **Location (step 1, server part complete):**
  - `scripts/build-boundaries.ts` + `prisma/seed/data/boundaries/` (OCHA/HDX COD-AB, CC BY-IGO; licence + attribution in `docs/BOUNDARY_DATA.md`). 64/64 districts, 495/610 upazilas matched (115 left = city-corporation thanas + 10 newer upazilas, listed in `match-report.json`; unions have no boundary data → manual pick).
  - `src/modules/locations/boundaries.ts` (in-memory bbox index + ray casting, 2 km border tolerance); PostGIS is not installed in our docker/local Postgres, so it is not used.
  - `GET /locations/nearest?lat&lng` returns the **containing** division › district › upazila (+ `precision`, `nearBorder`); 404 outside Bangladesh. Kalapara point → Patuakhali › Kalapara (tests with real data for 8 cities and district borders).
  - `sort=near` for `GET /players` (+ `nearDistrictId/nearUpazilaId/nearUnionId`, keyset cursor) and for `GET /requests` (offset cursor over a 300-row window). Area ids only, no coordinates.
  - `src/lib/geo.ts` (`haversineKm`, `roundCoarse` ≈ 1 km).
  - `/api/v1/health` served too.
- Dev DB `playerhaat` re-seeded (610 upazilas, 4,537 unions, district lat/lng).

## Next (in order)
1. **Step 1, clients:** web (Geolocation API → `/locations/nearest` → pre-fill the picker's division/district/upazila, user confirms union) in profile setup, create request, players search ("Near me" chip → `sort=near`); app (`geolocator`, bn/en permission strings, same flow). Store area ids; store a `roundCoarse` coordinate only after an explicit "near me" opt-in (a column on `PlayerProfile` is still to be added, with a migration). Add the CC BY-IGO attribution to the web About page. e2e with mocked geolocation (Playwright `context.setGeolocation` + `permissions`).
2. **Step 2, casual play:** see the plan in `SYSTEM_AUDIT.md` (availability status per sport with window + expiry job, nearby-available query, open games join-without-approval flag, per-game group chat archived +7 days, attendance, reliability score), server → app → web → admin, a test per rule.
3. **Step 3, media completion** (cover, 12-photo gallery with caption/order, YouTube-id videos with `source` enum, Cloudinary → media-service migration script, EXIF strip, upload rate limit, delete on account deletion, app/web/admin UI, OG images).
4. **Step 4, notifications** (preferences + quiet hours, FCM app + web, service worker, DB-backed job queue with retry + send log, all triggers, targeted admin announcements + stats).
5. **Step 5, re-audit** (update `SYSTEM_AUDIT.md`, real Playwright pass mobile + desktop, open the admin UI, the e2e list in the brief).

## Commands
- Server checks: `cd server && pnpm exec tsc --noEmit && TEST_DATABASE_URL=postgresql://ta-shanto@localhost:5432/playerhaat_test?schema=public pnpm exec vitest run` (do not run two vitest processes at once: they share the test DB).
- Run the API for clients: `RATE_LIMIT_ENABLED=false DATABASE_URL=postgresql://ta-shanto@localhost:5432/playerhaat?schema=public npx tsx src/server.ts`.
- Web: branch `feat/web-parity-followups` has the parity work; do new web work on `feat/audit-media-location-notify` created from it. e2e: `E2E_DATABASE_URL=postgresql://ta-shanto@localhost/playerhaat pnpm test:e2e` (production build + `next start -p 3000`).
