import type { Role, SubmissionKind, VoteValue } from '../generated/prisma/enums.js';

/** Votes must be cast within this distance of the toilet to count toward the peer quorum. */
export const NEAR_VOTE_M = 150;

export interface QuorumVote {
  value: VoteValue;
  distanceM: number | null;
  role: Role;
}

export type QuorumOutcome = 'APPROVED' | 'REJECTED' | 'NEEDS_INFO' | null;

const isTrustedPlus = (r: Role) => r === 'TRUSTED' || r === 'MODERATOR' || r === 'ADMIN';
const isModeratorPlus = (r: Role) => r === 'MODERATOR' || r === 'ADMIN';

/**
 * Nearby approvals needed. A new toilet submitted on site (within 150 m of its pin) only needs one
 * other person there to confirm it (trust model v2, PLAN.md §12 E1); a remote one needs two.
 */
export function nearNeeded(kind: SubmissionKind, onSite = false): number {
  if (kind === 'CLOSE_TOILET') return 1;
  if (kind === 'NEW_TOILET' && onSite) return 1;
  return 2;
}

/** APPROVE votes cast within 150 m. */
export const nearApprovals = (votes: Pick<QuorumVote, 'value' | 'distanceM'>[]) =>
  votes.filter((v) => v.value === 'APPROVE' && v.distanceM !== null && v.distanceM <= NEAR_VOTE_M).length;

/**
 * Decide a submission from its votes (PLAN.md §6.1). Pure.
 * - any REJECT from MODERATOR+ → REJECTED (takes precedence)
 * - NEW_TOILET / EDIT_TOILET: 2 APPROVE within 150 m, or 1 APPROVE from TRUSTED+ → APPROVED
 * - NEW_TOILET submitted on site: 1 APPROVE within 150 m (a check-in counts) is enough
 * - CLOSE_TOILET: 1 APPROVE within 150 m, or 1 APPROVE from TRUSTED+ → APPROVED
 * - 2 REJECT from non-moderators → NEEDS_INFO
 * - otherwise null (stay as is)
 */
export function evaluateQuorum(
  kind: SubmissionKind,
  votes: QuorumVote[],
  opts: { onSite?: boolean } = {},
): QuorumOutcome {
  if (votes.some((v) => v.value === 'REJECT' && isModeratorPlus(v.role))) return 'REJECTED';
  const approves = votes.filter((v) => v.value === 'APPROVE');
  const near = nearApprovals(approves);
  const trusted = approves.filter((v) => isTrustedPlus(v.role)).length;
  const needNear = nearNeeded(kind, opts.onSite);
  if (trusted >= 1 || near >= needNear) return 'APPROVED';
  const peerRejects = votes.filter((v) => v.value === 'REJECT' && !isModeratorPlus(v.role)).length;
  if (peerRejects >= 2) return 'NEEDS_INFO';
  return null;
}
