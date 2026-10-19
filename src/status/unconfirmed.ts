/**
 * Anonymous closure reports (PLAN.md §12 E4). Pure.
 *
 * A signed-out "Closed" or "Broken" report could take a toilet out of routing, so on its own it is
 * shown as unconfirmed and ignored by ranking, pins and activeStatus. It starts to count once a
 * signed-in person confirms it ("Still true"), a signed-in person reports the same kind, or a second
 * device reports the same kind. Every other anonymous report counts straight away.
 */
import type { StatusKind } from '../generated/prisma/enums.js';

/** Kinds that can take a toilet out of routing (see routing/ranking.ts isBlocked). */
export const CLOSURE_KINDS: readonly StatusKind[] = ['CLOSED_NOW', 'BROKEN'];

export interface ReportIdentity {
  kind: StatusKind;
  userId: string | null;
  deviceId: string | null;
  confirmations: number;
}

/** `all` = the toilet's other unexpired reports (may include `r` itself). */
export function isUnconfirmed(r: ReportIdentity, all: readonly ReportIdentity[]): boolean {
  if (r.userId !== null || r.confirmations > 0 || !CLOSURE_KINDS.includes(r.kind)) return false;
  return !all.some(
    (o) =>
      o !== r &&
      o.kind === r.kind &&
      (o.userId !== null || (o.deviceId !== null && o.deviceId !== r.deviceId)),
  );
}

/** The reports that count toward activeStatus, pins and ranking. */
export function countedReports<T extends ReportIdentity>(reports: readonly T[]): T[] {
  return reports.filter((r) => !isUnconfirmed(r, reports));
}
