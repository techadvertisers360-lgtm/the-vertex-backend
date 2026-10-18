import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError, UnauthorizedError, ValidationError } from '../lib/errors';
import { normalizePhone } from '../lib/phone';
import { randomToken, sha256 } from '../lib/misc';
import { audit, type Actor } from '../services/audit';
import { enqueueMessage } from '../services/messaging';
import { publish, userRoom } from '../services/realtime';
import { signAccessToken } from './tokens';

const BCRYPT_COST = 12;
// Pre-computed hash so unknown identifiers cost the same time as known ones.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

export const ACCOUNT_DISABLED_MSG = 'Aap ka account disable hai. Clinic admin se rabta karein.';

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, BCRYPT_COST);
}

export function validatePasswordStrength(pw: string): void {
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw new ValidationError('Password kam az kam 8 characters ka ho aur us mein letter aur number dono hon.');
  }
}

/** Login identifier can be email, phone or Member ID. */
export async function findUserByIdentifier(identifier: string): Promise<User | null> {
  const id = identifier.trim();
  if (id.includes('@')) return prisma.user.findUnique({ where: { email: id.toLowerCase() } });
  const phone = normalizePhone(id);
  if (phone) {
    const byPhone = await prisma.user.findUnique({ where: { phone } });
    if (byPhone) return byPhone;
  }
  return prisma.user.findUnique({ where: { memberCode: id.toUpperCase() } });
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshExpires: Date;
  sessionId: string;
}

async function issueSession(user: User, meta: { ip?: string; userAgent?: string }): Promise<IssuedSession> {
  const refreshToken = randomToken(48);
  const refreshExpires = new Date(Date.now() + env.REFRESH_TTL_DAYS * 86400_000);
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: sha256(refreshToken),
      tokenVersion: user.tokenVersion,
      expiresAt: refreshExpires,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512),
    },
  });
  const accessToken = signAccessToken({ sub: user.id, sid: session.id, tv: user.tokenVersion });
  return { accessToken, refreshToken, refreshExpires, sessionId: session.id };
}

export async function login(
  identifier: string,
  password: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ user: User; session: IssuedSession }> {
  const user = await findUserByIdentifier(identifier);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    await audit(prisma, { id: user?.id ?? null, role: user?.role ?? null, displayName: identifier, ip: meta.ip }, {
      action: 'LOGIN_FAILED',
      recordType: 'User',
      recordId: user?.id ?? null,
    });
    throw new UnauthorizedError('Email/phone/Member ID ya password ghalat hai.', 'INVALID_CREDENTIALS');
  }
  if (!user.active) throw new UnauthorizedError(ACCOUNT_DISABLED_MSG, 'ACCOUNT_DISABLED');
  const session = await issueSession(user, meta);
  await audit(prisma, { id: user.id, role: user.role, displayName: user.displayName, ip: meta.ip }, {
    action: 'LOGIN',
    recordType: 'Session',
    recordId: session.sessionId,
  });
  return { user, session };
}

/**
 * Rotate a refresh token. Reuse of an already-rotated token revokes every session of that user
 * (token theft signal).
 */
export async function refresh(refreshToken: string, meta: { ip?: string; userAgent?: string }) {
  const s = await prisma.session.findUnique({ where: { refreshTokenHash: sha256(refreshToken) }, include: { user: true } });
  if (!s) throw new UnauthorizedError();
  if (s.revokedAt) {
    if (s.replacedById) {
      await prisma.session.updateMany({ where: { userId: s.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    throw new UnauthorizedError();
  }
  if (s.expiresAt < new Date()) throw new UnauthorizedError();
  if (!s.user.active) throw new UnauthorizedError(ACCOUNT_DISABLED_MSG, 'ACCOUNT_DISABLED');
  if (s.tokenVersion !== s.user.tokenVersion) throw new UnauthorizedError();

  const next = await issueSession(s.user, meta);
  // Only one concurrent refresh wins the rotation.
  const { count } = await prisma.session.updateMany({
    where: { id: s.id, revokedAt: null },
    data: { revokedAt: new Date(), replacedById: next.sessionId },
  });
  if (count === 0) {
    await prisma.session.update({ where: { id: next.sessionId }, data: { revokedAt: new Date() } });
    throw new UnauthorizedError();
  }
  return { user: s.user, session: next };
}

export async function logout(sessionId: string): Promise<void> {
  await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Always resolves (no account enumeration). Delivers the reset link through the message outbox. */
export async function requestPasswordReset(identifier: string, meta: { ip?: string }): Promise<void> {
  const user = await findUserByIdentifier(identifier);
  if (!user || !user.active) return;
  const token = randomToken(32);
  await prisma.$transaction(async (tx) => {
    // Invalidate older outstanding tokens.
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    const row = await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MIN * 60_000),
      },
    });
    if (user.phone) {
      await enqueueMessage(tx, {
        template: 'password_reset',
        toPhone: user.phone,
        recipientUserId: user.id,
        payload: { name: user.displayName, link: `${env.PUBLIC_APP_URL}/reset-password?token=${token}` },
        relatedType: 'PasswordResetToken',
        relatedId: row.id,
        idempotencyKey: `password_reset:${row.id}`,
      });
    }
    await audit(tx, { id: user.id, role: user.role, displayName: user.displayName, ip: meta.ip }, {
      action: 'PASSWORD_RESET_REQUESTED',
      recordType: 'User',
      recordId: user.id,
    });
  });
}

export async function resetPassword(token: string, newPassword: string, meta: { ip?: string }): Promise<void> {
  validatePasswordStrength(newPassword);
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt < new Date() || !row.user.active) {
    throw new AppError(400, 'RESET_TOKEN_INVALID', 'Reset link expire ho gaya ya pehle use ho chuka hai.');
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw new AppError(400, 'RESET_TOKEN_INVALID', 'Reset link expire ho gaya ya pehle use ho chuka hai.');
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await publish(tx, [userRoom(row.userId)], 'session:revoked', { reason: 'PASSWORD_RESET' });
    const actor: Actor = { id: row.user.id, role: row.user.role, displayName: row.user.displayName, ip: meta.ip };
    await audit(tx, actor, { action: 'PASSWORD_RESET', recordType: 'User', recordId: row.userId });
  });
}
