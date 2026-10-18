import type { Role } from '../generated/prisma/enums.js';
import { longestSgtDayStreak, sgtHour } from './sgt.js';

/** MRT line codes as stored in Venue.lines. */
export const MRT_LINES = ['NSL', 'EWL', 'CCL', 'DTL', 'NEL', 'TEL'] as const;
export type MrtLine = (typeof MRT_LINES)[number];

export type BadgeRule =
  | { type: 'checkIns'; min: number }
  | { type: 'distinctToilets'; min: number }
  | { type: 'distinctVenues'; min: number }
  | { type: 'lineComplete'; line: MrtLine }
  | { type: 'approvedSubmissions'; min: number }
  | { type: 'reviews'; min: number }
  | { type: 'approvedPhotos'; min: number }
  | { type: 'checkInBetweenSgtHours'; fromHour: number; toHour: number }
  | { type: 'checkInStreakDays'; min: number }
  | { type: 'minRole'; role: Role };

export interface BadgeDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  rule: BadgeRule;
}

const LINE_NAMES: Record<MrtLine, string> = {
  NSL: 'North-South Line',
  EWL: 'East-West Line',
  CCL: 'Circle Line',
  DTL: 'Downtown Line',
  NEL: 'North East Line',
  TEL: 'Thomson-East Coast Line',
};

export const BADGES: BadgeDef[] = [
  { id: 'first-flush', name: 'First Flush', description: 'Checked in at a toilet for the first time.', icon: '🚽', rule: { type: 'checkIns', min: 1 } },
  { id: 'regular', name: 'Regular', description: 'Checked in 10 times.', icon: '🧻', rule: { type: 'checkIns', min: 10 } },
  { id: 'explorer', name: 'Explorer', description: 'Checked in at 10 different toilets.', icon: '🧭', rule: { type: 'distinctToilets', min: 10 } },
  { id: 'island-hopper', name: 'Island Hopper', description: 'Checked in at 25 different venues.', icon: '🏝️', rule: { type: 'distinctVenues', min: 25 } },
  ...MRT_LINES.map(
    (line): BadgeDef => ({
      id: `line-${line.toLowerCase()}`,
      name: `${line} Collector`,
      description: `Stamped every station with toilets on the ${LINE_NAMES[line]}.`,
      icon: '🚇',
      rule: { type: 'lineComplete', line },
    }),
  ),
  { id: 'first-contribution', name: 'First Contribution', description: 'Had a submission approved.', icon: '📍', rule: { type: 'approvedSubmissions', min: 1 } },
  { id: 'cartographer', name: 'Cartographer', description: 'Had 10 submissions approved.', icon: '🗺️', rule: { type: 'approvedSubmissions', min: 10 } },
  { id: 'critic', name: 'Critic', description: 'Wrote 10 reviews.', icon: '📝', rule: { type: 'reviews', min: 10 } },
  { id: 'shutterbug', name: 'Shutterbug', description: 'Had 5 photos approved.', icon: '📸', rule: { type: 'approvedPhotos', min: 5 } },
  { id: 'night-owl', name: 'Night Owl', description: 'Checked in between midnight and 5 am.', icon: '🦉', rule: { type: 'checkInBetweenSgtHours', fromHour: 0, toHour: 5 } },
  { id: 'streak-7', name: 'Seven-Day Streak', description: 'Checked in on 7 consecutive days.', icon: '🔥', rule: { type: 'checkInStreakDays', min: 7 } },
  { id: 'trusted', name: 'Trusted', description: 'Earned trusted reviewer status.', icon: '🛡️', rule: { type: 'minRole', role: 'TRUSTED' } },
];

export interface BadgeStats {
  checkIns: { createdAt: Date; toiletId: string; venueId: string }[];
  /** For each line: venue ids of all MRT stations with toilets on that line. */
  lineStations: Partial<Record<MrtLine, string[]>>;
  approvedSubmissions: number;
  reviews: number;
  approvedPhotos: number;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = { USER: 0, TRUSTED: 1, MODERATOR: 2, ADMIN: 3 };

/** Whether a single rule is satisfied. Pure. */
export function ruleSatisfied(rule: BadgeRule, s: BadgeStats): boolean {
  switch (rule.type) {
    case 'checkIns':
      return s.checkIns.length >= rule.min;
    case 'distinctToilets':
      return new Set(s.checkIns.map((c) => c.toiletId)).size >= rule.min;
    case 'distinctVenues':
      return new Set(s.checkIns.map((c) => c.venueId)).size >= rule.min;
    case 'lineComplete': {
      const stations = s.lineStations[rule.line] ?? [];
      if (stations.length === 0) return false;
      const visited = new Set(s.checkIns.map((c) => c.venueId));
      return stations.every((id) => visited.has(id));
    }
    case 'approvedSubmissions':
      return s.approvedSubmissions >= rule.min;
    case 'reviews':
      return s.reviews >= rule.min;
    case 'approvedPhotos':
      return s.approvedPhotos >= rule.min;
    case 'checkInBetweenSgtHours':
      return s.checkIns.some((c) => {
        const h = sgtHour(c.createdAt);
        return h >= rule.fromHour && h < rule.toHour;
      });
    case 'checkInStreakDays':
      return longestSgtDayStreak(s.checkIns.map((c) => c.createdAt)) >= rule.min;
    case 'minRole':
      return ROLE_RANK[s.role] >= ROLE_RANK[rule.role];
  }
}

/** Ids of every badge whose rule the stats satisfy. Pure. */
export function earnedBadgeIds(s: BadgeStats, defs: BadgeDef[] = BADGES): string[] {
  return defs.filter((b) => ruleSatisfied(b.rule, s)).map((b) => b.id);
}
