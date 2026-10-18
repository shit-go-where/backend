/** Geo helpers. No PostGIS: bbox prefilter in SQL, haversine for exact distance. */

export const SG_BBOX = { minLat: 1.13, maxLat: 1.48, minLng: 103.59, maxLng: 104.1 } as const;

export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Bounding box around a point for a radius in metres. */
export function bboxAround(p: LatLng, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(toRad(p.lat)));
  return {
    minLat: p.lat - dLat,
    maxLat: p.lat + dLat,
    minLng: p.lng - dLng,
    maxLng: p.lng + dLng,
  };
}

export function inSingapore(p: LatLng): boolean {
  return (
    p.lat >= SG_BBOX.minLat &&
    p.lat <= SG_BBOX.maxLat &&
    p.lng >= SG_BBOX.minLng &&
    p.lng <= SG_BBOX.maxLng
  );
}

/** Rough walking time at 1.25 m/s with a 1.3 detour factor on straight-line distance. */
export function estimateWalkSeconds(straightLineM: number): number {
  return Math.round((straightLineM * 1.3) / 1.25);
}
