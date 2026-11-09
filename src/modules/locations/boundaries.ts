import { readFileSync } from "node:fs";

/**
 * Administrative boundaries (OCHA/HDX COD-AB, BBS source, CC BY-IGO — see docs/BOUNDARY_DATA.md), simplified to ~60 m and
 * loaded lazily into memory with a bbox pre-filter. No PostGIS needed. Keys are OUR names:
 *   districts "<district>", upazilas "<district>|<upazila>".
 */
type Ring = [number, number][]; // [lng, lat]
type Poly = Ring[]; // outer ring + holes
interface Area { key: string; bbox: [number, number, number, number]; polys: Poly[] }

export interface Boundaries {
  districts: Area[];
  upazilasByDistrict: Map<string, Area[]>;
}

const dataUrl = (f: string) => new URL(`../../../prisma/seed/data/boundaries/${f}`, import.meta.url);

function toAreas(raw: Record<string, Poly[]>): Area[] {
  return Object.entries(raw).map(([key, polys]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polys) for (const [x, y] of p[0]!) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return { key, bbox: [minX, minY, maxX, maxY], polys };
  });
}

export function buildBoundaries(districts: Record<string, Poly[]>, upazilas: Record<string, Poly[]>): Boundaries {
  const byDistrict = new Map<string, Area[]>();
  for (const a of toAreas(upazilas)) {
    const d = a.key.split("|")[0]!;
    (byDistrict.get(d) ?? byDistrict.set(d, []).get(d)!).push(a);
  }
  return { districts: toAreas(districts), upazilasByDistrict: byDistrict };
}

let loaded: Boundaries | undefined;
export const boundaries = (): Boundaries =>
  (loaded ??= buildBoundaries(JSON.parse(readFileSync(dataUrl("districts.json"), "utf8")), JSON.parse(readFileSync(dataUrl("upazilas.json"), "utf8"))));
/** Tests swap in a tiny dataset. */
export const setBoundaries = (b: Boundaries | undefined) => { loaded = b; };

const inRing = (x: number, y: number, ring: Ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPoly = (x: number, y: number, p: Poly) => inRing(x, y, p[0]!) && !p.slice(1).some((h) => inRing(x, y, h));
const inArea = (x: number, y: number, a: Area) => {
  const [x0, y0, x1, y1] = a.bbox;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && a.polys.some((p) => inPoly(x, y, p));
};

/** Distance in km from a point to the nearest edge of an area (equirectangular; fine at this scale). */
const edgeKm = (x: number, y: number, a: Area) => {
  const kx = 111.32 * Math.cos((y * Math.PI) / 180), ky = 110.57;
  let best = Infinity;
  for (const p of a.polys) {
    const r = p[0]!;
    for (let i = 0; i < r.length - 1; i++) {
      const [ax, ay] = r[i]!, [bx, by] = r[i + 1]!;
      const dx = (bx - ax) * kx, dy = (by - ay) * ky;
      const px = (x - ax) * kx, py = (y - ay) * ky;
      const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
    }
  }
  return best;
};

export interface Containing {
  district: string;
  upazila: string | null;
  /** true when the point sits outside every polygon but within `BORDER_KM` of one (simplified edges, shorelines). */
  nearBorder: boolean;
}
export const BORDER_KM = 2;

/** The district (and upazila, where we have a polygon for it) that CONTAINS the point; null outside Bangladesh. */
export function locate(lat: number, lng: number, b: Boundaries = boundaries()): Containing | null {
  let district = b.districts.find((a) => inArea(lng, lat, a));
  let nearBorder = false;
  if (!district) {
    const near = b.districts
      .filter((a) => lng >= a.bbox[0] - 0.03 && lng <= a.bbox[2] + 0.03 && lat >= a.bbox[1] - 0.03 && lat <= a.bbox[3] + 0.03)
      .map((a) => ({ a, d: edgeKm(lng, lat, a) }))
      .sort((p, q) => p.d - q.d)[0];
    if (!near || near.d > BORDER_KM) return null;
    district = near.a;
    nearBorder = true;
  }
  const name = district.key;
  const ups = b.upazilasByDistrict.get(name) ?? [];
  let up = ups.find((a) => inArea(lng, lat, a));
  if (!up && nearBorder) up = ups.map((a) => ({ a, d: edgeKm(lng, lat, a) })).sort((p, q) => p.d - q.d).find((x) => x.d <= BORDER_KM)?.a;
  return { district: name, upazila: up ? up.key.split("|")[1]! : null, nearBorder };
}
