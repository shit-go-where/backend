/** Stable resolution codes for submissions, with the plain-English text the app shows. Pure. */
import type { SubmissionState } from '../generated/prisma/enums.js';

export const RESOLUTION_TEXT = {
  auto_on_site_photo: 'Live straight away: added on site with a photo.',
  confirmed_on_site: 'Confirmed by someone who checked in there.',
  community_approved: 'Approved by people nearby.',
  trusted_approved: 'Approved by a trusted reviewer.',
  moderator_approved: 'Approved by a moderator.',
  moderator_rejected: 'Rejected by a moderator.',
  moderator_needs_info: 'A moderator asked for more information.',
  peer_needs_info: 'Two reviewers think something is off. Add more detail and resubmit.',
  escalated_expired: 'Nobody nearby confirmed it in time, so a moderator will review it.',
  escalated_flagged: 'Two people flagged this toilet, so a moderator will review it.',
  expired: 'Expired before anyone confirmed it.',
} as const;
export type ResolutionCode = keyof typeof RESOLUTION_TEXT;
export const RESOLUTION_CODES = Object.keys(RESOLUTION_TEXT) as [ResolutionCode, ...ResolutionCode[]];

/** Free-text resolutions written before codes existed (the migration converts stored ones too). */
const LEGACY: Record<string, ResolutionCode> = {
  'Approved by community vote': 'community_approved',
  'Rejected by moderator vote': 'moderator_rejected',
  'Two reviewers rejected it; more info needed': 'peer_needs_info',
  'Expired without quorum': 'expired',
};

const isCode = (s: string): s is ResolutionCode => s in RESOLUTION_TEXT;

/** Stable code + plain-English text for a stored resolution. Pure. */
export function resolutionOf(
  stored: string | null,
  state: SubmissionState,
): { code: ResolutionCode | null; text: string | null } {
  if (!stored) return { code: null, text: null };
  let code: ResolutionCode | null = isCode(stored) ? stored : (LEGACY[stored] ?? null);
  if (!code) {
    // Anything else was a moderator's note.
    if (state === 'APPROVED') code = 'moderator_approved';
    else if (state === 'REJECTED') code = 'moderator_rejected';
    else if (state === 'NEEDS_INFO') code = 'moderator_needs_info';
  }
  return { code, text: code ? RESOLUTION_TEXT[code] : null };
}
