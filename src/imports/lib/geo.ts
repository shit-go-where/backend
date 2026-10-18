/** Singapore bounding box used to validate every coordinate we import. */
export const SG_BBOX = { minLat: 1.13, maxLat: 1.48, minLng: 103.59, maxLng: 104.1 } as const;

export function inSingapore(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= SG_BBOX.minLat &&
    lat <= SG_BBOX.maxLat &&
    lng >= SG_BBOX.minLng &&
    lng <= SG_BBOX.maxLng
  );
}

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** GeoJSON position order: [lng, lat]. */
export type Position = [number, number] | number[];
export type Ring = Position[];

/** Ray casting: is the point inside the ring? Points exactly on an edge may go either way. */
export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Polygon = outer ring + holes. */
export function pointInPolygon(lng: number, lat: number, polygon: Ring[]): boolean {
  if (!polygon.length || !pointInRing(lng, lat, polygon[0]!)) return false;
  for (const hole of polygon.slice(1)) if (pointInRing(lng, lat, hole)) return false;
  return true;
}

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Ring[];
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Ring[][];
}
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry | { type: string; coordinates?: unknown };

export function pointInGeometry(lng: number, lat: number, geom: AreaGeometry): boolean {
  if (geom.type === 'Polygon') return pointInPolygon(lng, lat, (geom as PolygonGeometry).coordinates);
  if (geom.type === 'MultiPolygon')
    return (geom as MultiPolygonGeometry).coordinates.some((p) => pointInPolygon(lng, lat, p));
  return false;
}

/** Simple grid index for "everything within N metres" lookups over a few thousand points. */
export class PointIndex<T extends { lat: number; lng: number }> {
  private cells = new Map<string, T[]>();
  // ~0.005 deg ~ 550 m cells; queries up to a few hundred metres scan 3x3 cells.
  constructor(private readonly cellDeg = 0.005) {}
  private key(lat: number, lng: number) {
    return `${Math.floor(lat / this.cellDeg)}:${Math.floor(lng / this.cellDeg)}`;
  }
  add(item: T): void {
    const k = this.key(item.lat, item.lng);
    const arr = this.cells.get(k);
    if (arr) arr.push(item);
    else this.cells.set(k, [item]);
  }
  remove(item: T): void {
    const arr = this.cells.get(this.key(item.lat, item.lng));
    if (!arr) return;
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  }
  /** Items within `radiusM`, nearest first, with distances. */
  near(lat: number, lng: number, radiusM: number): { item: T; distanceM: number }[] {
    const span = Math.ceil(radiusM / 111_000 / this.cellDeg) + 0;
    const ci = Math.floor(lat / this.cellDeg);
    const cj = Math.floor(lng / this.cellDeg);
    const out: { item: T; distanceM: number }[] = [];
    for (let di = -span - 1; di <= span + 1; di++)
      for (let dj = -span - 1; dj <= span + 1; dj++) {
        const arr = this.cells.get(`${ci + di}:${cj + dj}`);
        if (!arr) continue;
        for (const item of arr) {
          const d = haversineM(lat, lng, item.lat, item.lng);
          if (d <= radiusM) out.push({ item, distanceM: d });
        }
      }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }
}
