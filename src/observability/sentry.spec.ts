import { BadRequestException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ErrorEvent } from '@sentry/nestjs';
import { scrubBreadcrumb, scrubEvent, sentryOptions, shouldReport, stripQuery } from './sentry.js';

describe('stripQuery', () => {
  it('drops query strings and fragments', () => {
    expect(stripQuery('https://api.example.com/toilets/nearby?lat=1.29&lng=103.84')).toBe(
      'https://api.example.com/toilets/nearby',
    );
    expect(stripQuery('/route?from=1.3,103.8#x')).toBe('/route');
    expect(stripQuery('/health')).toBe('/health');
  });
});

describe('scrubEvent', () => {
  const event = (): ErrorEvent =>
    ({
      type: undefined,
      request: {
        method: 'GET',
        url: 'https://api.example.com/toilets/nearby?lat=1.2993&lng=103.8455',
        query_string: 'lat=1.2993&lng=103.8455',
        cookies: { sgw_session: 'secret' },
        data: { email: 'a@b.c' },
        env: { REMOTE_ADDR: '1.2.3.4' },
        headers: {
          cookie: 'sgw_session=secret',
          authorization: 'Bearer x',
          'x-sgw-proxy-secret': 'shh',
          'x-sgw-client-ip': '1.2.3.4',
          'x-forwarded-for': '1.2.3.4',
          'x-real-ip': '1.2.3.4',
          'x-cron-secret': 'cron',
          referer: 'https://shitgowhere.com/?lat=1.3',
          'User-Agent': 'Mozilla/5.0',
          'content-type': 'application/json',
          'x-vercel-id': 'sin1::abc',
        },
      },
      user: { ip_address: '1.2.3.4', email: 'a@b.c' },
      breadcrumbs: [
        { category: 'http', data: { url: 'https://www.onemap.gov.sg/api/routing?start=1.3,103.8', 'http.query': 'start=1.3,103.8' } },
        { category: 'console', message: 'GET /toilets/nearby?lat=1.3&lng=103.8 failed' },
      ],
    }) as ErrorEvent;

  it('removes cookies, body, query strings, env and unsafe headers', () => {
    const out = scrubEvent(event());
    expect(out.request).toEqual({
      method: 'GET',
      url: 'https://api.example.com/toilets/nearby',
      headers: { 'User-Agent': 'Mozilla/5.0', 'content-type': 'application/json', 'x-vercel-id': 'sin1::abc' },
    });
  });

  it('keeps at most an opaque user id and pins the IP to null', () => {
    expect(scrubEvent(event()).user).toEqual({ ip_address: null });
    const withId = { ...event(), user: { id: 'u1', ip_address: '1.2.3.4' } } as ErrorEvent;
    expect(scrubEvent(withId).user).toEqual({ id: 'u1', ip_address: null });
  });

  it('strips coordinates from breadcrumbs', () => {
    const [http, log] = scrubEvent(event()).breadcrumbs!;
    expect(http.data).toEqual({ url: 'https://www.onemap.gov.sg/api/routing' });
    expect(log.message).toBe('GET /toilets/nearby failed');
  });

  it('handles events without a request', () => {
    const plain = { message: 'boom' } as ErrorEvent;
    expect(scrubEvent(plain)).toEqual({ message: 'boom', user: { ip_address: null } });
  });
});

describe('scrubBreadcrumb', () => {
  it('does not mutate the input', () => {
    const crumb = { data: { url: '/a?b=1' } };
    scrubBreadcrumb(crumb);
    expect(crumb.data.url).toBe('/a?b=1');
  });
});

describe('shouldReport', () => {
  it('reports unexpected errors and 5xx, not 4xx', () => {
    expect(shouldReport(new Error('boom'))).toBe(true);
    expect(shouldReport('string thrown')).toBe(true);
    expect(shouldReport(new ServiceUnavailableException())).toBe(true);
    expect(shouldReport(new HttpException('x', 500))).toBe(true);
    expect(shouldReport(new BadRequestException())).toBe(false);
    expect(shouldReport(new NotFoundException())).toBe(false);
    expect(shouldReport(new HttpException('slow down', 429))).toBe(false);
  });

  it('duck-types HttpExceptions from another @nestjs/common copy', () => {
    const foreign = (status: number) => ({ getStatus: () => status, getResponse: () => ({}) });
    expect(shouldReport(foreign(404))).toBe(false);
    expect(shouldReport(foreign(502))).toBe(true);
  });
});

describe('sentryOptions', () => {
  it('is errors-only, PII-free, tagged with the Vercel env and commit', () => {
    const o = sentryOptions({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'abc123', NODE_ENV: 'production' }, 'https://k@o1.ingest.us.sentry.io/1');
    expect(o).toMatchObject({
      dsn: 'https://k@o1.ingest.us.sentry.io/1',
      environment: 'preview',
      release: 'abc123',
      tracePropagationTargets: [],
    });
    expect(o.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      httpHeaders: { response: false },
    });
    expect(o.tracesSampleRate).toBeUndefined();
    expect(o.beforeSend).toBeTypeOf('function');
  });

  it('falls back to NODE_ENV and no release off Vercel', () => {
    const o = sentryOptions({ NODE_ENV: 'development' }, 'dsn');
    expect(o.environment).toBe('development');
    expect(o.release).toBeUndefined();
  });
});
