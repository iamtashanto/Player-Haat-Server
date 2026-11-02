# Seed data

`npm run db:seed` is idempotent and safe to re-run. It seeds, in order:

1. **Locations** — 8 divisions and 64 districts (always), then upazilas/unions from:
   - `data/locations-full.json` if present (the full national dataset), otherwise
   - `data/locations-demo.ts` (Patuakhali only, for local dev).
2. **Sports + positions** (football, cricket).
3. **App config** defaults (`ads_enabled`, `boost_enabled`, `min_app_version`) — existing values are never overwritten.

Demo users/players/requests (Kuakata / Kalapara) are added only with `npm run db:seed:demo`
and are refused when `NODE_ENV=production`.

## Loading the full upazila/union dataset

Drop a JSON file at `data/locations-full.json` shaped like:

```json
[
  {
    "district": "Patuakhali",
    "nameEn": "Kalapara",
    "nameBn": "কলাপাড়া",
    "code": "107858",
    "unions": [{ "nameEn": "Mohipur", "nameBn": "মহিপুর", "code": "10785857" }]
  }
]
```

`district` must match a district's English name in `data/districts.ts`. Rows are upserted on
(parent, slug), so re-seeding updates names and adds missing rows without creating duplicates.

## Provenance of `data/locations-full.json`

Generated from the [`bd-geo-info`](https://www.npmjs.com/package/bd-geo-info) package (BBS-derived) by
`scripts/build-locations.ts`: 8 divisions, 64 districts, 610 upazilas/thanas (including metropolitan thanas, which have no
unions) and 4,540 unions, English and Bangla. District spellings are aligned to `data/districts.ts`; the script fails if one
doesn't match. Four union names repeat inside one upazila and are merged by the seed's (parent, slug) key.
Regenerate after upgrading the package: `pnpm tsx scripts/build-locations.ts && npm run db:seed`.

## Demo logins

After `npm run db:seed:demo` every demo user (`rakib@`, `sohel@`, `imran@`, `tuhin@`, `mahin@` + `demo.playerhaat.test`)
can log in with the password `Demo1234`. Local development only — demo seeding refuses to run in production.
