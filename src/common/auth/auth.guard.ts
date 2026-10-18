import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { User } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';
import { SESSION_COOKIE, verifySessionToken } from './session.js';

export type AuthedRequest = Request & { user?: User };

const ROLE_RANK: Record<Role, number> = {
  USER: 0,
  TRUSTED: 1,
  MODERATOR: 2,
  ADMIN: 3,
};

export function hasRole(user: Pick<User, 'role'>, min: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}

async function loadUser(req: AuthedRequest, prisma: PrismaService): Promise<User | null> {
  if (req.user) return req.user;
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  const session = verifySessionToken(token);
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.uid } });
  // Sessions are stateless, so a cookie issued before DELETE /me must stop working here.
  if (!user || user.deletedAt) return null;
  req.user = user;
  return user;
}

/** Requires a signed-in user. Use with @CurrentUser(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const user = await loadUser(ctx.switchToHttp().getRequest<AuthedRequest>(), this.prisma);
    if (!user) throw new UnauthorizedException('Sign in required');
    return true;
  }
}

/** Attaches the user if signed in, never rejects. Use with @CurrentUser({ optional: true }). */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await loadUser(ctx.switchToHttp().getRequest<AuthedRequest>(), this.prisma);
    return true;
  }
}

export const MIN_ROLE_KEY = 'sgw:minRole';
/** Minimum role, ordered USER < TRUSTED < MODERATOR < ADMIN. Combine with RolesGuard. */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE_KEY, role);

/** Signed-in AND at least the @MinRole() role. Use instead of AuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const user = await loadUser(ctx.switchToHttp().getRequest<AuthedRequest>(), this.prisma);
    if (!user) throw new UnauthorizedException('Sign in required');
    const min = this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (min && !hasRole(user, min)) throw new ForbiddenException('Insufficient role');
    return true;
  }
}

/** The signed-in user. `@CurrentUser({ optional: true })` returns null when signed out. */
export const CurrentUser = createParamDecorator(
  (opts: { optional?: boolean } | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user && !opts?.optional) throw new UnauthorizedException('Sign in required');
    return user ?? null;
  },
);
