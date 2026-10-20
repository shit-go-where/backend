/**
 * Photo read URLs. The bucket is private: the API never hands out an object-store URL in JSON.
 * Every PhotoRef points at the API's own read route (`GET /media/photos/:id[/thumb]`, through the
 * frontend's `/api` rewrite), which checks who may see the photo and then redirects to a
 * short-lived presigned GET (or, with local dev storage, streams the file).
 *
 * The JSON URLs are stable, so toilet pages, the service worker's saved API answers and any
 * server-side cache can keep them as long as they like; only the redirect expires.
 */
import type { User } from '../generated/prisma/client.js';
import { Role, type SubmissionState } from '../generated/prisma/enums.js';
import { hasRole } from '../common/auth/auth.guard.js';
import { OPEN_STATES } from '../submissions/resolution.js';
import type { PhotoRef } from './media.dto.js';

export type PhotoVariant = 'full' | 'thumb';

/** Browser path of a photo (relative to the site origin, like every other `/api` call). */
export function photoPath(id: string, variant: PhotoVariant = 'full'): string {
  const base = `/api/media/photos/${encodeURIComponent(id)}`;
  return variant === 'thumb' ? `${base}/thumb` : base;
}

/** `thumbUrl` in the row only says whether a thumbnail exists; its stored value is not used. */
export function toPhotoRef(p: { id: string; thumbUrl: string | null }): PhotoRef {
  return { id: p.id, url: photoPath(p.id), thumbUrl: p.thumbUrl ? photoPath(p.id, 'thumb') : null };
}

/** The small image for a list card: the thumbnail, else the full photo. */
export function photoThumbPath(p: { id: string; thumbUrl: string | null }): string {
  return p.thumbUrl ? photoPath(p.id, 'thumb') : photoPath(p.id);
}

export interface PhotoAccessRow {
  confirmed: boolean;
  approved: boolean;
  uploadedById: string;
  submission: { state: SubmissionState; resolution: string | null } | null;
}

/**
 * Who may get a read URL. Mirrors where the API already lists the photo:
 * - approved: everyone;
 * - not yet approved: the uploader, TRUSTED+ (they work the photo queue, GET /admin/photos/pending),
 *   and any signed-in reviewer while the photo's submission is open and not `escalated_flagged`
 *   (SubmissionsService.toView `seesUnapproved`);
 * - unconfirmed uploads (still under tmp/): nobody.
 */
export function canViewPhoto(photo: PhotoAccessRow, viewer: Pick<User, 'id' | 'role'> | null): boolean {
  if (!photo.confirmed) return false;
  if (photo.approved) return true;
  if (!viewer) return false;
  if (viewer.id === photo.uploadedById) return true;
  if (hasRole(viewer, Role.TRUSTED)) return true;
  const s = photo.submission;
  return !!s && OPEN_STATES.includes(s.state) && s.resolution !== 'escalated_flagged';
}

/**
 * Presigned reads are signed for a fixed time window instead of "now", so every request in the
 * same window gets the same URL and the browser's image cache keeps working. A URL signed at the
 * start of a window stays valid for two windows, so whatever is handed out is good for at least
 * one more window; the redirect itself may be cached until the window ends (`maxAgeS`).
 */
export const PUBLIC_READ_WINDOW_S = 3600;
/** Unapproved photos: shorter-lived URLs and the redirect is never cached. */
export const PRIVATE_READ_WINDOW_S = 300;

export function readWindow(nowMs: number, windowS: number) {
  const nowS = Math.floor(nowMs / 1000);
  const startS = nowS - (nowS % windowS);
  return {
    signedAt: new Date(startS * 1000),
    expiresInS: 2 * windowS,
    maxAgeS: Math.max(1, startS + windowS - nowS),
  };
}
