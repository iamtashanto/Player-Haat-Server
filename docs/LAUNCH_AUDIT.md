# PlayerHaat launch audit (13 Nov 2026)

Checked across all four repos (server, web, admin, Android app). "Web" below means the website at every width; below 768 px
it is the mobile layout that mirrors the app.

## 1. Test gates (run on this date)

| Repo | Gate | Result |
|---|---|---|
| server | `tsc`, vitest (63 files) | **903 / 903 pass** |
| web | `tsc`, unit tests | 31 / 31 pass; no lint config exists (see gaps) |
| web | Playwright, real API, desktop + mobile | **48 / 50 on the full run**; the 2 failures were the telemetry spec, a real bug (below), now fixed and re-run green; map, competition, PWA specs re-run green after the dependency upgrades |
| admin | `tsc`, vitest | 7 / 7 pass |
| app | `flutter analyze`, `flutter test` | no issues; all pass (3 new model tests) |
| web / server | `pnpm audit --prod` | web: **no known vulnerabilities**. server: only deep build-tool dependencies (Prisma config, firebase-admin helpers), none on a request path |

Not run: Android emulator walkthrough and a production Android build (need your signing keystore and `google-services.json`).

## 2. Bugs this audit found and fixed

1. **Telemetry lost when a tab closed** once the service worker was active (found by the e2e). The worker now completes those sends itself.
2. **Mobile header overflow** on Teams and Games: I had put too many buttons in the title bar and the page scrolled sideways. Moved into a wrapping row.
3. **`feePaid` leaked** into the public `myApplication` shape (caught by an older contract test).
4. **Tournament create returned 500** (included a relation tournaments do not have); caught by the new tests.
5. **"Something went wrong" for most conflicts**: 40+ server error codes had no message on the web. All user-facing ones now have English and Bangla text.
6. **Critical advisory in `maplibre-gl` 4.7.1** (added this session): upgraded to 6.18. Also bumped `zod`, pinned patched `postcss`.
7. Offline page, install button and notification-preference race (earlier in this session): fixed with tests.

## 3. Feature matrix

✔ = built and tested, ◐ = partly, ✘ = not built.

| Feature | Server | Web (desktop + mobile) | Android app | Admin |
|---|---|---|---|---|
| Email / Google sign-in, phone OTP (off) | ✔ | ✔ | ✔ | n/a |
| Profiles, photos, cover, gallery, videos | ✔ | ✔ | ✔ | moderation |
| Search, near-me, type-to-search address | ✔ | ✔ | ◐ (cascading picker, no type-to-search) | locations |
| Post / apply / accept / chat / attendance | ✔ | ✔ | ✔ | requests |
| Ratings v2, replies, disputes, top players | ✔ | ✔ | ◐ (reviews yes, `/top` page no) | ratings |
| Dashboards (player, organiser) | ✔ | ✔ | ✘ | n/a |
| Share card (WhatsApp / Facebook) | ✔ | ✔ | ✔ (link share) | n/a |
| Installable web app, offline pages | n/a | ✔ | n/a | n/a |
| Crash + funnel telemetry | ✔ | ✔ | ✘ | ✔ health page |
| **Waitlist** with automatic promotion | ✔ | ✔ | ✔ | n/a |
| **Weekly games** and regulars | ✔ | ✔ | ✘ | via requests |
| **Match score**, outcome | ✔ | ✔ | ✔ | n/a |
| **Ground-fee split** (manual) | ✔ | ✔ | ✔ (view; set on web) | n/a |
| **Rain alert** (Open-Meteo) | ✔ | ✔ chip | ✘ (push works, no chip) | n/a |
| **Calendar export (.ics)** | n/a (on device) | ✔ | ✘ | n/a |
| **Data saver** | n/a | ✔ | ✘ | n/a |
| **Free maps**: pin ground, game map, directions, games map | ✔ | ✔ | ◐ directions link only, no map | n/a |
| **Post-code search**, real upazila centres | ✔ | ✔ | ✘ | n/a |
| **Verified team results**, standings, leaderboard | ✔ | ✔ public pages | ◐ confirm / reject on the game | n/a |
| **Public team pages** | ✔ | ✔ | ✘ | n/a |
| **Challenges** (ম্যাচ চাই) | ✔ | ✔ | ✘ | n/a |
| **Tournaments** (knockout) | ✔ | ✔ | ✘ | suspending the organiser hides them |
| Credits, manual bKash / Nagad payments | ✔ | ✔ | ✔ | payments queue |
| Reports, moderation, 2FA, roles, audit | ✔ | n/a | n/a | ✔ |

## 4. Open gaps, in order of launch risk

1. **Android signing and Firebase files**: needed to build the Play release and test push on real phones. (You.)
2. **Android parity** for weekly games, challenges, tournaments, leaderboard, dashboards, map, data saver, .ics, telemetry. The app does not crash on the new data (unknown values fall back safely and the new fields default), but these screens do not exist there yet. For launch you can ship the app as is; the web covers them.
3. **No ESLint config in `web`**: add one before the team grows. Type-checking and e2e are the safety net today.
4. **Moderation of new content**: there is no admin screen for tournaments or challenges, and reports cannot target a tournament. Suspending the organiser hides their tournaments and challenges. Add admin screens if abuse appears.
5. **Map provider terms**: OpenFreeMap is free with no key and fine for launch; check its usage terms and consider donating or self-hosting tiles when traffic grows. Attribution is shown on every map.
6. **Open-Meteo** is free for non-commercial use; if the product earns revenue (credits), check their commercial terms or buy their API plan.
7. **Post codes** cover 83% of post offices (1,098 of 1,324); the rest are listed in the build script output and skipped rather than guessed.
8. **Union and village coordinates** do not exist in the free datasets, so pins and centres are at upazila level. Organiser pins give exact grounds.
9. Rain alerts and weekly-game jobs run in-process; if you run several API instances they are safe (claims and checks are idempotent), just unnecessary duplication of lookups.

## 5. Needed from you before publishing

- Android upload keystore + `key.properties`, and `google-services.json`.
- Google web client ID and Android SHA-1 for Google sign-in.
- SMTP credentials (email verification, password reset).
- Production URLs / domain, then set `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_URL`, CORS origin on the API.
- Decision: phone OTP / SMS gateway (off), women-only games, turf owners.

## 6. Launch checklist

1. `server`: set production env (see `docs/DEPLOYMENT.md` and `docs/DEPLOY_CHECKLIST.md`), run `npx prisma migrate deploy`, then `npm run db:seed` (loads locations, post offices, upazila centres). Create the first admin with `admin:create`.
2. `web`: `NEXT_PUBLIC_API_URL=<prod api> pnpm build`; serve behind the nginx config in `web/nginx`. Open `/en/privacy` and check section 5 reads right for your lawyer.
3. Run the whole suite once against staging: server vitest, web Playwright (desktop + mobile), `flutter test`.
4. Smoke by hand with real accounts on a real Android phone: sign up, post a game with a pin, share it on WhatsApp, apply from a second phone, accept, chat, mark attendance, record a score, rate.
5. Lighthouse the public pages (`web/docs/LIGHTHOUSE.md`), including `/leaderboard` and `/t/<id>`.
6. Back up the database before the first real traffic, and confirm the daily purge job and the weekly-games and rain-alert jobs appear in the logs.
