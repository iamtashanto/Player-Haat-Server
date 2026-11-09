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

- **Step 1 clients done:** web (`useDetectArea`, "Use my location" in the shared picker → profile setup / create request / edit profile; "Near me" chip in player search; About-page attribution; `e2e/location.spec.ts` with mocked geolocation, granted + denied) and app (`geolocator`, `lib/shared/place_picker/detect_area.dart`, button in the place picker, "Near me" chip in search, bn/en strings, coarse-location Android permission, iOS usage string). web + app branches: `feat/audit-media-location-notify`.
- **Not done in step 1:** opt-in storage of a coarse (~1 km) coordinate on the profile (needs a column + migration + a consent toggle); a "Near me" control for the open-games feed in the clients (server `sort=near` for `/requests` exists).

## Next (in order)
1. **Step 2, casual play** (in progress: check the git log for what landed): availability status + nearby-available, open-game join rules, per-game chat, attendance, reliability score, then app/web/admin and tests.
2. **Step 3, media completion**, 3. **Step 4, notifications**, 4. **Step 5, re-audit** (details in the brief and `SYSTEM_AUDIT.md`).

## Commands
- Server checks: `cd server && pnpm exec tsc --noEmit && TEST_DATABASE_URL=postgresql://ta-shanto@localhost:5432/playerhaat_test?schema=public pnpm exec vitest run` (never run two vitest processes at once: they share the test DB).
- API for clients: `RATE_LIMIT_ENABLED=false DATABASE_URL=postgresql://ta-shanto@localhost:5432/playerhaat?schema=public npx tsx src/server.ts`.
- web e2e: `E2E_DATABASE_URL=postgresql://ta-shanto@localhost/playerhaat pnpm test:e2e` (production build + `next start -p 3000`). app: `flutter analyze && flutter test`.


## Step 2 — casual play (in progress)
- [x] Availability ("আজ খেলবি") server: `PlayerAvailability` (migration `20261109100000`), `GET/PUT/DELETE /players/me/availability`, expires at window end or midnight Asia/Dhaka (`src/lib/dhaka-time.ts`), swept every 30 min, `availableToday` search filter + card flag. Tests: `tests/availability.test.ts`.
- [ ] Open-game join without approval, per-game chat, attendance, reliability score; then app/web/admin for all of it.
- Test DB note: Docker was down, so run tests with `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/playerhaat_test?schema=public` (local Postgres, db name must end `_test`).
