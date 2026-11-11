const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Rounds a coordinate to roughly 1 km (0.01°) — the most precision we ever persist, and only with the user's consent. */
export const roundCoarse = (v: number) => Math.round(v * 100) / 100;
