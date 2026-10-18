
import { cachedDatagovGeojson, DATAGOV_IDS, featureAttributes } from '../lib/datagov.js';
import { pointInGeometry, type AreaGeometry } from '../lib/geo.js';
import type { CacheMode } from '../lib/http.js';
import { paths } from '../lib/paths.js';

export interface PlanningAreaIndex {
  lookup(lat: number, lng: number): string | null;
  size: number;
}

interface Fc {
  features: { properties: Record<string, unknown>; geometry: AreaGeometry }[];
}

/** Planning area name from a feature: PLN_AREA_N, directly or inside the HTML Description. */
export function planningAreaName(props: Record<string, unknown>): string | null {
  const attrs = featureAttributes(props);
  const n = attrs['PLN_AREA_N'] ?? attrs['PLN_AREA_NAME'] ?? null;
  return n ? titleCase(n) : null;
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Build a point-in-polygon index; bbox prefilter keeps 55 polygons cheap. */
export function buildPlanningAreaIndex(fc: Fc): PlanningAreaIndex {
  const areas = fc.features
    .map((f) => {
      const name = planningAreaName(f.properties);
      const coords: number[][] = [];
      const walk = (x: unknown) => {
        if (Array.isArray(x) && typeof x[0] === 'number') coords.push(x as number[]);
        else if (Array.isArray(x)) x.forEach(walk);
      };
      walk((f.geometry as { coordinates?: unknown }).coordinates);
      const lngs = coords.map((c) => c[0]!);
      const lats = coords.map((c) => c[1]!);
      return {
        name,
        geometry: f.geometry,
        bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] as const,
      };
    })
    .filter((a) => a.name);
  return {
    size: areas.length,
    lookup(lat, lng) {
      for (const a of areas) {
        if (lng < a.bbox[0] || lat < a.bbox[1] || lng > a.bbox[2] || lat > a.bbox[3]) continue;
        if (pointInGeometry(lng, lat, a.geometry)) return a.name;
      }
      return null;
    },
  };
}

let cached: PlanningAreaIndex | undefined;

/** Master Plan 2019 Planning Area Boundary (No Sea), cached at data/raw/datagov/planning-area-2019.geojson. */
export async function loadPlanningAreas(mode: CacheMode = {}): Promise<PlanningAreaIndex> {
  if (cached && !mode.refresh) return cached;
  const fc = await cachedDatagovGeojson<Fc>(DATAGOV_IDS.planningArea2019, paths.planningAreaGeojson, mode);
  cached = buildPlanningAreaIndex(fc);
  return cached;
}

