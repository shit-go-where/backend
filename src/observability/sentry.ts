/**
 * Sentry error tracking (AUDIT_FINDINGS I-03, B-24). Errors only: no tracing, no profiling, no
 * PII (SDK v11 `dataCollection`, the successor of `sendDefaultPii: false`). Everything here is a no-op until SENTRY_DSN is set, so local dev and the test
 * suites send nothing.
 *
 * Privacy (PDPA): requests can carry the session cookie, the proxy secret, the phone's IP and,
 * in query strings, the user's coordinates. scrubEvent keeps the method, the path and a few
 * harmless headers, and drops everything else before an event leaves the process.
 */
import { HttpException } from '@nestjs/common';
import type { Breadcrumb, ErrorEvent, NodeOptions } from '@sentry/nestjs';

/** Headers worth keeping on an event. Everything else (cookie, authorization, x-sgw-*, IPs, ...) is dropped. */
const SAFE_HEADER_LIST = ['user-agent', 'content-type', 'content-length', 'accept', 'x-vercel-id'];
const SAFE_HEADERS = new Set(SAFE_HEADER_LIST);

/** `https://host/path?lat=1.3&lng=103.8#x` -> `https://host/path`. Also works on bare paths. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Removes query strings from every URL inside free text (log lines, error messages). */
function stripQueriesInText(text: string): string {
  return text.replace(/(\b(?:https?:\/\/|\/)[^\s?#"'`]*)[?#][^\s"'`]*/g, '$1');
}

export function scrubEvent<T extends ErrorEvent>(event: T): T {
  const req = event.request;
  if (req) {
    delete req.cookies;
    delete req.data;
    delete req.query_string;
    delete req.env;
    if (req.url) req.url = stripQuery(req.url);
    if (req.headers) {
      req.headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => SAFE_HEADERS.has(name.toLowerCase())),
      );
    }
  }
  // Keep only an opaque id, if anything ever sets one; never email or username. An explicit null IP
  // also stops Sentry from inferring one from the connection.
  event.user = { ...(event.user?.id === undefined ? {} : { id: event.user.id }), ip_address: null };
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const data = crumb.data ? { ...crumb.data } : undefined;
  if (data) {
    // http / fetch breadcrumbs: OneMap routing and search URLs carry coordinates and addresses.
    if (typeof data.url === 'string') data.url = stripQuery(data.url);
    delete data['http.query'];
    delete data['http.fragment'];
  }
  return {
    ...crumb,
    ...(data ? { data } : {}),
    ...(typeof crumb.message === 'string' ? { message: stripQueriesInText(crumb.message) } : {}),
  };
}

/**
 * True for errors worth an alert: anything that is not an HttpException or 4xx http-error, plus 5xx
 * (DB down, upstream outage, serialisation bug). 4xx are the client's problem and not reported.
 */
export function shouldReport(exception: unknown): boolean {
  if (exception instanceof HttpException) return exception.getStatus() >= 500;
  // HttpException from another copy of @nestjs/common: duck-type its status.
  if (
    typeof exception === 'object' &&
    exception !== null &&
    typeof (exception as { getStatus?: unknown }).getStatus === 'function' &&
    typeof (exception as { getResponse?: unknown }).getResponse === 'function'
  ) {
    const status = Number((exception as { getStatus: () => unknown }).getStatus());
    return !Number.isFinite(status) || status >= 500;
  }
  // http-errors from Express middleware (body-parser: malformed JSON 400, compressed body 415,
  // too large 413). `expose` is only set on 4xx, so a 5xx from there is still reported.
  if (
    typeof exception === 'object' &&
    exception !== null &&
    (exception as { expose?: unknown }).expose === true &&
    typeof (exception as { status?: unknown }).status === 'number'
  ) {
    return (exception as { status: number }).status >= 500;
  }
  return true;
}

/** Init options. `dsn` undefined means "do not init" (see instrument.ts). */
export function sentryOptions(source: NodeJS.ProcessEnv, dsn: string): NodeOptions {
  return {
    dsn,
    environment: source.VERCEL_ENV ?? source.NODE_ENV ?? 'development',
    release: source.VERCEL_GIT_COMMIT_SHA || undefined,
    // SDK v11 replaced `sendDefaultPii` with per-category switches whose defaults collect everything.
    // Turn each one off at the source; scrubEvent below is the second line of defence.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: SAFE_HEADER_LIST }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // Errors only, inside the free quota. tracesSampleRate is deliberately left unset rather than 0:
    // with 0 the SDK still loads its tracing integrations and builds (then discards) spans on every
    // request; unset, it creates none. Setting SENTRY_TRACES_SAMPLE_RATE would opt back in.
    tracesSampleRate: undefined,
    profileSessionSampleRate: 0,
    // Do not add sentry-trace / baggage headers to calls to OneMap, R2, PostHog or Telegram.
    tracePropagationTargets: [],
    // No load-time module rewriting: tracing is off, and the Vercel function loader has been
    // fragile with module hooks before (see src/common/throttle.ts). Errors reach Sentry through
    // SentryExceptionFilter and the uncaught-exception handlers, which need no hooks.
    enableRuntimeChannelInjection: false,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  };
}
