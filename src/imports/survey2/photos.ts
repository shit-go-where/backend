/**
 * `survey2:photos`: the expanded survey's Google Drive photo links (219, column "Photos?") -> Photo rows.
 * Behind a flag and NOT run yet: today every link needs a Google sign-in, so `--dry-run` (the default)
 * only reports which links are shared. `--run` downloads the shared ones through
 * `https://drive.google.com/uc?export=download&id=`, re-encodes them like an app upload (EXIF/GPS
 * stripped, 400 px webp thumbnail), stores them with the photo storage the API uses (R2 / local
 * uploads) and links an approved Photo to the toilet, owned by the placeholder survey user.
 *
 * Idempotent: the Photo id is `survey2-<Drive file id>`; an existing one is skipped.
 */
import sharp from 'sharp';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { loadFieldwork2024b, loadSurvey2Matches, type Fieldwork2024b, type Survey2Matches } from '../curated/schema.js';
import { getDb } from '../lib/db.js';
import { politeFetch } from '../lib/http.js';
import { driveFileId } from './parse.js';

/** The account the imported photos belong to (brief decision 7). No Google login: googleSub stays null. */
export const SURVEY_USER = {
  email: 'survey-2024@shitgowhere.com',
  handle: 'toiletsurvey2024',
  displayName: 'u/eggmayosandwich',
  leaderboardOptIn: false,
  verifierCredit: false,
} as const;

/** Same processing as MediaService.confirm (src/media/media.service.ts). */
const THUMB_WIDTH = 400;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_BYTES = 25 * 1024 * 1024;

export const driveDownloadUrl = (id: string) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;

export interface PhotoPlanItem {
  /** Sheet row of the survey (Survey.raw._row). */
  row: string;
  surveyKey: string;
  /** survey2 toilet the row belongs to. */
  toiletKey: string;
  /** The DB toilet that gets the photo: the pilot toilet for an attached row, else the survey2 toilet. */
  targetToiletKey: string;
  driveId: string;
  url: string;
  photoId: string;
}

/** One entry per Drive link in the curated file (rows without a parsable id are reported, not planned). */
export function planPhotos(fw: Fieldwork2024b, matches: Survey2Matches | null): { items: PhotoPlanItem[]; unparsable: string[] } {
  const items: PhotoPlanItem[] = [];
  const unparsable: string[] = [];
  for (const t of fw.toilets) {
    if (!t.photoUrl) continue;
    const id = driveFileId(t.photoUrl);
    const s = t.surveys[0]!;
    if (!id) {
      unparsable.push(`${t.sourceKey}: ${t.photoUrl}`);
      continue;
    }
    items.push({
      row: typeof s.raw['_row'] === 'string' ? s.raw['_row'] : '',
      surveyKey: s.key,
      toiletKey: t.sourceKey,
      targetToiletKey: matches?.attach[t.sourceKey]?.pilotToiletSourceKey ?? t.sourceKey,
      driveId: id,
      url: t.photoUrl,
      photoId: `survey2-${id}`,
    });
  }
  return { items, unparsable };
}

export type DriveProbe =
  | { status: 'image'; contentType: string; body: Buffer }
  | { status: 'not-shared'; detail: string }
  | { status: 'not-found'; detail: string }
  | { status: 'not-image'; detail: string }
  | { status: 'error'; detail: string };

/**
 * Drive answers an unshared file with Google's sign-in page (a redirect to accounts.google.com /
 * ServiceLogin, HTML) instead of the bytes: that is "not shared", never something to store.
 */
export function isDriveSignIn(finalUrl: string, contentType: string | null, bodyStart: string): boolean {
  let host = '';
  try {
    host = new URL(finalUrl).host;
  } catch {
    /* relative or empty URL: judge by the body */
  }
  if (host === 'accounts.google.com') return true;
  if (!/text\/html/i.test(contentType ?? '') && !/^\s*</.test(bodyStart)) return false;
  return /accounts\.google\.com|ServiceLogin|<title>\s*Sign[ -]in|identifier\?|signin\/v2/i.test(bodyStart);
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => politeFetch(url, { ...init, redirect: 'follow', minIntervalMs: 400, retries: 2, timeoutMs: 60_000 });

export async function probeDrivePhoto(id: string, fetchImpl: FetchLike = defaultFetch): Promise<DriveProbe> {
  let res: Response;
  try {
    res = await fetchImpl(driveDownloadUrl(id), { redirect: 'follow' });
  } catch (err) {
    return { status: 'error', detail: (err as Error).message };
  }
  const contentType = res.headers.get('content-type');
  if (res.status === 404) return { status: 'not-found', detail: 'HTTP 404' };
  if (res.status === 401 || res.status === 403) return { status: 'not-shared', detail: `HTTP ${res.status}` };
  const body = Buffer.from(await res.arrayBuffer());
  const start = body.subarray(0, 4096).toString('utf8');
  if (isDriveSignIn(res.url, contentType, start)) return { status: 'not-shared', detail: 'Drive answered with the Google sign-in page' };
  if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}` };
  if (!/^image\//i.test(contentType ?? '')) {
    // Large public files get a "can't scan for viruses" HTML page; photos should never be that big.
    return { status: 'not-image', detail: `content-type ${contentType ?? 'none'}${/^\s*</.test(start) ? ' (an HTML page)' : ''}` };
  }
  if (body.length > MAX_BYTES) return { status: 'not-image', detail: `${body.length} bytes is too large for a photo` };
  return { status: 'image', contentType: contentType!, body };
}

/** The placeholder user, created on first use (by email). */
export async function ensureSurveyUser(db: PrismaClient): Promise<string> {
  const u = await db.user.upsert({
    where: { email: SURVEY_USER.email },
    create: { ...SURVEY_USER },
    update: {},
    select: { id: true },
  });
  return u.id;
}

export interface PhotosOptions {
  run: boolean;
  fetchImpl?: FetchLike;
  /** For tests: skip loading files. */
  fw?: Fieldwork2024b;
  matches?: Survey2Matches | null;
  log?: (line: string) => void;
}

export interface PhotosReport {
  mode: 'dry-run' | 'run';
  links: number;
  byStatus: Record<string, number>;
  unparsable: string[];
  stored: string[];
  skippedExisting: string[];
  missingToilet: string[];
}

export async function runSurvey2Photos(opts: PhotosOptions): Promise<PhotosReport> {
  const out = opts.log ?? ((l: string) => console.log(l));
  const fw = opts.fw ?? loadFieldwork2024b();
  const matches = opts.matches === undefined ? loadSurvey2Matches() : opts.matches;
  const { items, unparsable } = planPhotos(fw, matches);
  const report: PhotosReport = { mode: opts.run ? 'run' : 'dry-run', links: items.length + unparsable.length, byStatus: {}, unparsable, stored: [], skippedExisting: [], missingToilet: [] };
  out(`  ${report.links} Drive link(s), ${report.mode}${opts.run ? '' : ' (nothing is stored; pass --run to import shared photos)'}`);

  let db: PrismaClient | null = null;
  let userId: string | null = null;
  let storage: Awaited<ReturnType<typeof loadStorage>> | null = null;
  for (const it of items) {
    const p = await probeDrivePhoto(it.driveId, opts.fetchImpl);
    report.byStatus[p.status] = (report.byStatus[p.status] ?? 0) + 1;
    out(`  row ${it.row.padStart(3)} ${it.toiletKey.padEnd(28)} ${p.status}${p.status === 'image' ? ` ${p.contentType} ${p.body.length} B` : ` (${p.detail})`}`);
    if (!opts.run || p.status !== 'image') continue;

    db ??= getDb();
    storage ??= await loadStorage();
    const toilet = await db.toilet.findUnique({ where: { sourceKey: it.targetToiletKey }, select: { id: true } });
    if (!toilet) {
      report.missingToilet.push(it.targetToiletKey);
      continue;
    }
    if (await db.photo.findUnique({ where: { id: it.photoId }, select: { id: true } })) {
      report.skippedExisting.push(it.photoId);
      continue;
    }
    userId ??= await ensureSurveyUser(db);
    let full: Buffer;
    let thumb: Buffer;
    try {
      const base = sharp(p.body, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
      full = await base.clone().jpeg({ quality: 85 }).toBuffer();
      thumb = await base.clone().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    } catch (err) {
      report.byStatus['unreadable'] = (report.byStatus['unreadable'] ?? 0) + 1;
      out(`    could not decode: ${(err as Error).message}`);
      continue;
    }
    const key = `photos/${it.photoId}.jpg`;
    await storage.put(key, full, 'image/jpeg');
    await storage.put(`thumbs/${it.photoId}.webp`, thumb, 'image/webp');
    await db.photo.create({
      data: {
        id: it.photoId,
        key,
        // Stable API read paths, as MediaService.confirm writes them (src/media/photo-urls.ts photoPath).
        url: `/api/media/photos/${it.photoId}`,
        thumbUrl: `/api/media/photos/${it.photoId}/thumb`,
        contentType: 'image/jpeg',
        toiletId: toilet.id,
        uploadedById: userId,
        confirmed: true,
        approved: true,
      },
    });
    report.stored.push(it.photoId);
  }
  out(JSON.stringify({ ...report, stored: report.stored.length, skippedExisting: report.skippedExisting.length }, null, 2));
  return report;
}

/** The API's photo storage (R2 when configured, else backend/uploads), loaded only for --run. */
async function loadStorage() {
  const { createStorageFromEnv } = await import('../../media/storage-env.js');
  return createStorageFromEnv();
}
