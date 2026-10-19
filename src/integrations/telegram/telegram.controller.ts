import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Update } from 'grammy/types';
import { env } from '../../config/env.js';
import { secretMatches } from '../../admin/cron-secret.guard.js';
import { SkipThrottle } from '../../common/throttle.js';
import { TelegramService } from './telegram.service.js';

/**
 * Telegram webhook (BOT.md §6). Telegram sends the secret registered by `pnpm cli telegram:setup`
 * in X-Telegram-Bot-Api-Secret-Token. Not part of the public API, so it is left out of the spec.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('integrations/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Post()
  @HttpCode(200)
  async webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() body: unknown) {
    const expected = env.TELEGRAM_WEBHOOK_SECRET;
    // Fail closed: without a configured secret anyone could post fake updates.
    if (!expected) throw new ServiceUnavailableException('TELEGRAM_WEBHOOK_SECRET is not configured');
    if (!secretMatches(secret, expected)) throw new UnauthorizedException('Invalid Telegram secret');
    if (!body || typeof body !== 'object' || typeof (body as { update_id?: unknown }).update_id !== 'number') {
      return; // Not an update; 200 so Telegram does not retry it.
    }
    // Handler errors are caught inside the bot, so Telegram always gets its 200 and never retries
    // forever. The reply is sent before this resolves, inside the function's time budget.
    await this.telegram.handleUpdate(body as Update);
  }
}
