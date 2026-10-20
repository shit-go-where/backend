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
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '../common/throttle.js';
import { ZodResponse } from 'nestjs-zod';
import type { Request, Response } from 'express';
import { AuthGuard, CurrentUser, OptionalAuthGuard } from '../common/auth/auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { MAX_UPLOAD_BYTES, MediaPhotoRefDto, PresignDto, PresignResultDto } from './media.dto.js';
import { MediaService, type PhotoRead } from './media.service.js';

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
    return this.media.presign(user.id, body.contentType, body.size);
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
  // Each confirm downloads and re-encodes an image with sharp: CPU and memory per call.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ZodResponse({ type: MediaPhotoRefDto })
  confirm(@CurrentUser() user: User, @Param('id') id: string) {
    return this.media.confirm(user.id, id);
  }

  /**
   * Photo reads (the bucket is private). Every PhotoRef `url`/`thumbUrl` points here. Approved
   * photos: anyone. Unapproved: the uploader, TRUSTED+, and signed-in reviewers of an open
   * submission (photo-urls.ts canViewPhoto). Everything else, including raw tmp/ uploads: 404.
   * The answer is a 302 to a presigned GET (R2/S3), or the file itself with local dev storage.
   */
  @Get('photos/:id')
  @UseGuards(OptionalAuthGuard)
  // One request per <img>; a toilet page can show dozens. Cheap (one indexed read + an HMAC).
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read a photo: 302 to a short-lived presigned URL' })
  @ApiFoundResponse({ description: 'Location: presigned GET, valid for at least the Cache-Control max-age' })
  @ApiOkResponse({ description: 'The image itself (local dev storage only)' })
  @ApiNotFoundResponse({ description: 'No such photo, or not visible to this viewer' })
  async photo(@CurrentUser({ optional: true }) user: User | null, @Param('id') id: string, @Res() res: Response) {
    this.send(res, await this.media.readPhoto(user, id, 'full'));
  }

  @Get('photos/:id/thumb')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read a photo thumbnail (400 px webp): 302 to a short-lived presigned URL' })
  @ApiFoundResponse({ description: 'Location: presigned GET, valid for at least the Cache-Control max-age' })
  @ApiOkResponse({ description: 'The image itself (local dev storage only)' })
  @ApiNotFoundResponse({ description: 'No such photo or thumbnail, or not visible to this viewer' })
  async thumb(@CurrentUser({ optional: true }) user: User | null, @Param('id') id: string, @Res() res: Response) {
    this.send(res, await this.media.readPhoto(user, id, 'thumb'));
  }

  private send(res: Response, read: PhotoRead) {
    res.setHeader('Cache-Control', read.cacheControl);
    if (read.kind === 'redirect') {
      res.redirect(302, read.url);
      return;
    }
    res.sendFile(
      read.path,
      {
        dotfiles: 'deny',
        headers: { 'Content-Type': read.contentType, 'X-Content-Type-Options': 'nosniff' },
      },
      (err) => {
        if (err && !res.headersSent) {
          res.setHeader('Cache-Control', 'no-store');
          res.status(404).json({ statusCode: 404, message: 'Not Found' });
        }
      },
    );
  }
}
