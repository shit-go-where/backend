import { logLevels } from './log-levels.js';

describe('logLevels', () => {
  it('keeps only errors and warnings in production', () => {
    expect(logLevels('production', undefined)).toEqual(['error', 'warn']);
    expect(logLevels('development', 'production')).toEqual(['error', 'warn']);
  });

  it('keeps the route-mapping log elsewhere', () => {
    expect(logLevels('development', undefined)).toEqual(['error', 'warn', 'log']);
    expect(logLevels('test', undefined)).toEqual(['error', 'warn', 'log']);
  });
});
