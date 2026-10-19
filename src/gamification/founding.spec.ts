import { FOUNDING_BADGE_ID, FOUNDING_MAX, earnedBadgeIds, type BadgeStats } from './badges.js';

describe('founding contributor badge', () => {
  const base: BadgeStats = { checkIns: [], lineStations: {}, approvedSubmissions: 0, reviews: 0, approvedPhotos: 0, role: 'USER' };
  const checkedIn = { ...base, checkIns: [{ toiletId: 't', venueId: 'v', createdAt: new Date() }] };

  it('needs a contribution', () => {
    expect(earnedBadgeIds({ ...base, foundingHolders: 0 })).not.toContain(FOUNDING_BADGE_ID);
  });

  it('goes to a check-in or an approved submission while slots are left', () => {
    expect(earnedBadgeIds({ ...checkedIn, foundingHolders: FOUNDING_MAX - 1 })).toContain(FOUNDING_BADGE_ID);
    expect(earnedBadgeIds({ ...base, approvedSubmissions: 1, foundingHolders: 0 })).toContain(FOUNDING_BADGE_ID);
  });

  it('stops after the first 100 accounts', () => {
    expect(earnedBadgeIds({ ...checkedIn, foundingHolders: FOUNDING_MAX })).not.toContain(FOUNDING_BADGE_ID);
  });
});
