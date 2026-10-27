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

Converted from [nuhil/bangladesh-geocode](https://github.com/nuhil/bangladesh-geocode) (MIT licence;
names sourced by that project from bangladesh.gov.bd, Wikipedia and Google Maps), `master` branch
as of 2026-10-27: 8 divisions, 64 districts, 494 upazilas, 4,537 unions.

Conversion notes: district spellings were aligned to `data/districts.ts` (Comilla→Cumilla,
Coxsbazar→Cox's Bazar, Jhalakathi→Jhalokati, Barisal→Barishal); 3 exact-duplicate union rows were
dropped (Awajpur/Charfesson, Talimpur/Barlekha, Bhojoanpur/Tetulia); the two distinct "Natai" unions
in Brahmanbaria Sadar were renamed "Natai (North)" / "Natai (South)". 5 upazilas have no unions in
the source (Guimara, Naldanga, Eidgaon, Madhyanagar, Dasar). No BBS codes are included.
Spellings follow the source (e.g. "Mahipur", "Chakamaia") — not an official BBS list.

## Demo logins

After `npm run db:seed:demo` every demo user (`rakib@`, `sohel@`, `imran@`, `tuhin@`, `mahin@` + `demo.playerhaat.test`)
can log in with the password `Demo1234`. Local development only — demo seeding refuses to run in production.
