import { prisma, type Db } from '../lib/prisma';
import { logger } from '../lib/misc';
import { audit, type Actor } from './audit';
import { notifyUsers } from './notifications';

/**
 * Problems are shown to the developer only (D-045). Staff see a short neutral line; the developer gets a live
 * notification and an entry in the developer console naming who tried what, when, and why it did not work.
 * Stored as an append-only `DEV_ISSUE` audit event (actor = the person who tried).
 */

export interface DevIssue {
  /** Feature area, e.g. "Lead sheet". */
  area: string;
  /** What the person (or the system) was trying to do, in plain words. */
  tried: string;
  /** Why it did not work — the full technical reason, for the developer's eyes only. */
  reason: string;
  recordType?: string;
  recordId?: string;
  context?: Record<string, unknown>;
  /** Same key → one notification only (the issue row is still written). */
  dedupeKey?: string;
}

/** Message staff see instead of the reason. */
export const DEV_NOTIFIED_MSG = 'Kuch masla aa gaya — Developer ko bata diya gaya hai, woh theek kar dega.';

const ROLE_LABEL: Record<string, string> = {
  MD: 'MD',
  MANAGER: 'Manager',
  MARKETING_DIRECTOR: 'Marketing Director',
  MARKETING_LEAD: 'Marketing Lead',
  RECEPTIONIST: 'Reception',
  DOCTOR: 'Doctor',
  ASSISTANT: 'Assistant',
  OFFICE_BOY: 'Office Boy',
  LEAD_MEMBER: 'Lead member',
  DEVELOPER: 'Developer',
};

export function whoLabel(actor: Actor): string {
  if (!actor.id) return 'System (auto)';
  return `${actor.displayName}${actor.role ? ` (${ROLE_LABEL[actor.role] ?? actor.role})` : ''}`;
}

/** Inside the caller's transaction. */
export async function reportIssueTx(db: Db, actor: Actor, i: DevIssue): Promise<void> {
  await audit(db, actor, {
    action: 'DEV_ISSUE',
    recordType: i.recordType ?? 'System',
    recordId: i.recordId,
    after: { area: i.area, tried: i.tried, reason: i.reason.slice(0, 2000), ...(i.context ? { context: i.context } : {}) },
  });
  const devs = await db.user.findMany({ where: { role: 'DEVELOPER', active: true }, select: { id: true } });
  await notifyUsers(db, devs.map((d) => d.id), {
    type: 'DEV_ISSUE',
    subject: `${i.area}: ${whoLabel(actor)} — ${i.tried}`.slice(0, 190),
    body: i.reason.slice(0, 1000),
    recordType: i.recordType,
    recordId: i.recordId,
    priority: 2,
    dedupeKey: i.dedupeKey,
  });
}

/** Standalone; never throws (reporting must not break the request that hit the problem). */
export async function reportIssue(actor: Actor, i: DevIssue): Promise<void> {
  try {
    await prisma.$transaction((tx) => reportIssueTx(tx, actor, i));
  } catch (err) {
    logger.error({ err, issue: i.tried }, 'could not record developer issue');
  }
}
