# PlayerHaat system audit

Audit date 2026-11-09, branch `feat/audit-media-location-notify`.

**How to read the "status" column.** *works* = exercised against the running API or covered by an automated test that passes; *partial* = exists but with a gap (named in the notes); *missing* = nothing in the schema or routes; *not verified* = I did not open or run it in this audit. Columns marked **n/v** were not re-verified here.

**Evidence used**

- Server: 651 vitest tests (all pass) plus `scripts/audit-smoke.mjs`, which logs in as a player and a recruiter and calls every parameter-free GET route anonymously, as a player and as a recruiter. Result: **no 5xx on 34 routes, no protected route answers an anonymous caller**, role-restricted routes return 403 to the wrong role, every `/admin/*` route returns 403 to an app token.
- Web: Playwright journeys at 390×844 and 1440×900 (sign-up → setup → search → post → edit → apply → accept → complete → rate → chat; events/boost/invites; first-visit onboarding).
- App: **not re-run in this audit** beyond the screens captured for visual parity (auth, home, players, games, alerts, me, player profile, edit profile, sport editor, request create).
- Admin: **not opened in this audit** (pages exist: users, profiles, recruiters, requests, reports, verifications, payments, sports, locations, flags, announcements, audit, account).

## Auth
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| email sign-up / login / verify / forgot / reset | tests | seen | e2e | n/a | works | `/auth/*` routes, tests in `auth-credentials`, `auth-passwords` |
| phone OTP | tests | n/v | n/v | n/a | partial | server tested with a fake SMS; web page exists, no SMS provider in dev |
| Google / Apple | tests (fake verifier) | n/v | n/v | n/a | partial | needs client IDs; never exercised against the real providers |
| refresh / logout / logout-all | tests | n/v | e2e (cookie refresh) | n/a | works | |
| account deletion | tests | n/v | n/v | n/a | works (DB) / **broken (media)** | `DELETE /auth/account` removes rows; user media is cleaned through the storage seam (now our media service) but this audit did not run a real delete of a user with files |
| role choice / switch | tests | seen | e2e | n/a | works | web has no role switch on phones (moved to Me in the app; web Me has none yet) |

## Profiles
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| player profile, several sports | tests | seen | e2e | n/v | works | |
| recruiter profile | tests | n/v | e2e | n/v | works | |
| edit everything, hide/show | tests | seen | seen | n/v | works | sport-level and profile-level visibility |
| verification (recruiter, stats) | tests | n/v | partial | n/v | partial | web upload of evidence exists; admin review not exercised here |
| cover photo | none | none | none | none | **missing** | Phase 2 |
| photo gallery | `PlayerMedia`, max **6** (brief wants 12), no reorder, no caption | grid | grid | n/v | partial | |
| video gallery | link rows, max **3** (brief: 6), host allow-list (YouTube/Facebook/Vimeo), no video-id model, no `source` enum | link rows | link rows | n/v | partial | Phase 2 |

## Casual play (the core product)
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| "আজ খেলবি" available-today status + auto-expiry | none | none | none | none | **missing** | no field, no job |
| nearby available players | none | none | none | none | **missing** | search has area filters only, no coordinates on users/profiles |
| open games (create, join, leave, fill, cancel) | `PlayerRequest` + `Application` | seen | e2e | n/v | works | requests *are* the open games: post, apply, withdraw, fill, cancel, edit, complete |
| per-game chat | conversations are user-to-user | n/v | e2e (user chat) | n/a | **missing** | no conversation tied to a game |
| invite ("চল খেলি") | tests | n/v | e2e | n/v | partial | recruiter → player invites for an event/request exist; player-to-player casual invite does not |
| attendance | none | none | none | none | **missing** | |
| no-shows | `Rating.noShow`, `PlayerProfile.noShowCount` (captain → player only) | shown | shown | n/v | partial | no player-side or attendance-confirmed flow |
| post-game rating + reminders | tests | seen | e2e | n/v | works | reminder job runs every 15 min |

## Recruitment and khep
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| requests, applications, accept/reject | tests | seen | e2e | n/v | works | |
| khep toggle + rate | tests | seen | e2e | n/a | works | |
| shortlist | tests | n/v | e2e | n/a | works | |
| contact reveal, viewers | tests | n/v | e2e | n/a | works | credit gating is a flag, off by default |
| credits / wallet | tests (manual bKash/Nagad/Rocket) | n/v | e2e | payments page | works | admin approval flow not exercised here |

## Other features
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| teams / regular groups | tests | n/v | pages | n/v | works | create, join, captain |
| team vs team ("ম্যাচ চাই") | none | none | none | none | **missing** | proposal below |
| cost split | none | none | none | none | **missing** | proposal below |
| events | `RequestKind.EVENT` (trial/camp) | n/v | e2e | n/v | works | these are trials, **not tournaments** |
| tournaments, turf | none | none | none | none | **missing** | proposal below |
| boost | tests | n/v | e2e | flag | works | `boost_enabled` flag |

## Search
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| players: sport, position, area, khep, rate, experience, skill, rating, availability day, verified, name, sort, cursor pagination | tests (`players-search`) | seen | e2e (name, sport) | n/a | works | no distance sort (no coordinates) |
| requests feed: sport, position, area, paid, kind, pagination | tests | seen | e2e | n/a | works | |

## Locations
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| division → district → upazila → union, bn + en | 610 upazilas, 4,540 unions from `bd-geo-info` | n/v | picker with union step (e2e) | locations page | works | `District` and `Upazila` have `lat`/`lng`; **`Union` has none** |
| union selectable in the app picker | n/a | n/v | n/a | n/a | not verified | |
| nearest-area lookup | `GET /locations/nearest` (district centres) | none | none | none | partial | district precision only: nearest *centre*, not containment (a Kalapara point answers Barguna first); the dataset has **no upazila/union coordinates** — see decision 8 |
| dev database seeded with the full dataset | | | | | fixed | the `playerhaat` dev DB had 494 upazilas; re-seeded to 610 upazilas / 4,537 unions, 64/64 districts now have lat/lng |

## Platform
| feature | server | app | web | admin | status | notes |
|---|---|---|---|---|---|---|
| in-app notifications: list, unread count, mark read | tests | seen | seen | n/a | works | **no delete**; paginated |
| push to the app (FCM) | `lib/push/firebase.ts`, dead tokens removed | n/v | n/a | n/a | works (server) | background in-process, **no queue/retry/send log** |
| web push | none | n/a | none | none | **missing** | Phase 4 |
| notification preferences, quiet hours | none | none | none | none | **missing** | |
| triggers present | new matching request, applicant, accepted/rejected/withdrawn, cancelled/updated, rating reminder, invite received/accepted/declined, contact viewed, new message, verification result, team joined, system | | | | partial | **missing:** someone near me is available, game reminders (2 h / morning), game filled, collapse of chat bursts, admin announcements targeted by role/sport/location (broadcast exists, untargeted) |
| chat | tests | n/v | e2e | n/a | works | polling on web |
| reports / moderation | tests | n/v | sheet | reports page | works | |
| public SEO pages | `/public/*`, request detail restricted to open+upcoming | n/a | e2e | n/a | works | |
| app-config flags | `ads_enabled=false`, `min_app_version=1.0.0` | n/v | n/a | flags page | works | `boost_enabled=true` in this dev database only because the e2e sets it |
| admin: user/profile/request moderation, reports, sports, locations, flags, audit log, 2FA | tests (`admin*`) | n/a | n/a | n/v | works (server) | UI **not opened** in this audit |

## Security and quality
| check | result |
|---|---|
| RBAC on every route | works: anonymous → 401, wrong role → 403 on the 34 probed routes; admin routes → 403 for app tokens; `rbac.test.ts` |
| ownership checks | works: storage ids encode the owner (`isOwnedBy`), request/profile mutations are owner-checked in tests |
| rate limits | works (`rate-limits.test.ts`); in-memory per process, `RATE_LIMIT_ENABLED=false` allowed outside production only |
| input validation | Zod on every route |
| secrets in clients | none found; `MEDIA_API_KEY` is read only in `src/lib/storage/tashanto.ts` and `src/config/env.ts` |
| error codes translated bn/en | works for the codes clients map; **partial**: not every one of the 149 codes was checked in both apps |
| OpenAPI / health | works: `/health` (load balancers) and `/api/v1/health` are both served and documented (my earlier "mismatch" was the smoke script prepending `/api/v1`) |

## Fixed or built in this audit
- **Media provider** (Phase 2, server part): `TashantoMediaStorage` behind the existing `StorageProvider` seam, default when `MEDIA_API_KEY` is set; Cloudinary stays as a fallback (`STORAGE_PROVIDER`). Key stays in `server/.env`. Verified live: avatar upload through `PUT /users/me/avatar`, served as WebP from `media.tashanto.com`, delete removes it from the service. 7 unit tests against a mock HTTP server (retry, timeout, error mapping, no key leakage).
- `scripts/audit-smoke.mjs`: the repeatable live audit.
- **Phase 3, server part:** district coordinates (64/64, from `bd-geo-info`) in the seed (`scripts/build-district-coords.ts`), and `GET /locations/nearest?lat&lng&limit` (haversine, Bangladesh bounds, public, rate-limited, coordinate neither stored nor logged). 4 tests. Typecheck clean, 655/655 server tests pass.

## Not built yet
Everything marked **missing** or **partial** above except the media provider. Phase 2 DB changes (media id columns, cover photo, 12-photo gallery with reorder/caption, YouTube video model with a `source` enum), the Cloudinary migration script, EXIF stripping, per-user upload rate limit, app/web/admin media UI, Phase 3 (location), and Phase 4 (notifications) were not started.

## Plans that need your decision (not started)
8. **Finer auto-location.** `bd-geo-info` has coordinates for divisions and districts only. To pre-fill upazila and union I need a source with their coordinates or boundaries. Options: (a) an open dataset with upazila/union centroids or polygons (GADM / OSM-derived, shipped in the repo, no user data leaves the server); (b) a reverse-geocoding API (sends the user's coordinate to a third party: needs your OK, and is rate-limited); (c) keep district auto-detect and make the user pick upazila/union. I recommend (a) with point-in-polygon on the server. Until then clients should use `nearest` only to pre-select the district.
1. **Casual play** (core product, I would build it next): `PlayerProfile.availableUntil` (+ `availableSports`), set by a one-tap "আজ খেলবি" that expires at 23:59 Asia/Dhaka or after N hours; `GET /players/available-nearby`; a nightly/hourly job clears expired rows; push to nearby matching players (debounced, capped per day). Needs coordinates, so Phase 3 first.
2. **Reliability:** attendance confirmation by both sides after a game, a reliability score derived from attended / no-show / late-cancel counts, shown on cards.
3. **Per-game chat:** a conversation row keyed by `requestId`, members = owner + accepted players.
4. **Cost split:** `PlayerRequest.totalCost` + per-player share, "paid" marks by the owner; no payments through the app.
5. **Team vs team:** a `MatchChallenge` between two teams with accept/decline and a result.
6. **Tournaments and turf:** separate modules (fixtures, brackets; venues with booking). Large; I would not start them before 1–5 ship.
7. **Web push:** standard VAPID web push (no Firebase dependency in the browser, works with the same notification table); FCM stays for the app.
