import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { ValidationError } from '../../lib/errors';
import { toJsonSafe } from '../../lib/misc';
import { ROLE_HOME, ROLE_PERMISSIONS, NAV_MODULES } from '../../auth/permissions';
import * as auth from '../../auth/service';
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from '../../auth/tokens';
import { requireAuth } from '../../middleware/auth';
import { prisma } from '../../lib/prisma';
import { audit } from '../../services/audit';

export const authRouter = Router();

const limiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Behind proxies (Vercel) many users can share one apparent IP; keying by IP + identifier stops one person's
  // failed attempts from locking everyone out while still capping guesses per account.
  keyGenerator: (req) => {
    const id = typeof req.body?.identifier === 'string' ? req.body.identifier.trim().toLowerCase().slice(0, 120) : '';
    return `${ipKeyGenerator(req.ip ?? '')}|${id}`;
  },
  message: { error: { code: 'RATE_LIMITED', message: 'Bohat zyada koshishein. 15 minute baad dobara try karein.' } },
});

function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.body);
  if (!r.success) throw new ValidationError('Invalid request body', r.error.flatten());
  return r.data;
}

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') });

function profile(
  user: { id: string; displayName: string; role: keyof typeof ROLE_HOME; title: string | null; email: string | null; phone: string | null; memberCode: string | null; mustChangePassword: boolean },
  viewAs?: { by: string } | null,
) {
  return {
    // Only the developer may be asked to change a password (D-044); everyone else keeps the one they were given.
    user: { id: user.id, displayName: user.displayName, role: user.role, title: user.title, email: user.email, phone: user.phone, memberCode: user.memberCode, mustChangePassword: !viewAs && user.role === 'DEVELOPER' && user.mustChangePassword },
    /** Developer "view as" (D-043): the screens are this user's, read-only. */
    viewAs: viewAs ?? null,
    permissions: ROLE_PERMISSIONS[user.role],
    nav: NAV_MODULES[user.role].map(({ key, label, path }) => ({ key, label, path })),
    home: ROLE_HOME[user.role],
  };
}

authRouter.post('/login', limiter, async (req, res) => {
  const { identifier, password } = body(z.object({ identifier: z.string().min(3).max(120), password: z.string().min(1).max(200) }), req);
  const { user, session } = await auth.login(identifier, password, meta(req));
  setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpires);
  res.json(toJsonSafe(profile(user)));
});

authRouter.post('/refresh', limiter, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) {
    clearAuthCookies(res);
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session expire ho gaya. Dobara sign in karein.' } });
    return;
  }
  try {
    const { user, session } = await auth.refresh(token, meta(req));
    setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpires);
    res.json(toJsonSafe(profile(user)));
  } catch (e) {
    clearAuthCookies(res);
    throw e;
  }
});

authRouter.post('/logout', async (req, res) => {
  try {
    await requireAuth(req, res, () => undefined);
    if (req.user) await auth.logout(req.user.sessionId);
  } catch {
    // already signed out — still clear cookies
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

/**
 * Self-service password reset is switched off by the clinic (D-044): passwords are issued and changed only by the
 * developer. Both endpoints answer 403 with the instruction instead of sending or accepting reset links.
 */
export const PASSWORD_ADMIN_ONLY_MSG = 'Password sirf administrator (Developer) set ya badal sakta hai — un se rabta karein.';
const passwordAdminOnly = (_req: Request, res: import('express').Response) => {
  res.status(403).json({ error: { code: 'PASSWORD_ADMIN_ONLY', message: PASSWORD_ADMIN_ONLY_MSG } });
};
authRouter.post('/forgot', limiter, passwordAdminOnly);
authRouter.post('/reset', limiter, passwordAdminOnly);

export const meRouter = Router();
meRouter.get('/', requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  res.json(toJsonSafe(profile(user, req.user!.impersonator ? { by: 'Developer' } : null)));
});

/** Change my own password (current + new) — the developer only (D-044); refused while viewing as someone. */
meRouter.post('/password', requireAuth, async (req, res) => {
  if (req.user!.role !== 'DEVELOPER') {
    passwordAdminOnly(req, res);
    return;
  }
  const input = body(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }), req);
  const session = await auth.changeOwnPassword(req.user!.id, req.user!.sessionId, input, meta(req));
  setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpires);
  res.json({ ok: true });
});

/** Leave developer "view as" (D-043) — the only write allowed in that mode. */
meRouter.post('/stop-view-as', requireAuth, async (req, res) => {
  const dev = req.user!.impersonator;
  if (!dev) {
    res.json({ ok: true, viewAs: null });
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.session.update({ where: { id: req.user!.sessionId }, data: { impersonatedUserId: null } });
    await audit(tx, { id: dev.id, role: 'DEVELOPER', displayName: dev.displayName, ip: req.ip }, { action: 'VIEW_AS_STOPPED', recordType: 'User', recordId: req.user!.id });
  });
  res.json({ ok: true, viewAs: null });
});
