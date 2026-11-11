# PlayerHaat system audit

First audit 2026-11-09, **re-audit 2026-11-09 after building Steps 1–4**. Branch `feat/audit-media-location-notify` in `server`, `app`, `web`, `admin`. Nothing is pushed.

**How to read the "status" column.** *works* = exercised against the running API, a Playwright run, or an automated test that passes; *partial* = exists with a gap (named in the notes); *missing* = nothing in the schema or routes; *not verified* = not run in this audit.

## Evidence

| what | result |
|---|---|
| Server | `tsc` clean, **763 vitest tests pass** (46 files). Test DB: local Postgres `playerhaat_test` (Docker was down). |
| Live API smoke (`scripts/audit-smoke.mjs`) | logs in as a player and a recruiter and calls every parameter-free GET route anonymously / as player / as recruiter: **40 routes, no 5xx, no protected route answers an anonymous caller**; **25 `/admin/*` GET routes all refuse anonymous, player and recruiter tokens**. |
| Web, typecheck + build + unit | `tsc` clean, `next build` ok, 27 vitest tests. |
| Web, Playwright (production build, real API + media service) | 10 specs, **desktop 1440×900 and mobile 390×844 all green**: journey (sign-up → setup → search → post → edit → apply → accept → complete → rate → chat), events/boost/invites, auto-location (granted and denied), **media** (cover + gallery + caption + YouTube + viewer), **play** (free today → nearby → invited → joined → game chat → attendance → reliability), **notifications** (arrives in the inbox, opens the game; preferences and quiet hours persist), welcome. |
| Web, **audit pass** (`e2e/audit-pass.spec.ts`) | a player and a recruiter walk 18 screens at **411×914 and 1440×900**: no console error, no failed request, no horizontal overflow, no `undefined` / `NaN` / `{name}` on screen. Screenshots: `web/e2e/screenshots/audit-*.png`. |
| App | `flutter analyze` clean, **104 tests pass**. **Not run on a device or emulator in this final pass**: the new screens are covered by widget/unit tests only. |
| Admin | build clean, 7 tests. **UI opened** (signed in as an admin at 411×914 and 1440×900): dashboard, users, announcements, audit log, flags, reports render with no error or overflow; screenshots `web/e2e/screenshots/admin-*.png`. |

## Defects found and fixed during the audit

1. **Admin broadcast could not have worked.** It wrote `title`/`body` columns `Notification` doesn't have, then also called `notify()` (a second row per user), and had no test. Rebuilt as a real feature (see Notifications).
2. **Admin audience filter:** choosing a division *and* a district silently used only the division; admin accounts were included in "everyone". Fixed, tested.
3. **Admin media removal left the file in storage** (row deleted, image still served). Fixed: the file is deleted and the action is audited (`MEDIA_REMOVE`).
4. **Web asked the other role's endpoints on every screen** (`/players/me` for recruiters, `/recruiters/me` for players, `/invites/received|sent`): a 403 per screen. Fixed.
5. **Invite sheet title showed a literal `{name}`.** Fixed.
6. **A player could not leave a game once it was full** in the web UI (the button vanished when status became FILLED; the API allowed it). Fixed.
7. **App free-today card overflowed on a phone** when switched on (long button label). Caught by a widget test; fixed.
8. `GET /health` was also expected at `/api/v1/health`: both are served now.
9. Gotcha worth knowing: `timestamp` columns hold UTC; SQL that compares them to `now()` in a non-UTC session is wrong. The availability search binds an ISO string cast to `timestamp`; e2e SQL uses `now() at time zone 'utc'`.

## Auth
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| email sign-up / login / verify / forgot / reset | tests | tests | e2e | n/a | works | |
| phone OTP | tests (fake SMS) | n/v | n/v | n/a | partial | no SMS provider in dev |
| Google / Apple | tests (fake verifier) | n/v | n/v | n/a | partial | needs client IDs; never run against the real providers |
| refresh / logout / logout-all | tests | n/v | e2e | n/a | works | |
| account deletion | tests | n/v | n/v | n/a | works | now also deletes avatar, **cover** and gallery files (test with the fake storage) |
| role choice / switch | tests | tests | e2e | n/a | works | |
| admin sign-in, 2FA | tests | n/a | n/a | opened | works | 2FA is off outside production, refused to be off in production |

## Profiles and media
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| player profile, several sports, edit, hide/show | tests | tests | e2e | opened | works | |
| recruiter profile | tests | n/v | e2e | opened | works | |
| verification (recruiter, stats) | tests | n/v | partial | n/v | partial | see "documents" below |
| avatar | `PUT /users/me/avatar`, old file deleted | tests | e2e | remove | works | rendition `w_150,h_150,c_fill` everywhere |
| **cover photo** (about 3:1) | `PUT/DELETE /players/me/media/cover`, kind `player-cover` | cropper at 3:1 | crop + upload | remove | works | e2e + tests |
| **gallery**: max 12, caption, reorder, delete | tests | long-press reorder, caption sheet, viewer | drag reorder, drop upload, lightbox | remove | works | the cap holds under concurrent uploads |
| **YouTube videos**: id stored, `source` enum, max 6 per sports profile | tests | cards, per sport | cards, per sport | remove | works | any link form → id; other hosts refused; `source: UPLOAD` → 400 `UPLOAD_NOT_AVAILABLE` |
| existing video links | migration | | | | done | converted to YouTube ids on the player's first sport; non-YouTube / no sport dropped. Dev DB: 31 converted, 0 dropped |
| `/img/` transforms | `imageUrl()` builds URLs from the stored path at read time | `Img.*` | `IMG`, `mediaLoader` | | works | avatar `w_150,h_150,c_fill`, thumb `w_400`, full `w_1200`, cover `w_1200,h_400,c_fill` |
| OG image for public profiles | | n/a | cover (else avatar) at `w_1200,h_630,c_fill`, else the generated card | n/a | works | |
| EXIF/GPS stripping | `stripImageMetadata` (JPEG, PNG, WebP) before storage | | the browser re-encodes too | | works / **partial** | **HEIC metadata cannot be rewritten** and is not stripped: clients send JPEG (image_picker and the web canvas both do) |
| per-user upload rate limit | 30 / 15 min per user | | | | works | |
| Cloudinary → media-service migration | `scripts/migrate-cloudinary-media.ts --dry-run` | | | | works | safe twice, tested; dev DB had 0 legacy rows |
| **store the reference, not a full URL** | `publicId` (the service path) is stored and URLs are built from it | | | | **partial** | `mediaId`, `mime`, `width`, `height`, `size` columns were **not** added; the domain can change without a data migration, but those fields are not kept |
| team logo | through the same provider | | | | works | |
| recruiter / organisation logo | none | | | | **missing** | there is no logo field on `RecruiterProfile` |
| **verification documents: private folder, PDF, admin-only via `/f/`** | | | | | **missing — decision needed** | evidence images go through the public image path today (public URLs); PDFs are refused. Making them private needs the media service's `/f/` plus a signed or proxied admin download. Not started |
| admin: avatar/cover/gallery on the user, remove with reason, usage | `DELETE /admin/users/:id/{media/:id,avatar,cover}`, `GET /admin/media/usage` | n/a | n/a | works | works | audited |

## Casual play (the core product)
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| **"আজ খেলবি"** per sport, optional end time, expires at the window end or midnight Asia/Dhaka | `PlayerAvailability`, `PUT/GET/DELETE /players/me/availability`, sweep job | card on Home | card on Home | tile | works | expiry is a read-time filter (a late sweep never shows a stale player) |
| **nearby available players** (sport, area, skill) | `availableToday` filter + `availableToday` flag on every card | "Free today" chip | switch + badge | | works | combines with area, `minSkillLevel`, sport and **near me** |
| **open games**: create, join, leave, fill, cancel | `PlayerRequest` + `Application`; `joinMode` APPROVAL \| OPEN_JOIN | switch, one-tap join/leave | switch, join/leave | | works | open join is accepted under the request row lock: never over-fills (concurrency test); leaving re-opens a full game |
| **per-game group chat** | `/games/:id/chat…`; members = organiser + accepted players; read-only 7 days after the game or on cancel | screen + list | screen + list | tile (messages) | works | auto-created (it is derived, not a table of members) |
| **attendance** | `PUT /games/:id/attendance` (organiser, after kick-off, 14-day window, correctable) | chips on each accepted player | chips | tile | works | |
| **reliability score** | games played, attendance %, no-shows, average rating | line on tiles, profile, applicants | same | | works | same numbers and wording everywhere |
| invite ("চল খেলি") | tests | tests | e2e | n/v | partial | recruiter → player invites for an event/request exist; player-to-player casual invite does not |
| post-game rating + reminders | tests | tests | e2e | n/v | works | |

## Recruitment and khep
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| requests, applications, accept/reject | tests | tests | e2e | opened | works | |
| khep toggle + rate | tests | tests | e2e | n/a | works | |
| shortlist, contact reveal, viewers | tests | tests | e2e | n/a | works | credit gating is a flag, off by default |
| credits / wallet | tests (manual bKash/Nagad/Rocket) | n/v | e2e | opened | works | admin approval flow not exercised end to end here |

## Locations
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| division → district → upazila → union, bn + en | 610 upazilas, 4,537 unions seeded | picker | picker (e2e) | page | works | |
| **auto location** | `GET /locations/nearest` returns the **containing** district and upazila from our own polygons (OCHA/HDX COD-AB, CC BY-IGO); 2 km border tolerance; no coordinate stored or logged | "Use my location" | "Use my location" (e2e granted + denied) | | works | 495 of 610 upazilas matched to a polygon (386 exact, 90 fuzzy, 14 manual overrides). The ~115 unmatched are ~100 city-corporation thanas (the dataset has no thana polygons) and 10 newer upazilas: those fall back to the district and the user picks. **Union stays a manual pick**, pre-filtered to the detected upazila: no reliable open admin-4 dataset was found |
| **near me** sorting (players and games) | `sort=near` ranks union → upazila → district → rest, from area ids | players + games feed | players + games feed | | works | no coordinates are sent for ranking |
| attribution | `docs/BOUNDARY_DATA.md` | | About page | | done | |
| opt-in ~1 km coordinate storage | | | | | **not built** | nothing needs it yet (near-me works from area ids). Would need a consent toggle, a column and a migration |

## Notifications
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| inbox: list, unread, mark one/all read, **delete one/all** | tests | swipe delete, clear | delete, clear | n/a | works | each type deep-links via a server-provided `link` |
| push to the app (FCM) | tokens registered/unregistered (apps only), dead tokens removed, data payload with `link` and `type`, bn/en | Android channels games / messages / recruitment / system | n/a | | works (server); **FCM not exercised against Firebase here** | needs `FIREBASE_SERVICE_ACCOUNT` |
| **web push** (**standard VAPID**, `web-push` package; app keeps FCM) | `WebPushSubscription` per browser, `POST/DELETE /notifications/web-push/subscriptions`, public key from `GET /notifications/web-push/key`, expired subscriptions deleted on 404/410, sent from the same queue (retry, quiet hours, log) | n/a | no Firebase in the browser: static `/sw.js`, opt-in sheet **after an apply / post / message** (snoozed 14 days), in-page toast when the tab is open, click → deep link | | works (tests with a fake sender) / **not delivered through a real browser push service here** | needs `VAPID_*` keys on the server |
| **preferences + quiet hours** | 4 groups + "someone near me" + quiet hours default 23:00–07:00 Asia/Dhaka, chat allowed through only if the user says so | screen | card in Settings | | works | off = no push; the inbox still keeps the message |
| **delivery**: queue, retry, send log | `PushJob`: claimed with `SKIP LOCKED`, retry 30 s → 2 → 8 → 32 min then FAILED, collapse of chat bursts, expiry for late reminders, crash release; 30-day purge | | | push log, queue health | works | request handlers only enqueue |
| trigger: new game near me matching sport/position/khep | tests | | | | works | |
| trigger: **someone near me is free today** | debounced 6 h per player, max 2 a day per recipient, no names | | | | works | |
| trigger: invite, application received / accepted / rejected / withdrawn | tests | | | | works | |
| trigger: chat message (collapsed) and **game chat** | tests | | | | works | |
| trigger: **game reminders** 2 h before and the morning of | once each, advisory-locked job | | | | works | dropped if it would arrive after kick-off |
| trigger: game **filled** / cancelled | tests | | | | works | |
| trigger: rating reminder after the game and next day | tests | | | | works | |
| trigger: contact revealed | tests | | | | works | **profile views are not tracked** at all, so "profile viewed" has no source |
| trigger: verification approved / rejected | tests | | | | works | |
| **admin announcements**: targeted by role, sport, place; preview + confirm; **delivery stats** | `Announcement` + per-user jobs; sent / devices reached / failed / skipped by reason / opened | | | page + push log | works | |

## Other features
| feature | status | notes |
|---|---|---|
| teams / regular groups | works | create, join, captain |
| events | works | `RequestKind.EVENT` = recruiter trials, **not tournaments** |
| boost | works | `boost_enabled` flag |
| chat (1:1), reports / moderation, public SEO pages, app-config flags | works | |
| **cost split, team vs team, tournaments, turf** | **not built, as instructed** | proposals below |

## Security and quality
| check | result |
|---|---|
| RBAC on every route | works: anonymous 401, wrong role 403 on the 40 probed routes; every probed `/admin/*` route refuses app tokens; `rbac.test.ts` |
| secrets in clients | none: `MEDIA_API_KEY` is read only in `src/lib/storage/tashanto.ts` and `src/config/env.ts`, lives only in `server/.env`, is never logged, and the web only has `NEXT_PUBLIC_MEDIA_URL`. Firebase web config values are public by design |
| ownership checks | works (storage ids encode the owner; request/profile/media mutations owner-checked in tests) |
| privacy | no raw coordinates stored or logged; "someone near you" never names the player; game-chat membership is derived, non-members get a 404 |
| rate limits | works; per user when signed in |
| input validation | Zod on every route |
| error codes in bn/en | not every one of the 156 codes was checked in both apps |

## Plans that need your decision (not started)
1. **Cost split:** `PlayerRequest.totalCost` + per-player share, "paid" marks by the organiser; no payments through the app.
2. **Team vs team:** a `MatchChallenge` between two teams with accept/decline and a result.
3. **Tournaments and turf:** separate modules (fixtures, brackets; venues with booking). Large; not before 1 and 2 ship.
4. **Verification documents (private):** use the media service's `/f/` for PDFs and images, keep them in a private folder, and have the admin dashboard download through our server. This is the one **security gap** left from the brief.
5. **Opt-in coarse location** (~1 km) on the profile, for a true distance sort. Only if you want distance rather than same-area ranking.
6. **Recruiter / organisation logo** (no field exists).
7. **Profile-view tracking**, if you want a "someone viewed your profile" notification.
