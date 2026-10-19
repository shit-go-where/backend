import { countedReports, isUnconfirmed, type ReportIdentity } from './unconfirmed.js';

const anon = (kind: ReportIdentity['kind'], deviceId: string, confirmations = 0): ReportIdentity => ({
  kind,
  userId: null,
  deviceId,
  confirmations,
});
const signedIn = (kind: ReportIdentity['kind'], userId: string): ReportIdentity => ({
  kind,
  userId,
  deviceId: null,
  confirmations: 0,
});

describe('anonymous closure reports', () => {
  it('a lone anonymous Closed or Broken report is unconfirmed and not counted', () => {
    const r = anon('CLOSED_NOW', 'd1');
    expect(isUnconfirmed(r, [r])).toBe(true);
    expect(countedReports([r, anon('BROKEN', 'd1')])).toEqual([]);
  });

  it('other anonymous kinds count straight away', () => {
    const r = anon('NO_PAPER', 'd1');
    expect(isUnconfirmed(r, [r])).toBe(false);
    expect(countedReports([r])).toEqual([r]);
  });

  it('signed-in reports always count', () => {
    const r = signedIn('CLOSED_NOW', 'u1');
    expect(countedReports([r])).toEqual([r]);
  });

  it('a signed-in report of the same kind confirms it', () => {
    const a = anon('CLOSED_NOW', 'd1');
    const u = signedIn('CLOSED_NOW', 'u1');
    expect(countedReports([a, u])).toEqual([a, u]);
    expect(isUnconfirmed(a, [a, signedIn('NO_PAPER', 'u1')])).toBe(true);
  });

  it('a second device confirms it; the same device twice does not', () => {
    const a = anon('CLOSED_NOW', 'd1');
    expect(countedReports([a, anon('CLOSED_NOW', 'd1')])).toEqual([]);
    const b = anon('CLOSED_NOW', 'd2');
    expect(countedReports([a, b])).toEqual([a, b]);
  });

  it('a "Still true" confirmation confirms it', () => {
    const a = anon('BROKEN', 'd1', 1);
    expect(countedReports([a])).toEqual([a]);
  });
});
