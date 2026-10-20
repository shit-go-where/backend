import {
  PRIVATE_READ_WINDOW_S,
  PUBLIC_READ_WINDOW_S,
  canViewPhoto,
  photoPath,
  photoThumbPath,
  readWindow,
  toPhotoRef,
  type PhotoAccessRow,
} from './photo-urls.js';

describe('photo URLs', () => {
  it('points every PhotoRef at the API read route, never at the bucket', () => {
    expect(toPhotoRef({ id: 'p1', thumbUrl: 'https://img.example.com/thumbs/p1.webp' })).toEqual({
      id: 'p1',
      url: '/api/media/photos/p1',
      thumbUrl: '/api/media/photos/p1/thumb',
    });
    expect(toPhotoRef({ id: 'p2', thumbUrl: null })).toEqual({ id: 'p2', url: '/api/media/photos/p2', thumbUrl: null });
    expect(photoThumbPath({ id: 'p1', thumbUrl: 'x' })).toBe('/api/media/photos/p1/thumb');
    expect(photoThumbPath({ id: 'p2', thumbUrl: null })).toBe('/api/media/photos/p2');
    expect(photoPath('a/b')).toBe('/api/media/photos/a%2Fb');
  });
});

describe('readWindow', () => {
  it('signs at the window start, valid two windows, cacheable until the window ends', () => {
    const now = Date.parse('2026-10-20T10:59:59Z');
    expect(readWindow(now, PUBLIC_READ_WINDOW_S)).toEqual({
      signedAt: new Date('2026-10-20T10:00:00Z'),
      expiresInS: 7200,
      maxAgeS: 1,
    });
    // Whatever moment it is handed out, the URL outlives its cache lifetime by at least a window.
    for (const t of ['2026-10-20T10:00:00Z', '2026-10-20T10:30:00Z', '2026-10-20T10:59:59Z']) {
      const w = readWindow(Date.parse(t), PUBLIC_READ_WINDOW_S);
      const validUntil = w.signedAt.getTime() + w.expiresInS * 1000;
      const cachedUntil = Date.parse(t) + w.maxAgeS * 1000;
      expect(validUntil - cachedUntil).toBeGreaterThanOrEqual(PUBLIC_READ_WINDOW_S * 1000);
    }
    expect(readWindow(Date.parse('2026-10-20T10:07:00Z'), PRIVATE_READ_WINDOW_S)).toEqual({
      signedAt: new Date('2026-10-20T10:05:00Z'),
      expiresInS: 600,
      maxAgeS: 180,
    });
  });
});

describe('canViewPhoto', () => {
  const row = (p: Partial<PhotoAccessRow> = {}): PhotoAccessRow => ({
    confirmed: true,
    approved: false,
    uploadedById: 'owner',
    submission: null,
    ...p,
  });
  const u = (id: string, role: 'USER' | 'TRUSTED' | 'MODERATOR' | 'ADMIN' = 'USER') => ({ id, role });

  it('approved photos are public', () => {
    expect(canViewPhoto(row({ approved: true }), null)).toBe(true);
  });

  it('unconfirmed uploads are never readable', () => {
    expect(canViewPhoto(row({ confirmed: false, approved: true }), u('owner', 'ADMIN'))).toBe(false);
    expect(canViewPhoto(row({ confirmed: false }), u('owner'))).toBe(false);
  });

  it('pending photos: uploader and TRUSTED+ only', () => {
    expect(canViewPhoto(row(), null)).toBe(false);
    expect(canViewPhoto(row(), u('x'))).toBe(false);
    expect(canViewPhoto(row(), u('owner'))).toBe(true);
    expect(canViewPhoto(row(), u('x', 'TRUSTED'))).toBe(true);
    expect(canViewPhoto(row(), u('x', 'ADMIN'))).toBe(true);
  });

  it('pending photos of an open, unflagged submission: any signed-in reviewer', () => {
    for (const state of ['PENDING', 'NEEDS_INFO', 'ESCALATED'] as const) {
      expect(canViewPhoto(row({ submission: { state, resolution: null } }), u('x'))).toBe(true);
    }
    expect(canViewPhoto(row({ submission: { state: 'PENDING', resolution: null } }), null)).toBe(false);
    expect(canViewPhoto(row({ submission: { state: 'ESCALATED', resolution: 'escalated_flagged' } }), u('x'))).toBe(false);
    expect(canViewPhoto(row({ submission: { state: 'APPROVED', resolution: 'approved_votes' } }), u('x'))).toBe(false);
    expect(canViewPhoto(row({ submission: { state: 'REJECTED', resolution: null } }), u('x'))).toBe(false);
  });
});
