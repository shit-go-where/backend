/**
 * Pure ranking for "route me to a toilet" (PLAN.md §3). Lower cost = better; the API exposes
 * `score = round(100 * (1 - cost))`, so higher score = better.
 */
import type { Feature, StatusKind, ToiletTier } from '../generated/prisma/enums.js';

export interface RankWeights {
  distance: number;
  cleanliness: number;
  issues: number;
  tier: number;
  freshness: number;
}

export const DEFAULT_WEIGHTS: RankWeights = {
  distance: 0.45,
  cleanliness: 0.25,
  issues: 0.15,
  tier: 0.08,
  freshness: 0.07,
};

/** Urgent: distance dominates, soft preferences (cleanliness/freshness) mostly ignored. */
export const URGENT_WEIGHTS: RankWeights = {
  distance: 0.85,
  cleanliness: 0,
  issues: 0.1,
  tier: 0.05,
  freshness: 0,
};

/** Used when a toilet has no cleanliness data at all. Neutral-ish, slightly below average. */
export const NEUTRAL_CLEANLINESS = 6;
const ISSUE_PENALTY: Partial<Record<StatusKind, number>> = {
  NO_PAPER: 0.5,
  NO_SOAP: 0.3,
  LONG_QUEUE: 0.4,
  BEING_CLEANED: 0.2,
  BROKEN: 0.6, // only reaches ranking when unconfirmed (confirmed BROKEN is a hard filter)
};
const TIER_PENALTY: Record<ToiletTier, number> = { VERIFIED: 0, COMMUNITY: 0.4, IMPORTED: 1 };
/** Age at which staleness saturates. */
const STALE_DAYS = 730;
const DAY_MS = 86_400_000;

export interface RankReport {
  kind: StatusKind;
  createdAt: Date;
  confirmations: number;
}

export interface RankCandidate {
  id: string;
  /** Straight-line metres. */
  distanceM: number;
  scoreCleanliness: number | null;
  tier: ToiletTier;
  source: string;
  lastVerifiedAt: Date | null;
  features: Feature[];
  /** Unexpired reports. */
  reports: RankReport[];
}

/** Unexpired CLOSED_NOW or BROKEN with >= 1 confirmation, or 2+ reports of that kind. */
export function isBlocked(reports: RankReport[]): boolean {
  for (const kind of ['CLOSED_NOW', 'BROKEN'] as const) {
    const rs = reports.filter((r) => r.kind === kind);
    if (rs.length >= 2 || rs.some((r) => r.confirmations >= 1)) return true;
  }
  return false;
}

export function issuePenalty(reports: RankReport[]): number {
  const kinds = new Set(reports.map((r) => r.kind));
  let p = 0;
  for (const k of kinds) p += ISSUE_PENALTY[k] ?? 0;
  return Math.min(1, p);
}

/** Straight-line distance * detour factor; matches estimateWalkSeconds' assumption. */
export const walkingMetres = (straightM: number) => Math.round(straightM * 1.3);

export function cost(c: RankCandidate, radiusM: number, w: RankWeights, now: Date): number {
  const total = w.distance + w.cleanliness + w.issues + w.tier + w.freshness || 1;
  // Normalised by the search radius (walking detour factor cancels out).
  const dist = Math.min(1, c.distanceM / radiusM);
  const clean = (10 - (c.scoreCleanliness ?? NEUTRAL_CLEANLINESS)) / 10;
  const issues = issuePenalty(c.reports);
  const tier = TIER_PENALTY[c.tier];
  const stale = c.lastVerifiedAt
    ? Math.min(1, Math.max(0, now.getTime() - c.lastVerifiedAt.getTime()) / (STALE_DAYS * DAY_MS))
    : 1;
  return (
    (w.distance * dist +
      w.cleanliness * clean +
      w.issues * issues +
      w.tier * tier +
      w.freshness * stale) /
    total
  );
}

export function toScore(c: number): number {
  return Math.round(100 * (1 - c));
}

/** Merge user weight overrides (distance/cleanliness/freshness) onto defaults. */
export function resolveWeights(
  urgent: boolean,
  overrides?: { distance?: number; cleanliness?: number; freshness?: number },
): RankWeights {
  if (urgent) return URGENT_WEIGHTS;
  return { ...DEFAULT_WEIGHTS, ...stripUndefined(overrides ?? {}) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const STATUS_TEXT: Partial<Record<StatusKind, string>> = {
  NO_PAPER: 'no paper',
  NO_SOAP: 'no soap',
  LONG_QUEUE: 'long queue',
  BEING_CLEANED: 'being cleaned',
  BROKEN: 'broken',
  CLOSED_NOW: 'closed',
  ALL_GOOD: 'all good',
};

const FEATURE_TEXT: Partial<Record<Feature, string>> = {
  BIDET: 'Bidet',
  ACCESSIBLE: 'Accessible',
  BABY_CHANGE: 'Baby change',
  NURSING_ROOM: 'Nursing room',
  SITTING: 'Sitting toilet',
  SQUAT: 'Squat toilet',
  FREE: 'Free',
  SHOWER: 'Shower',
  TOILET_PAPER: 'Toilet paper',
  HAND_SOAP: 'Soap',
  UNISEX: 'Unisex',
  AMBULANT: 'Ambulant',
  CHILD: 'Child-friendly',
};
/** Features worth calling out even if not required. */
const HIGHLIGHT: Feature[] = ['BIDET', 'ACCESSIBLE', 'BABY_CHANGE'];

export function ago(from: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} h ago`;
}

export function minutesText(walkSeconds: number): string {
  return `${Math.max(1, Math.round(walkSeconds / 60))} min walk`;
}

function tierText(c: Pick<RankCandidate, 'tier' | 'source' | 'lastVerifiedAt'>): string | null {
  if (c.tier === 'VERIFIED') {
    if (c.source === 'FIELDWORK_2024') return 'Verified 2024 survey';
    return c.lastVerifiedAt ? `Verified ${c.lastVerifiedAt.getUTCFullYear()}` : 'Verified';
  }
  if (c.tier === 'COMMUNITY') return 'Community verified';
  if (c.source === 'OSM') return 'From OpenStreetMap';
  return 'Imported, unverified';
}

/** Human-readable reasons, most important first. */
export function reasons(
  c: RankCandidate,
  walkSeconds: number,
  required: Feature[],
  now: Date,
): string[] {
  const out = [minutesText(walkSeconds)];
  const shown = new Set<Feature>();
  for (const f of [...required, ...HIGHLIGHT]) {
    if (!shown.has(f) && c.features.includes(f)) {
      shown.add(f);
      out.push(FEATURE_TEXT[f] ?? f);
    }
  }
  if (c.scoreCleanliness !== null) out.push(`Clean ${c.scoreCleanliness.toFixed(1)}/10`);
  // Latest report per kind, newest first.
  const latest = new Map<StatusKind, Date>();
  for (const r of c.reports) {
    const cur = latest.get(r.kind);
    if (!cur || r.createdAt > cur) latest.set(r.kind, r.createdAt);
  }
  for (const [kind, at] of [...latest].sort((a, b) => b[1].getTime() - a[1].getTime())) {
    out.push(`Reported: ${STATUS_TEXT[kind] ?? kind} ${ago(at, now)}`);
  }
  const t = tierText(c);
  if (t) out.push(t);
  return out;
}

export interface Ranked<C extends RankCandidate> {
  candidate: C;
  cost: number;
  score: number;
}

/** Drops blocked candidates and sorts by cost (ties: nearer first). */
export function rank<C extends RankCandidate>(
  candidates: C[],
  radiusM: number,
  w: RankWeights,
  now: Date,
): Ranked<C>[] {
  return candidates
    .filter((c) => !isBlocked(c.reports))
    .map((c) => {
      const k = cost(c, radiusM, w, now);
      return { candidate: c, cost: k, score: toScore(k) };
    })
    .sort((a, b) => a.cost - b.cost || a.candidate.distanceM - b.candidate.distanceM);
}
