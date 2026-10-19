import { Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { route } from '../../middleware/route';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { audit } from '../../services/audit';
import { ROLE_HOME } from '../../auth/permissions';

/**
 * Hidden developer console (D-043). Account create / edit / temporary password use /api/users (the developer holds
 * users:manage with authority over every role); these routes add the full staff list and "view as".
 */
export const developerRouter = Router();
const P = 'developer:console' as const;

developerRouter.get(
  '/users',
  route({ permission: P, query: z.object({ role: z.nativeEnum(Role).optional(), q: z.string().max(80).optional(), active: z.enum(['true', 'false']).optional() }) }, async ({ query }) => {
    const users = await prisma.user.findMany({
      where: {
        role: query.role && query.role !== 'DEVELOPER' ? query.role : { not: 'DEVELOPER' },
        ...(query.active ? { active: query.active === 'true' } : {}),
        ...(query.q?.trim() ? { OR: [{ displayName: { contains: query.q.trim() } }, { memberCode: { contains: query.q.trim().toUpperCase() } }, { email: { contains: query.q.trim().toLowerCase() } }] } : {}),
      },
      select: { id: true, displayName: true, role: true, email: true, phone: true, memberCode: true, title: true, active: true, mustChangePassword: true, createdAt: true, doctorProfile: { select: { specialty: true } } },
      orderBy: [{ active: 'desc' }, { role: 'asc' }, { displayName: 'asc' }],
    });
    const seen = await prisma.session.groupBy({ by: ['userId'], where: { userId: { in: users.map((u) => u.id) } }, _max: { lastUsedAt: true } });
    return {
      items: users.map(({ doctorProfile, ...u }) => ({ ...u, specialty: doctorProfile?.specialty ?? null, lastSeenAt: seen.find((s) => s.userId === u.id)?._max.lastUsedAt ?? null })),
    };
  }),
);

/**
 * Start viewing the app exactly as `userId` sees it — tabs, data, live notifications — read-only (requireAuth rejects
 * every write while viewing). Leave with POST /api/me/stop-view-as.
 */
developerRouter.post(
  '/view-as',
  route({ permission: P, body: z.object({ userId: z.string().min(1).max(64) }) }, async ({ actor, user, body }) => {
    const target = await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true, role: true, active: true, displayName: true } });
    if (!target || target.role === 'DEVELOPER') throw new NotFoundError('User');
    if (!target.active) throw new ValidationError('Disabled account ke tor par nahi dekh sakte — pehle enable karein.');
    await prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { id: user.sessionId }, data: { impersonatedUserId: target.id } });
      await audit(tx, actor, { action: 'VIEW_AS_STARTED', recordType: 'User', recordId: target.id, after: { role: target.role } });
    });
    return { ok: true, viewAs: { id: target.id, displayName: target.displayName, role: target.role }, home: ROLE_HOME[target.role] };
  }),
);
