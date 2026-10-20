import { NotFoundException, ServiceUnavailableException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

const sentry = vi.hoisted(() => ({
  isInitialized: vi.fn(() => true),
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
}));
const vercel = vi.hoisted(() => ({ waitUntil: vi.fn() }));
vi.mock('@sentry/nestjs', () => sentry);
vi.mock('@vercel/functions', () => vercel);

const { SentryExceptionFilter } = await import('./sentry-exception.filter.js');

describe('SentryExceptionFilter', () => {
  const host = {} as ArgumentsHost;
  let base: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sentry.isInitialized.mockReturnValue(true);
    base = vi.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
  });
  afterEach(() => base.mockRestore());

  it('reports unexpected errors, flushes via waitUntil, then responds as Nest would', () => {
    const err = new Error('boom');
    new SentryExceptionFilter().catch(err, host);
    expect(sentry.captureException).toHaveBeenCalledWith(err, expect.anything());
    expect(sentry.flush).toHaveBeenCalled();
    expect(vercel.waitUntil).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledWith(err, host);
  });

  it('reports 5xx HttpExceptions', () => {
    new SentryExceptionFilter().catch(new ServiceUnavailableException(), host);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('does not report 4xx', () => {
    const err = new NotFoundException();
    new SentryExceptionFilter().catch(err, host);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(vercel.waitUntil).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledWith(err, host);
  });

  it('sends nothing when Sentry is not initialised (no SENTRY_DSN)', () => {
    sentry.isInitialized.mockReturnValue(false);
    new SentryExceptionFilter().catch(new Error('boom'), host);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalled();
  });
});
