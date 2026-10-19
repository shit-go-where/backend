import { Module } from '@nestjs/common';
import { env } from '../../config/env.js';
import { RoutingModule } from '../../routing/routing.module.js';
import { GamificationModule } from '../../gamification/gamification.module.js';
import { StatusModule } from '../../status/status.module.js';
import { TelegramController } from './telegram.controller.js';
import { TelegramService } from './telegram.service.js';
import { ChatsService } from './chats.service.js';

/** True when TELEGRAM_BOT_TOKEN is set. */
export const telegramEnabled = () => Boolean(env.TELEGRAM_BOT_TOKEN);

const enabled = telegramEnabled();

/**
 * The Telegram bot (BOT.md). With TELEGRAM_BOT_TOKEN unset it registers nothing: no webhook route,
 * no bot, no Telegram calls (same pattern as S3 and OneMap). Prisma and analytics are global.
 */
@Module({
  imports: enabled ? [RoutingModule, GamificationModule, StatusModule] : [],
  controllers: enabled ? [TelegramController] : [],
  providers: enabled ? [ChatsService, TelegramService] : [],
  exports: enabled ? [TelegramService] : [],
})
export class TelegramModule {}
