/**
 * "Near" hints for places without an address, so an unnamed imported toilet still says where it is
 * ("120 m from Tampines MRT"). Same rule as the area pages (areas.service.ts): the closest named
 * place (any type but OTHER) within 1.5 km, in any planning area.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import { bboxAround, haversineM, type LatLng } from '../common/geo.js';

export const NEAR_MAX_M = 1500;

/** "40 m", "120 m", "1.2 km". Pure. */
export function distanceText(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(Math.round(m / 100) / 10).toFixed(1)} km`;
}

/** "120 m from Tampines MRT", or null when nothing named is within 1.5 km. */
export async function nearText(
  prisma: PrismaClient,
  venue: { id: string; latitude: number; longitude: number },
): Promise<string | null> {
  const at: LatLng = { lat: venue.latitude, lng: venue.longitude };
  const bb = bboxAround(at, NEAR_MAX_M);
  const places = await prisma.venue.findMany({
    where: {
      id: { not: venue.id },
      type: { not: 'OTHER' },
      latitude: { gte: bb.minLat, lte: bb.maxLat },
      longitude: { gte: bb.minLng, lte: bb.maxLng },
    },
    select: { name: true, latitude: true, longitude: true },
  });
  let best: { name: string; d: number } | null = null;
  for (const p of places) {
    const d = haversineM(at, { lat: p.latitude, lng: p.longitude });
    if (d <= NEAR_MAX_M && (!best || d < best.d)) best = { name: p.name, d };
  }
  return best ? `${distanceText(best.d)} from ${best.name}` : null;
}
