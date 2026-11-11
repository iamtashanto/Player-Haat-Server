# Demo / fake data audit

Scope: server, app, web, admin (release/v1). Searched for sample/mock/fake/dummy/demo/placeholder/lorem data, stock-avatar
services, `|| [{…}]` fallbacks, `Math.random` content, catch blocks that fake success, hard-coded stats/charts, demo
flags, auth bypasses, localhost defaults and dev-only screens.

| File | Line | What | Action |
|---|---|---|---|
| `server/prisma/seed/demo.ts` | all | 5 demo users, requests (Kuakata) with password `Demo1234` | Moved out of `prisma db seed`; only run by `scripts/seed-dev.ts` (`pnpm db:seed:dev`). Users use the reserved `@demo.playerhaat.test` domain. |
| `server/prisma/seed/index.ts` | main | `--demo` flag inside the production seed path | Removed. `prisma db seed` is reference-only (sports, positions, locations, app-config flags). |
| `server/scripts/seed-dev.ts` | new | dev seed | Refuses when `NODE_ENV=production` or `DATABASE_URL` is not a local host. |
| `server/scripts/cleanup-e2e-data.ts` | – | only removed `@e2e.test` | Renamed `cleanup-demo-and-e2e.ts`; now removes demo and e2e users, their content and media; `--dry-run`. Run on the local DB (6 users, 2 requests removed). |
| `server/src/config/env.ts` | production refine | `PUBLIC_API_URL` defaulted to localhost in prod | Production now refuses to boot with a localhost `PUBLIC_API_URL` (test added). Other prod guards already refuse: example JWT secret, `ADMIN_REQUIRE_2FA=false`, `RATE_LIMIT_ENABLED=false`, missing SMTP/CORS. No OTP bypass or test-code flag exists. |
| `server/src/scripts/grant-admin.ts` | – | only promoted an existing user | Added `pnpm admin:create --email --password` (no default admin; 2FA is forced at first sign-in). |
| `server/src/lib/password.ts` | 22 | `dummyHash` | Not data: constant-time login helper. Keep. |
| `server/src/config/env.ts` | 76 | phone OTP login | `AUTH_PHONE_OTP_ENABLED` default false; routes return 404 `AUTH_METHOD_DISABLED`; no SMS env needed in production. |
| `web/src/app/[locale]/gallery/*` | – | component gallery | Already `notFound()` in production (layout). Footer link was visible in prod → now dev-only. |
| `app/lib/app/router.dart` | 110 | `/gallery` route registered in release | Registered only when `!kReleaseMode`. Settings row already `Env.isDev`. |
| `web/src/lib/api-client.ts`, `auth-cookies.ts` | 91/15 | `localhost:4000` fallback | Fallback is dev-only; a production build without `NEXT_PUBLIC_API_URL` throws. |
| `app/lib/core/env.dart` | 9 | default `http://localhost:4000` | Prod flavor throws unless `API_BASE_URL` is https and not localhost/10.0.2.2. Dev default stays. |
| `web/src/components/settings/settings-view.tsx` | 255 | hard-coded fake phone `+8801700000000` shown when a user had none | Removed; phone row shows only a real number, labelled "unverified". |
| `web/src/app/[locale]/(public)/page.tsx` | 259 | "App Store coming soon" disabled button | Honest (iOS skipped); kept as disabled with label. No fake stats, testimonials or counters exist; featured/nearby/area sections already hide when empty. `GET /public/stats` not needed because no stat is shown. |
| `admin/src/pages/dashboard.tsx` | – | tiles/charts | All real aggregates from `/admin/stats`. Added 7/30/90-day range and "No data yet" instead of flat curves. |
| `app/lib/features/gallery/component_gallery.dart` | – | sample copy | Debug only (route + settings row gated). |
| `app/lib/l10n/*` `reportReasonFakeProfile` | – | the word "fake" | Report reason label, not data. |
| `web/src/lib/api-client.ts` | 80 | `Math.random` | Device-id fallback only. |
| stock avatars (pravatar, unsplash, randomuser, ui-avatars) | – | none found in any repo | Avatars are real uploads or brand-colour initials (`PhAvatar`). |
| mock clients / MSW / demo-mode flags | – | none found | – |
| `catch {}` that fakes success | – | only 2 empty catches, both non-user-facing (`social_sign_in.dart:63`, `app_config.dart:75` cache fallback) | Keep. |
