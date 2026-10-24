/**
 * Who a toilet is for, derived from its present MALE / FEMALE / UNISEX features, and the "usable by"
 * filter behind `sex=MALE|FEMALE` on the map and list endpoints (API_CONTRACT.md).
 */
import type { Prisma } from '../generated/prisma/client.js';
import type { Feature, SurveySex } from '../generated/prisma/enums.js';

export type ToiletSex = SurveySex;
/** The `sex` query value: whose toilets to show. */
export type SexPreference = 'MALE' | 'FEMALE';

export const SEX_FEATURES = ['MALE', 'FEMALE', 'UNISEX'] as const satisfies readonly Feature[];

/**
 * UNISEX present -> UNISEX (it wins over a stray MALE/FEMALE, so nobody loses a toilet anyone may use);
 * MALE and not FEMALE -> MALE; FEMALE and not MALE -> FEMALE; anything else (both, neither) -> null.
 */
export function sexOf(present: readonly Feature[]): ToiletSex | null {
  const has = new Set(present);
  if (has.has('UNISEX')) return 'UNISEX';
  if (has.has('MALE') && !has.has('FEMALE')) return 'MALE';
  if (has.has('FEMALE') && !has.has('MALE')) return 'FEMALE';
  return null;
}

const other = (want: SexPreference): SexPreference => (want === 'MALE' ? 'FEMALE' : 'MALE');

/** Usable by `want`: its own sex, unisex or unknown. No preference keeps everything. */
export function usableBy(sex: ToiletSex | null, want: SexPreference | undefined): boolean {
  return !want || sex !== other(want);
}

/** Prisma where for `usableBy`: drop toilets that are only for the other sex (the inverse of `sexOf`). */
export function sexWhere(want: SexPreference): Prisma.ToiletWhereInput {
  const has = (feature: Feature) => ({ features: { some: { feature, present: true } } });
  const lacks = (feature: Feature) => ({ features: { none: { feature, present: true } } });
  return { NOT: { AND: [has(other(want)), lacks(want), lacks('UNISEX')] } };
}
