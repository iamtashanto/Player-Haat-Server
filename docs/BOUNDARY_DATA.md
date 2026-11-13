# Boundary data (auto location)

`GET /locations/nearest?lat&lng` answers "which area contains this point?" with point-in-polygon on our own server. No third party ever sees a user's coordinate, and the server neither stores nor logs it.

## Source and licence

- **Dataset:** *Bangladesh – Subnational Administrative Boundaries* (COD-AB), published on the Humanitarian Data Exchange (data.humdata.org/dataset/cod-ab-bgd).
- **Source:** Bangladesh Bureau of Statistics (BBS); OCHA / HDX version v03, valid 2023-05-21, resource updated 2026-01.
- **Licence:** **Creative Commons Attribution for Intergovernmental Organisations (CC BY-IGO)** (checked on the dataset page's `license_id: cc-by-igo`). Attribution is required, commercial use is allowed.
- **Attribution text** (kept on the web About page and here): *"Administrative boundaries: Bangladesh Bureau of Statistics (BBS) via UN OCHA / Humanitarian Data Exchange, CC BY-IGO. Simplified for display and lookup."*
- **Levels in the data:** admin 1 (division), 2 (district), 3 (upazila). **There is no union (admin 4) layer.** I looked for an open, clearly licensed union-level boundary set and did not find one I can verify, so unions stay a manual pick, pre-filtered to the detected upazila.

## What we ship

`prisma/seed/data/boundaries/` (≈ 2.6 MB):

- `districts.json`, `upazilas.json`: polygons simplified with Douglas-Peucker (~60 m) and rounded to 4 decimals, keyed by **our** names (`"<district>"`, `"<district>|<upazila>"`);
- `overrides.json`: manual matches (e.g. Zianagar = Indurkani, Wazirpur = Ujirpur, Comilla Sadar = Adarsha Sadar);
- `match-report.json`: the last matching run (unmatched upazilas on both sides).

They are loaded lazily into memory (bbox pre-filter + ray casting, holes handled). PostGIS is not installed in our docker or local Postgres, so it is not used; the in-memory index answers in well under a millisecond.

## Matching our 610 upazilas to the 2023 polygons

Our list (bd-geo-info) and the boundary set differ. `scripts/build-boundaries.ts` matches by normalised name inside the parent district, then by edit distance (≤ 2, unique best), then by `overrides.json`.

Last run: **495 of 610 matched** (386 exact, 90 fuzzy, 14 override). The remaining 115 are:

- ~100 **city-corporation thanas** (Dhaka 50, Chattogram 16, Rajshahi 11, Khulna 10, Gazipur 7, Rangpur 6, Sylhet 5, Barishal 3 …): the dataset has one polygon per city corporation, not per thana. A point there resolves to the **district** and the user picks the thana;
- 10 upazilas the boundary set does not have: Barishal Airport/Bandar/Kawnia, Cumilla Bangra, Lakshmipur Chandraganj, Cox's Bazar Matamuhuri, Mymensingh South Gafargaon, Bogura Mokamtola, Thakurgaon Ruhia/Bhully.

Every boundary polygon is matched except the 12 city-corporation polygons. Rebuild after a data bump:

```
curl -L <geojson.zip from the HDX page> -o geo.zip && unzip geo.zip -d /tmp/hdx
npx tsx scripts/build-boundaries.ts /tmp/hdx
```

then review `match-report.json` and add `overrides.json` entries.

## Privacy

- The coordinate is only used to find the area. It is not stored, not logged, and not sent anywhere.
- Persist **area ids**. If the user opts in to "near me", persist a coordinate rounded to ~1 km (`roundCoarse`, 0.01°) for distance sorting.
- Manual selection always works.

## Places (villages, towns, bazaars, beaches, islands)
`prisma/seed/data/places.json` (47,813 rows) is built by `scripts/build-places.ts` from GeoNames' Bangladesh extract
(https://download.geonames.org/export/dump/BD.zip, **CC BY 4.0: the credit is on the About page; keep it**),
including hand-checked popular places with Bangla names (Kuakata, Cox's Bazar beach, Saint Martin's, Sajek...).
Each place is put in its district and upazila by our boundary polygons; 826 fall outside any upazila polygon (city areas) and
keep only their district.
Seed with `npm run db:seed`. The same data is exported into the bd-geo-info package with
`scripts/export-places-to-geo-package.ts <bd-geo-info>/src/data`.
