import { Module } from '@nestjs/common';
import { MediaController } from './media.controller.js';
import { MEDIA_STORAGE, MediaService, createStorageFromEnv } from './media.service.js';

@Module({
  controllers: [MediaController],
  providers: [{ provide: MEDIA_STORAGE, useFactory: createStorageFromEnv }, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
