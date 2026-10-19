import { evaluateQuorum, nearNeeded } from './quorum.js';
import { pathOf, shouldAutoPublish, stillNeeded } from './resolution.js';
import { resolutionOf } from './resolution-codes.js';

describe('shouldAutoPublish (trust model v2)', () => {
  const ok = { onSite: true, hasPhoto: true, autoPublishedToday: 0, rejectedRecently: false };

  it('publishes an on-site toilet with a photo at once', () => {
    expect(shouldAutoPublish(ok)).toBe(true);
  });

  it('needs both on site and a photo', () => {
    expect(shouldAutoPublish({ ...ok, onSite: false })).toBe(false);
    expect(shouldAutoPublish({ ...ok, hasPhoto: false })).toBe(false);
  });

  it('allows 3 auto-publishes a day, then falls back to waiting for a check-in', () => {
    expect(shouldAutoPublish({ ...ok, autoPublishedToday: 2 })).toBe(true);
    expect(shouldAutoPublish({ ...ok, autoPublishedToday: 3 })).toBe(false);
  });

  it('pauses auto-publish after a recent rejection', () => {
    expect(shouldAutoPublish({ ...ok, rejectedRecently: true })).toBe(false);
  });
});

describe('paths and what is still needed', () => {
  const base = { kind: 'NEW_TOILET' as const, onSite: false, autoPublished: false, state: 'PENDING' as const, resolution: null };

  it('picks the path', () => {
    expect(pathOf({ ...base, autoPublished: true, onSite: true })).toBe('auto');
    expect(pathOf({ ...base, onSite: true })).toBe('on_site_check_in');
    expect(pathOf(base)).toBe('nearby_quorum');
    expect(pathOf({ ...base, kind: 'EDIT_TOILET', onSite: true })).toBe('nearby_quorum');
  });

  it('counts down nearby confirmations', () => {
    expect(stillNeeded(base, 0)).toBe(2);
    expect(stillNeeded(base, 1)).toBe(1);
    expect(stillNeeded({ ...base, onSite: true }, 0)).toBe(1);
    expect(stillNeeded({ ...base, onSite: true }, 1)).toBe(0);
    expect(stillNeeded({ ...base, kind: 'CLOSE_TOILET' }, 0)).toBe(1);
  });

  it('needs nothing once decided, when auto-published, or while a moderator reviews a flagged one', () => {
    expect(stillNeeded({ ...base, state: 'APPROVED' }, 0)).toBe(0);
    expect(stillNeeded({ ...base, autoPublished: true }, 0)).toBe(0);
    expect(stillNeeded({ ...base, state: 'ESCALATED', resolution: 'escalated_flagged' }, 0)).toBe(0);
    // Expired and escalated: a nearby confirmation still settles it.
    expect(stillNeeded({ ...base, state: 'ESCALATED', resolution: 'escalated_expired' }, 0)).toBe(2);
  });
});

describe('quorum for on-site new toilets', () => {
  it('one nearby approval (a check-in counts) is enough', () => {
    expect(nearNeeded('NEW_TOILET', true)).toBe(1);
    expect(evaluateQuorum('NEW_TOILET', [{ value: 'APPROVE', distanceM: 30, role: 'USER' }], { onSite: true })).toBe(
      'APPROVED',
    );
    expect(evaluateQuorum('NEW_TOILET', [{ value: 'APPROVE', distanceM: 30, role: 'USER' }])).toBeNull();
  });

  it('a far approval still does not count', () => {
    expect(evaluateQuorum('NEW_TOILET', [{ value: 'APPROVE', distanceM: 400, role: 'USER' }], { onSite: true })).toBeNull();
  });
});

describe('resolutionOf', () => {
  it('maps codes to text', () => {
    expect(resolutionOf('auto_on_site_photo', 'APPROVED')).toEqual({
      code: 'auto_on_site_photo',
      text: 'Live straight away: added on site with a photo.',
    });
    expect(resolutionOf(null, 'PENDING')).toEqual({ code: null, text: null });
  });

  it('maps legacy free text', () => {
    expect(resolutionOf('Expired without quorum', 'EXPIRED').code).toBe('expired');
    expect(resolutionOf('Approved by community vote', 'APPROVED').code).toBe('community_approved');
    expect(resolutionOf('Two reviewers rejected it; more info needed', 'NEEDS_INFO').code).toBe('peer_needs_info');
  });

  it('treats any other old text as a moderator decision', () => {
    expect(resolutionOf('Looks right', 'APPROVED').code).toBe('moderator_approved');
    expect(resolutionOf('Not public', 'REJECTED').code).toBe('moderator_rejected');
    expect(resolutionOf('Which level?', 'NEEDS_INFO').code).toBe('moderator_needs_info');
  });
});
