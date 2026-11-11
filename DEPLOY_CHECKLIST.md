# Deploy checklist: release/v1

Do these **in order**. Every command is run from `server/` unless it says otherwise. Nothing here is destructive except step 9 (it deletes the public copies of verification documents *after* they are safely stored privately).

## 0. Before you start
- [ ] Back up the database (`scripts/backup.sh` or `pg_dump`). The migrations only add; the video-link migration also deletes non-YouTube links (see step 4).
- [ ] Note the current media usage: `GET /admin/media/usage` (or `curl -H "Authorization: Bearer $MEDIA_API_KEY" $MEDIA_BASE_URL/api/v1/usage`).

## 1. Server environment (`server/.env`)
| variable | value | notes |
|---|---|---|
| `MEDIA_BASE_URL` | `https://media.tashanto.com` | |
| `MEDIA_API_KEY` | the secret key | **server only.** Never in the app, web, admin, logs, tests or git |
| `EVIDENCE_ENCRYPTION_KEY` | `openssl rand -base64 32` | **required for verification uploads.** Back it up in a password manager. Losing or changing it makes every stored document unreadable |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `npm run vapid:generate` | website push. Generate once; never rotate casually (all subscriptions would stop) |
| `VAPID_SUBJECT` | `mailto:you@yourdomain` | |
| `FIREBASE_SERVICE_ACCOUNT` | path to the JSON (chmod 600) | push to the **Android app** only (FCM). The website no longer uses Firebase |
| `STORAGE_PROVIDER` | leave empty | defaults to the media service when `MEDIA_API_KEY` is set; `cloudinary` only as a fallback |
| existing | `DATABASE_URL`, `JWT_ACCESS_SECRET`, `CORS_ORIGINS`, `ADMIN_TOTP_KEY`, … | unchanged. Remove `WEB_APP_URL` if you set it earlier: it no longer exists |

## 2. Web environment (`web/.env`)
- [ ] `NEXT_PUBLIC_MEDIA_URL=https://media.tashanto.com`
- [ ] Remove every `NEXT_PUBLIC_FIREBASE_*` variable (web push no longer needs any config; the public key comes from the API).

## 3. Install and build
```bash
cd server && npm ci && npx prisma generate && npm run build
cd ../web && pnpm install --frozen-lockfile && pnpm build     # firebase is gone from the lockfile
cd ../admin && pnpm install --frozen-lockfile && pnpm build
```

## 4. Migrations (one command applies all, in this order)
```bash
npx prisma migrate deploy
```
| # | migration | what it does |
|---|---|---|
| 1 | `20261109100000_player_availability` | "free today" per sport |
| 2 | `20261109110000_open_join_attendance_game_chat` | open join, attendance, per-game chat |
| 3 | `20261109120000_media_cover_gallery_youtube` | cover, gallery captions, YouTube-id videos. **Converts existing video links** to YouTube ids on the player's first sport; links that aren't YouTube (or players with no sport) are **deleted**. The count is printed as a `NOTICE` in the migration log: write it down |
| 4 | `20261109130000_admin_media_remove` | audit action `MEDIA_REMOVE` |
| 5 | `20261109140000_notifications_v2` | preferences, push queue and log, announcements, new types |
| 6 | `20261111100000_web_push_vapid` | browser push subscriptions; **deletes old `DeviceToken` rows with platform WEB** (they were FCM web tokens) |
| 7 | `20261111110000_private_evidence_media_assets` | `MediaAsset`, `VerificationFile`, audit action `VERIFICATION_FILE_VIEW` |
| 8 | `20261111120000_recruiter_logo_profile_views` | recruiter logo, profile views, `profileViewed` preference |

## 5. Seed
```bash
npx prisma db seed        # locations (610 upazilas, 4,537 unions), district coordinates, the boundary files, sports; idempotent
```
- [ ] Boundary data is read from `prisma/seed/data/boundaries/` (OCHA/HDX COD-AB, CC BY-IGO). Keep the attribution on the web About page and in `docs/BOUNDARY_DATA.md`.

## 6. Media backfill (facts for images uploaded before they were recorded)
```bash
npx tsx scripts/backfill-media-assets.ts --dry-run     # read the counts
npx tsx scripts/backfill-media-assets.ts
```
Safe to run twice. Fills media id, mime, size, width, height so screens can reserve image space.

## 7. Only if production still has Cloudinary images
```bash
npx tsx scripts/migrate-cloudinary-media.ts --dry-run
npx tsx scripts/migrate-cloudinary-media.ts            # needs MEDIA_* and CLOUDINARY_*; safe twice
```
Then run step 6 again.

## 8. Start the new API (pm2 reload, zero downtime) and check
```bash
pm2 reload playerhaat-api
curl -s https://<api>/health                     # {"status":"ok"}
PARITY_PLAYER=… PARITY_REC=… node scripts/audit-smoke.mjs https://<api>   # optional: no 5xx, nothing open to the wrong caller
```
Background jobs start by themselves (`JOBS_ENABLED`): push queue (20 s), game reminders (5 min), availability sweep, rating reminders, orphan sweeps (also removes documents nobody attached after a day), purge.

## 9. Move existing verification documents to private storage (SECURITY: do this soon after the deploy)
```bash
npx tsx scripts/migrate-evidence-private.ts --dry-run
npx tsx scripts/migrate-evidence-private.ts      # needs MEDIA_*, EVIDENCE_ENCRYPTION_KEY
```
It downloads each old public document, encrypts it into `verification/<userId>/`, records it, **deletes the public copy**, and clears the old list. Safe twice. Afterwards: any `PUBLIC COPY NOT DELETED` line must be handled by hand (the private copy is already safe).
Until it runs, old documents stay at their old public URLs.

## 10. Web, admin, app
- [ ] Deploy `web` (`pnpm start` behind your proxy) and `admin` (static build).
- [ ] Web push: the first visitor to opt in registers `/sw.js`; no other setup.
- [ ] Android app: build from `app` `release/v1`. Android notification channels (games, messages, recruitment, system) are created on first launch. iOS was not covered in this release.

## 11. After the deploy
- [ ] Admin → Dashboard: media usage tile shows the service; Announcements shows the push queue.
- [ ] Open one verification request as an admin: the document opens (this writes a `VERIFICATION_FILE_VIEW` audit row).
- [ ] No test accounts in production: `npx tsx scripts/cleanup-e2e-data.ts --dry-run` should report 0 users.

## Rollback notes
- Migrations are additive; the code can be rolled back without undoing them, except that rolled-back code won't understand `fileIds` verification uploads or YouTube-id videos.
- Do **not** delete `EVIDENCE_ENCRYPTION_KEY` or the VAPID keys on rollback.
