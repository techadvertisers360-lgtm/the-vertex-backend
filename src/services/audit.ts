import type { Prisma, Role } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { logger, toJsonSafe } from '../lib/misc';

/** Who is acting. Built once per request by the auth middleware; jobs use `systemActor`. */
export interface Actor {
  id: string | null;
  role: Role | null;
  displayName: string;
  ip?: string;
  requestId?: string;
}

export const systemActor: Actor = { id: null, role: null, displayName: 'System' };

export interface AuditInput {
  action: string; // e.g. APPOINTMENT_CREATED, INVOICE_CLOSED, AUTHZ_DENIED
  recordType: string;
  recordId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

function json(v: unknown): Prisma.InputJsonValue | undefined {
  return v === undefined || v === null ? undefined : (toJsonSafe(v) as Prisma.InputJsonValue);
}

/**
 * Append an audit event. Pass the business transaction as `db` so the event commits or rolls back
 * together with the change (spec §22/§23). Rows are append-only (DB triggers block UPDATE/DELETE).
 */
export async function audit(db: Db, actor: Actor, e: AuditInput): Promise<void> {
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: e.action,
      recordType: e.recordType,
      recordId: e.recordId ?? null,
      before: json(e.before),
      after: json(e.after),
      reason: e.reason ?? null,
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
    },
  });
}

/** Authorization denial audit — written outside any business transaction (which is being rolled back). */
export async function auditDenied(
  actor: Actor,
  denial: { recordType: string; recordId?: string; rule: string },
  path: string,
): Promise<void> {
  try {
    await audit(prisma, actor, {
      action: 'AUTHZ_DENIED',
      recordType: denial.recordType,
      recordId: denial.recordId ?? null,
      after: { rule: denial.rule, path },
    });
  } catch (err) {
    logger.error({ err }, 'failed to write AUTHZ_DENIED audit');
  }
}
