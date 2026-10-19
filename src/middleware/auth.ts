import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { UnauthorizedError } from '../lib/errors';
import { ACCESS_COOKIE, verifyAccessToken } from '../auth/tokens';
import { ACCOUNT_DISABLED_MSG } from '../auth/service';
import type { Actor } from '../services/audit';

export interface AuthUser {
  id: string;
  role: Role;
  displayName: string;
  sessionId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    actor?: Actor;
    requestId?: string;
  }
}

/**
 * Authenticate from the access-token cookie, then re-load the user and session from the DB on every
 * request so role changes, disables and token-version bumps apply on the very next call (spec §2).
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  await authenticate(req);
  next();
}

/** Authenticate and attach `req.user` / `req.actor`; throws UnauthorizedError. Also used by the upload middleware. */
export async function authenticate(req: Request): Promise<AuthUser> {
  const user = await resolveAccessToken(req.cookies?.[ACCESS_COOKIE] as string | undefined);
  req.user = user;
  req.actor = { id: user.id, role: user.role, displayName: user.displayName, ip: req.ip, requestId: req.requestId };
  return user;
}

/**
 * Validate an access token against the live DB state: user exists and is active, session not revoked or
 * expired, token version current. Shared by HTTP requests and Socket.IO connections / re-validation.
 */
export async function resolveAccessToken(token: string | undefined): Promise<AuthUser> {
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) throw new UnauthorizedError();
  return resolveSession(claims.sub, claims.sid, claims.tv);
}

export async function resolveSession(userId: string, sessionId: string, tokenVersion: number): Promise<AuthUser> {
  const [user, session] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, active: true, tokenVersion: true, displayName: true },
    }),
    prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, revokedAt: true, expiresAt: true } }),
  ]);
  if (!user || !session || session.userId !== user.id) throw new UnauthorizedError();
  if (!user.active) throw new UnauthorizedError(ACCOUNT_DISABLED_MSG, 'ACCOUNT_DISABLED');
  if (session.revokedAt || session.expiresAt < new Date() || user.tokenVersion !== tokenVersion) {
    throw new UnauthorizedError();
  }
  return { id: user.id, role: user.role, displayName: user.displayName, sessionId };
}

/**
 * CSRF guard for cookie auth: state-changing requests must carry a custom header, which a cross-site
 * form cannot set and which forces a CORS preflight for cross-origin scripts.
 */
export function requireClientHeader(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/uploadthing') || req.path.startsWith('/webhooks') || req.path.startsWith('/public') || req.path.startsWith('/cron')) {
    return next();
  }
  if (req.get('x-vh-client') !== 'web') {
    throw new UnauthorizedError('Missing client header.', 'CSRF_HEADER_MISSING');
  }
  next();
}
