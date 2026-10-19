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

/**
 * Soft preferences for why someone is going (see purposes.ts). Nothing is filtered out: missing
 * features only add cost, because most toilets have no record of them at all.
 */
export interface RankNeeds {
  /** Feature -> relative importance. */
  prefer: Partial<Record<Feature, number>>;
  /** Weight of the preference term, on the same scale as RankWeights. */
  weight: number;
  /** Overrides for the default issue penalties (no paper barely matters for a quick pee). */
  issues?: Partial<Record<StatusKind, number>>;
}

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

export function issuePenalty(
  reports: RankReport[],
  overrides?: Partial<Record<StatusKind, number>>,
): number {
  const table = overrides ? { ...ISSUE_PENALTY, ...overrides } : ISSUE_PENALTY;
  const kinds = new Set(reports.map((r) => r.kind));
  let p = 0;
  for (const k of kinds) p += table[k] ?? 0;
  return Math.min(1, p);
}

/** Share of preferred importance the toilet is missing: 0 = has everything, 1 = has none. */
export function needPenalty(features: Feature[], prefer: RankNeeds['prefer']): number {
  const entries = Object.entries(prefer) as [Feature, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return 0;
  const have = new Set(features);
  return entries.reduce((s, [f, w]) => s + (have.has(f) ? 0 : w), 0) / total;
}

/** Straight-line distance * detour factor; matches estimateWalkSeconds' assumption. */
export const walkingMetres = (straightM: number) => Math.round(straightM * 1.3);

export function cost(c: RankCandidate, radiusM: number, w: RankWeights, now: Date, needs?: RankNeeds): number {
  const needW = needs?.weight ?? 0;
  const total = w.distance + w.cleanliness + w.issues + w.tier + w.freshness + needW || 1;
  // Normalised by the search radius (walking detour factor cancels out).
  const dist = Math.min(1, c.distanceM / radiusM);
  const clean = (10 - (c.scoreCleanliness ?? NEUTRAL_CLEANLINESS)) / 10;
  const issues = issuePenalty(c.reports, needs?.issues);
  const need = needs ? needPenalty(c.features, needs.prefer) : 0;
  const tier = TIER_PENALTY[c.tier];
  const stale = c.lastVerifiedAt
    ? Math.min(1, Math.max(0, now.getTime() - c.lastVerifiedAt.getTime()) / (STALE_DAYS * DAY_MS))
    : 1;
  return (
    (w.distance * dist +
      w.cleanliness * clean +
      w.issues * issues +
      w.tier * tier +
      w.freshness * stale +
      needW * need) /
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
  HAND_DRYER: 'Hand dryer',
  SANITARY_BIN: 'Sanitary bin',
  PERIOD_PRODUCTS: 'Pads or tampons',
  MIRROR: 'Mirror',
  WATER_REFILL: 'Water refill',
  ABLUTION: 'Ablution area',
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
  preferred: Feature[] = [],
): string[] {
  const out = [minutesText(walkSeconds)];
  const shown = new Set<Feature>();
  for (const f of [...required, ...preferred, ...HIGHLIGHT]) {
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
  needs?: RankNeeds,
): Ranked<C>[] {
  return candidates
    .filter((c) => !isBlocked(c.reports))
    .map((c) => {
      const k = cost(c, radiusM, w, now, needs);
      return { candidate: c, cost: k, score: toScore(k) };
    })
    .sort((a, b) => a.cost - b.cost || a.candidate.distanceM - b.candidate.distanceM);
}

/**
 * Urgent results, re-ordered once the real walking times are in. Ranking runs on straight-line distance, so a
 * toilet across a road can rank above one that is a shorter walk; urgent mode promises the nearest, so it sorts
 * by the walk minutes people will see, and keeps the ranking (cleaner, better trusted) within the same minute.
 */
export function byWalkMinutes<T extends { walkSeconds: number; score: number }>(items: T[]): T[] {
  const mins = (s: number) => Math.max(1, Math.round(s / 60));
  return [...items].sort((a, b) => mins(a.walkSeconds) - mins(b.walkSeconds) || b.score - a.score);
}
