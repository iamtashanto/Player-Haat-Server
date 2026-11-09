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
- [x] Server: `joinMode` (APPROVAL | OPEN_JOIN) on matches, instant accept under the request row lock, leave = existing withdraw (re-opens a FILLED game). Per-game group chat `/games/:id/chat…` (organiser + accepted players, read-only 7 days after the game or on cancel), `/games/chats`. Attendance `PUT /games/:id/attendance` (organiser, after start, 14-day window). Reliability (`gamesPlayed`, `noShows`, `attendanceRate`, rating) on every player card/profile/applicant/shortlist item. Tests: `tests/games.test.ts`.
- [x] Clients: web (`src/lib/api/play.ts`, `components/app/play.tsx`, `reliability.tsx`, `views/game-chat.tsx`, e2e `e2e/play.spec.ts` desktop+mobile pass), app (`lib/features/play/*`, `test/features/play_flows_test.dart`), admin dashboard tiles (`summary.play`). Game-chat unread counts and push for game messages belong to Step 4.
- Step 2 DONE. Next: Step 3 media completion.
- Test DB note: Docker was down, so run tests with `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/playerhaat_test?schema=public` (local Postgres, db name must end `_test`).

## Commands cheat-sheet (this machine)
- API for e2e: `cd server && RATE_LIMIT_ENABLED=false npx tsx src/server.ts` (dev DB `playerhaat`); web: `pnpm build && pnpm exec next start -p 3000`; e2e needs `E2E_DATABASE_URL=postgresql://<user>@localhost:5432/playerhaat`.
- Server tests: `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/playerhaat_test?schema=public npx vitest run` (Docker was down).
- Regenerate web API types: build the OpenAPI doc with `buildOpenApiDocument()` (after importing `createApp`), write to `web/src/lib/api/openapi.json`, then `pnpm exec openapi-typescript src/lib/api/openapi.json -o src/lib/api/schema.d.ts`.
- SQL in e2e that sets a timestamp must use `now() at time zone 'utc'` (columns are zone-less UTC).

## Step 3 — media completion (in progress)
- [x] Server: cover photo (`PUT/DELETE /players/me/media/cover`, kind `player-cover`), gallery max 12 photos with captions (`PATCH /players/me/media/:id`) and reorder (photos only), YouTube videos stored by id with `source` enum (YOUTUBE | UPLOAD → 400 `UPLOAD_NOT_AVAILABLE`), max 6 per sports profile, non-YouTube links rejected. EXIF/XMP/comments stripped from every JPEG/PNG/WebP upload (`src/lib/image-meta.ts`; HEIC is accepted but cannot be rewritten, so clients convert to JPEG). URLs are built from the stored path at read time (`imageUrl`, `/img/<transform>/<path>`; thumbnails `w_400`). Account deletion removes avatar, cover and gallery files. Per-user upload limiter already keyed by user (30 / 15 min).
- [x] Migration `20261109120000`: columns + converts existing video links to YouTube ids on the player's first sports profile; non-YouTube / no-sport rows are dropped and counted via `RAISE NOTICE` (dev DB: 31 migrated, 0 dropped).
- [x] `scripts/migrate-cloudinary-media.ts [--dry-run]` (module `src/lib/storage/migrate-legacy.ts`): downloads from the old URL, strips metadata, uploads to the media service, rewrites avatar / gallery / team logo / verification evidence references, deletes the old copy; safe twice (new paths end in an extension, old ids never do). Dev DB dry-run: 0 legacy rows.
- [x] Admin API: `DELETE /admin/users/:id/{media/:mediaId,avatar,cover}` (reason required, `MEDIA_REMOVE` audited, file deleted — also fixed the old sport-profile media removal that left the file in storage), `GET /admin/media/usage` (proxied; key never leaves the server), user detail now carries `coverUrl` + presented media.
- [ ] Clients: web (cover, gallery grid + lightbox + drag/drop, YouTube cards, next/image loader, OG image), app (crop/compress/progress, gallery, YouTube cards, `/img/` transforms), admin (user detail: avatar/cover/gallery + remove, usage tile).
