# Server: release/v1

**Casual play.** "Free today" per sport (expires at the window end or midnight Dhaka), nearby-available filter, open-join games (never over-fill, concurrency-tested), per-game group chat (read-only 7 days after), attendance marked by the organiser, reliability score on every player card.

**Location.** `GET /locations/nearest` returns the containing district and upazila from our own boundary polygons (OCHA/HDX COD-AB); no coordinates stored or logged. `sort=near` for players and games ranks by area ids.

**Media.** Our media service replaces Cloudinary (the key stays server-side). Cover photo, 12-photo gallery with captions and reorder, YouTube-id videos (6 per sport, `UPLOAD` reserved), EXIF/GPS stripped, renditions through `/img/`. Facts (media id, mime, size, width, height) stored for every upload (`MediaAsset`) and returned as `width`/`height`. Scripts: Cloudinary migration, media-facts backfill.

**Security: private verification documents.** The media service has no private mode (every file is publicly reachable), so documents are AES-256-GCM encrypted before upload and stored in `verification/<userId>/`. Only the owner (`GET /verification/files/:id`) and an admin (`GET /admin/verification/:id/files/:fileId`, audit-logged) can open them; no public URL exists anywhere. Script moves old public evidence into private storage and deletes the public copies.

**Notifications.** Preferences with quiet hours (23:00–07:00 Dhaka), a DB-backed push queue with retry/backoff and a send log, new triggers (someone near you is free, game reminders, game full, game chat, profile viewed), admin announcements with targeting and delivery stats. Website push is standard VAPID (`web-push`); the Android app keeps FCM.

**Small gaps.** Recruiter/organisation logo; profile views counted once per recruiter per day with "who viewed me" and a preference-gated notification.

**Fixes found in the audit.** Admin broadcast wrote columns that don't exist; division+district audience filters overrode each other; admin media removal left the file in storage; cover photos were swept as orphans after 24 h.

**Housekeeping.** `scripts/cleanup-e2e-data.ts` removes test accounts (`@e2e.test` only) with their files. 796 tests.

Breaking for old clients: verification submit takes `fileIds` (not `evidenceImages`), `POST /media/images` no longer accepts `verification-doc`, `POST /notifications/devices` no longer accepts `WEB`, video links need a `sportId` and must be YouTube. See `DEPLOY_CHECKLIST.md`.
