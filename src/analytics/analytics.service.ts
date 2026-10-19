import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { PostHog } from 'posthog-node';
import { waitUntil } from '@vercel/functions';
import { env } from '../config/env.js';
import { hashTelegramId, type AnalyticsEvent } from './analytics.js';

/** Longest an event may hold up a response. Analytics never blocks or fails a contribution. */
const CAPTURE_TIMEOUT_MS = 800;

/**
 * Server-side PostHog events (GROWTH.md 0.1). A no-op without POSTHOG_KEY, so local dev and the
 * e2e suites send nothing. Uses captureImmediate: on Vercel the function may freeze after the
 * response, so batching would lose events.
 */
@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private readonly log = new Logger(AnalyticsService.name);
  private readonly client: PostHog | null = env.POSTHOG_KEY
    ? new PostHog(env.POSTHOG_KEY, { host: env.POSTHOG_HOST, flushAt: 1, flushInterval: 0, disableGeoip: true })
    : null;

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Resolves within CAPTURE_TIMEOUT_MS whatever PostHog does; errors are logged, never thrown. */
  async capture(event: AnalyticsEvent, distinctId: string, props: Record<string, unknown> = {}): Promise<void> {
    if (!this.client) return;
    const send = this.client
      .captureImmediate({ distinctId, event, properties: props })
      .catch((err: unknown) => this.log.warn(`capture ${event} failed: ${String(err)}`));
    await Promise.race([send, new Promise((r) => setTimeout(r, CAPTURE_TIMEOUT_MS))]);
  }

  /**
   * Fire and forget: the response does not wait. On Vercel, waitUntil keeps the function alive
   * until the event is sent; elsewhere the promise simply runs. Use this from request paths.
   */
  track(event: AnalyticsEvent, distinctId: string, props: Record<string, unknown> = {}): void {
    if (!this.client) return;
    waitUntil(this.capture(event, distinctId, props));
  }

  /** See analytics.ts hashTelegramId; keyed on AUTH_SECRET. */
  hashTelegramId(chatId: number | string): string {
    return hashTelegramId(chatId, env.AUTH_SECRET);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.shutdown();
  }
}
