# Production deploy checklist (release/v1)

Run from `server/` unless stated. Order matters. Nothing here seeds demo data: production gets reference data and one admin, nothing else.
(`DEPLOY_CHECKLIST.md` in the server root has the earlier, detailed per-migration notes for the media/evidence/VAPID work.)

## 1. Environment
Server `.env` (production refuses to boot if a required one is wrong; run `node -e` import of `src/config/env.ts` or just start it):

| variable | production value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | managed Postgres URL |
| `JWT_ACCESS_SECRET` | 32+ random chars, not `change-me…` |
| `PUBLIC_API_URL` | public https API address. **Not localhost** (boot refuses) |
| `CORS_ORIGINS` | the web + admin origins, comma separated |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | real mail account (verification + password reset) |
| `ADMIN_TOTP_KEY` | 32+ random chars (encrypts admin 2FA secrets) |
| `EVIDENCE_ENCRYPTION_KEY` | `openssl rand -base64 32`; back it up, losing it makes private documents unreadable |
| `MEDIA_BASE_URL`, `MEDIA_API_KEY` | media service; the key is server-only |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `pnpm vapid:generate` once |
| `FIREBASE_SERVICE_ACCOUNT` | path to the JSON (Android push). Optional until Firebase is set up |
| `GOOGLE_CLIENT_IDS` | the Web client id (and Android/iOS ids) the server accepts for Google sign-in |
| `PAYMENT_BKASH_NUMBER`, `PAYMENT_NAGAD_NUMBER`, `PAYMENT_ROCKET_NUMBER` | the numbers customers send credits to |
| `AUTH_PHONE_OTP_ENABLED` | leave **unset/false**. Phone/SMS login is off; no SMS gateway variables are needed |
| must stay default | `RATE_LIMIT_ENABLED=true`, `ADMIN_REQUIRE_2FA` (true) |

Web `.env`: `NEXT_PUBLIC_API_URL=https://<api>/api/v1` (**required**: a production build throws without it), `NEXT_PUBLIC_MEDIA_URL`, Google web client id.
Admin build: `VITE_API_URL=https://<api>/api/v1` (or serve it behind the same origin as `/api/v1`). Do **not** build with a local `.env` that points at localhost.
Android: `app/env/prod.json` from `env/prod.example.json` with real URLs, `GOOGLE_SERVER_CLIENT_ID`, Firebase values, plus `android/key.properties` (upload keystore) and `google-services.json`.

## 2. Build
```bash
cd server && npm ci && npx prisma generate && npm run build
cd ../web   && pnpm install --frozen-lockfile && pnpm build
cd ../admin && pnpm install --frozen-lockfile && pnpm build
cd ../app   && flutter build appbundle --release --flavor prod --dart-define-from-file=env/prod.json
```

## 3. Migrations (one command, in this order)
```bash
npx prisma migrate deploy
```
`init` → `profile_admin_hide` → `notification_types` → `admin_audit_log` → `search_indexes` → `roles_recruiters_sport_profiles` → `contact_invites_verification_credits_chat_teams` → `manual_payments_admin_2fa` → `player_availability` → `open_join_attendance_game_chat` → `media_cover_gallery_youtube` (converts video links; non-YouTube links are deleted, the count is in the log) → `admin_media_remove` → `notifications_v2` → `web_push_vapid` → `private_evidence_media_assets` → `recruiter_logo_profile_views` → `ratings_reveal_disputes` (existing ratings are marked revealed) → `rating_admin_actions` → `bayes_default`.

## 4. Reference data (idempotent, safe to re-run; creates no users or content)
```bash
npx prisma db seed        # sports + positions (bn/en), divisions→unions with coordinates, app-config flags (ads/boost off, min_app_version), notification types
```

## 5. One-off scripts (only if upgrading an existing database)
```bash
npx tsx scripts/backfill-media-assets.ts          # image sizes for existing uploads
npx tsx scripts/migrate-evidence-private.ts       # moves verification documents to private storage, then deletes public copies
npm run ratings:reconcile -- --dry-run            # check, then run without --dry-run: aligns no-show strikes with attendance, recomputes every average
```

## 6. First administrator (no default admin exists)
```bash
pnpm admin:create --email you@yourdomain --password '<12+ characters>' --name "Your Name"
```
Sign in at the admin dashboard; the first sign-in forces authenticator (2FA) setup before a session is issued. Save the backup codes.

## 7. Start and verify
- [ ] Start the API; `/health` is `ok`. The in-process jobs run (reminders, rating reveal every 15 min).
- [ ] `GET /app-config` shows `auth.methods` with `phone: false`, `flags.ads_enabled=false`, `flags.boost_enabled=false`.
- [ ] Phone OTP routes answer 404 `AUTH_METHOD_DISABLED`.
- [ ] Sign up a real test account through the website, verify email, complete a profile.
- [ ] Private documents: anonymous request → 401, another user → 403, admin → 200.
- [ ] Web `/gallery` is a 404; the Android release build has no gallery route.
- [ ] Never run `pnpm db:seed:dev` or `pnpm cleanup:demo` against production (the seed refuses; cleanup needs `--allow-production`).
