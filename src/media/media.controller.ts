import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiCookieAuth,
  ApiExcludeEndpoint,
  ApiNoContentResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ZodResponse } from 'nestjs-zod';
import type { Request, Response } from 'express';
import { AuthGuard, CurrentUser } from '../common/auth/auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { MAX_UPLOAD_BYTES, MediaPhotoRefDto, PresignDto, PresignResultDto } from './media.dto.js';
import { MediaService } from './media.service.js';
import { LocalStorage, contentTypeForKey, isSafeKey } from './storage.js';

/** Reads a raw request body up to `limit` bytes (image/* is not consumed by Nest's parsers). */
export async function readRawBody(req: Request, limit: number): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > limit) throw new PayloadTooLargeException('Max 5 MB');
    return req.body;
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeException('Max 5 MB');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > limit) throw new PayloadTooLargeException('Max 5 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('presign')
  @HttpCode(200)
  @ApiCookieAuth()
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ZodResponse({ type: PresignResultDto })
  presign(@CurrentUser() user: User, @Body() body: PresignDto) {
    return this.media.presign(user.id, body.contentType);
  }

  /** Dev fallback only (no S3 configured): stands in for the presigned PUT. */
  @Put(':id/upload')
  @HttpCode(204)
  @ApiCookieAuth()
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiConsumes('image/jpeg', 'image/png', 'image/webp')
  @ApiNoContentResponse({ description: 'Stored (local dev storage only)' })
  async upload(@CurrentUser() user: User, @Param('id') id: string, @Req() req: Request) {
    if (!this.media.isLocal) throw new NotFoundException();
    const body = await readRawBody(req, MAX_UPLOAD_BYTES);
    await this.media.uploadLocal(user.id, id, req.headers['content-type'], body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @ApiCookieAuth()
  @UseGuards(AuthGuard)
  @ZodResponse({ type: MediaPhotoRefDto })
  confirm(@CurrentUser() user: User, @Param('id') id: string) {
    return this.media.confirm(user.id, id);
  }

  /** Dev fallback only: serves files stored under backend/uploads. */
  @Get('files/*key')
  @ApiExcludeEndpoint()
  files(@Req() req: Request, @Res() res: Response) {
    const storage = this.media.storage;
    if (!(storage instanceof LocalStorage)) throw new NotFoundException();
    const raw = (req.params as Record<string, string | string[]>).key;
    const key = Array.isArray(raw) ? raw.join('/') : raw;
    if (!key || !isSafeKey(key) || key.startsWith('tmp/')) throw new NotFoundException();
    res.sendFile(
      storage.path(key),
      {
        dotfiles: 'deny',
        headers: {
          'Content-Type': contentTypeForKey(key) ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=3600',
        },
      },
      (err) => {
        if (err && !res.headersSent) res.status(404).json({ statusCode: 404, message: 'Not Found' });
      },
    );
  }
}
