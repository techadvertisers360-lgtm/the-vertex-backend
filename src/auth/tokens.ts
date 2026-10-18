import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '../config/env';

export const ACCESS_COOKIE = 'vh_at';
export const REFRESH_COOKIE = 'vh_rt';

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
  tv: number; // token version at issue
}

export function signAccessToken(c: AccessClaims): string {
  return jwt.sign(c, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL_SEC, algorithm: 'HS256' });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof p !== 'object' || typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.tv !== 'number') {
      return null;
    }
    return { sub: p.sub, sid: p.sid, tv: p.tv };
  } catch {
    return null;
  }
}

const base = () => ({ httpOnly: true, secure: env.cookieSecure, sameSite: 'lax' as const });

/**
 * Non-secret marker ("a session may exist") visible on every path, so the frontend's page middleware can tell a
 * signed-in user whose short access token expired (refresh will work) from a signed-out one. Carries no credential.
 */
export const SESSION_MARKER_COOKIE = 'vh_s';

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpires: Date): void {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base(), path: '/', maxAge: env.JWT_ACCESS_TTL_SEC * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base(), path: '/api/auth', expires: refreshExpires });
  res.cookie(SESSION_MARKER_COOKIE, '1', { ...base(), path: '/', expires: refreshExpires });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: '/api/auth' });
  res.clearCookie(SESSION_MARKER_COOKIE, { ...base(), path: '/' });
}
