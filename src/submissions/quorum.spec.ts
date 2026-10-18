import { evaluateQuorum, type QuorumVote } from './quorum.js';

const v = (value: 'APPROVE' | 'REJECT', distanceM: number | null, role: QuorumVote['role'] = 'USER'): QuorumVote => ({
  value,
  distanceM,
  role,
});

describe('evaluateQuorum', () => {
  it('stays pending with one nearby peer approval for NEW_TOILET', () => {
    expect(evaluateQuorum('NEW_TOILET', [v('APPROVE', 20)])).toBeNull();
  });

  it('approves NEW_TOILET with two approvals within 150 m', () => {
    expect(evaluateQuorum('NEW_TOILET', [v('APPROVE', 20), v('APPROVE', 150)])).toBe('APPROVED');
  });

  it('ignores far-away or location-less approvals', () => {
    expect(evaluateQuorum('EDIT_TOILET', [v('APPROVE', 151), v('APPROVE', null), v('APPROVE', 10)])).toBeNull();
  });

  it('approves on one TRUSTED approval regardless of distance', () => {
    expect(evaluateQuorum('NEW_TOILET', [v('APPROVE', null, 'TRUSTED')])).toBe('APPROVED');
    expect(evaluateQuorum('EDIT_TOILET', [v('APPROVE', 5000, 'MODERATOR')])).toBe('APPROVED');
  });

  it('approves CLOSE_TOILET on a single nearby approval', () => {
    expect(evaluateQuorum('CLOSE_TOILET', [v('APPROVE', 100)])).toBe('APPROVED');
    expect(evaluateQuorum('CLOSE_TOILET', [v('APPROVE', 300)])).toBeNull();
  });

  it('rejects on any moderator reject, even with approvals', () => {
    expect(
      evaluateQuorum('NEW_TOILET', [v('APPROVE', 10), v('APPROVE', 10), v('REJECT', null, 'MODERATOR')]),
    ).toBe('REJECTED');
    expect(evaluateQuorum('NEW_TOILET', [v('REJECT', null, 'ADMIN')])).toBe('REJECTED');
  });

  it('moves to NEEDS_INFO on two peer rejects', () => {
    expect(evaluateQuorum('NEW_TOILET', [v('REJECT', 10)])).toBeNull();
    expect(evaluateQuorum('NEW_TOILET', [v('REJECT', 10), v('REJECT', null, 'TRUSTED')])).toBe('NEEDS_INFO');
  });

  it('approval quorum wins over peer rejects', () => {
    expect(
      evaluateQuorum('NEW_TOILET', [v('REJECT', 10), v('REJECT', 10), v('APPROVE', 10), v('APPROVE', 10)]),
    ).toBe('APPROVED');
  });
});
