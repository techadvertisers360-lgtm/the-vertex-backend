import { Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { route } from '../../middleware/route';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { audit } from '../../services/audit';
import { ROLE_HOME } from '../../auth/permissions';
import { importStock } from './stockImport';

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
      select: { id: true, displayName: true, role: true, email: true, phone: true, memberCode: true, title: true, active: true, mustChangePassword: true, attendanceRequired: true, createdAt: true, doctorProfile: { select: { specialty: true } } },
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

/**
 * Problems staff ran into (D-045): who tried what, when, and the reason they were not shown. Newest first.
 * `onBehalfOf` is set when the developer hit it while viewing as someone.
 */
developerRouter.get(
  '/issues',
  route({ permission: P, query: z.object({ before: z.coerce.number().int().positive().optional() }) }, async ({ query }) => {
    const rows = await prisma.auditEvent.findMany({
      where: { action: 'DEV_ISSUE', ...(query.before ? { id: { lt: BigInt(query.before) } } : {}) },
      orderBy: { id: 'desc' },
      take: 100,
      select: { id: true, actorId: true, actorRole: true, onBehalfOfId: true, recordType: true, recordId: true, after: true, createdAt: true },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.actorId, r.onBehalfOfId]).filter((x): x is string => !!x))];
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, role: true } });
    const who = (id: string | null) => users.find((u) => u.id === id) ?? null;
    return {
      items: rows.map((r) => {
        const a = (r.after ?? {}) as { area?: string; tried?: string; reason?: string; context?: Record<string, unknown> };
        return {
          id: Number(r.id),
          at: r.createdAt,
          who: r.actorId ? (who(r.actorId) ?? { id: r.actorId, displayName: 'Unknown', role: r.actorRole }) : null,
          onBehalfOf: who(r.onBehalfOfId),
          area: a.area ?? '—',
          tried: a.tried ?? '—',
          reason: a.reason ?? '—',
          context: a.context ?? null,
          recordType: r.recordType,
          recordId: r.recordId,
        };
      }),
      next: rows.length === 100 ? Number(rows[rows.length - 1]!.id) : null,
    };
  }),
);

/**
 * Stock CSV import (D-055): procedure product catalogue or pharmacy products with batches. `dryRun: true` checks the
 * file and shows what would change; the real run writes it. Safe to repeat — nothing already imported is added twice.
 */
developerRouter.post(
  '/stock-import',
  route(
    { permission: P, body: z.object({ kind: z.enum(['PROCEDURE', 'PHARMACY']), csv: z.string().min(1).max(1_000_000), fileName: z.string().trim().max(200).optional(), dryRun: z.boolean().default(true) }) },
    async ({ actor, body }) => importStock(actor, body),
  ),
);
