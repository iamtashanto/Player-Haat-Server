# Server release notes (release/v1)
- **No demo data in production.** `prisma db seed` is reference-only. Demo users live in `pnpm db:seed:dev` (refuses production/non-local DBs); `pnpm cleanup:demo` removes demo + e2e data. First admin: `pnpm admin:create`.
- **Phone/SMS login is off** (`AUTH_PHONE_OTP_ENABLED=false`): phone routes return 404 `AUTH_METHOD_DISABLED`; enabled methods are exposed in `/app-config`. Phone-only accounts can add email + password (`POST /auth/methods/email`) or link Google. Phone is a contact detail, not verified.
- **Ratings v2:** double-blind reveal (both rated or 7 days), fair averages ("New" until 3 revealed reviews; damped average for ordering), attendance as the single no-show source, disputes (7 days after reveal) with an admin queue, one public reply (300 chars, editable 24 h), admin hide/recompute, flagged organisers, `ratings:reconcile`.
- Production boot refuses a localhost `PUBLIC_API_URL`.
- Admin stats accept `?days=7|30|90`.
- Migrations added: `ratings_reveal_disputes`, `rating_admin_actions`, `bayes_default`. See `docs/DEPLOY_CHECKLIST.md`.
- Not built (later): teammate (player-to-player) ratings.
