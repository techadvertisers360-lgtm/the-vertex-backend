import { randomUUID } from 'node:crypto';
import type { Prisma, Role } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { NotFoundError } from '../lib/errors';
import { toJsonSafe } from '../lib/misc';
import type { Actor } from './audit';
import { userRoom } from './realtime';

export interface NotifyInput {
  type: string; // e.g. PATIENT_CHECKED_IN
  subject: string;
  body?: string;
  recordType?: string;
  recordId?: string;
  actionLabel?: string;
  priority?: number;
  sender?: Actor | null;
  /** Per-recipient dedupe key prefix; final key = `${dedupeKey}:${recipientId}`. */
  dedupeKey?: string;
}

/**
 * Create one in-app notification per recipient, in the caller's transaction, plus its live push.
 * Batched (constant number of queries regardless of recipient count) so it never stretches the business
 * transaction. Never duplicates per dedupe key — also under concurrent writers: rows are inserted with
 * skipDuplicates and a live push is published only for rows confirmed inserted by this call.
 */
export async function notifyUsers(db: Db, recipientIds: string[], n: NotifyInput): Promise<void> {
  const unique = [...new Set(recipientIds)].filter((id) => id && id !== n.sender?.id);
  if (!unique.length) return;
  const keyFor = (recipientId: string) => (n.dedupeKey ? `${n.dedupeKey}:${recipientId}` : null);

  let targets = unique;
  if (n.dedupeKey) {
    const existing = await db.notification.findMany({ where: { dedupeKey: { in: unique.map((id) => keyFor(id)!) } }, select: { dedupeKey: true } });
    const sent = new Set(existing.map((e) => e.dedupeKey));
    targets = unique.filter((id) => !sent.has(keyFor(id)));
  }
  if (!targets.length) return;

  const createdAt = new Date();
  const rows = targets.map((recipientId) => ({
    id: randomUUID(),
    recipientId,
    senderId: n.sender?.id ?? null,
    senderLabel: n.sender?.displayName ?? 'System',
    type: n.type,
    subject: n.subject,
    body: n.body ?? null,
    recordType: n.recordType ?? null,
    recordId: n.recordId ?? null,
    actionLabel: n.actionLabel ?? null,
    priority: n.priority ?? 0,
    dedupeKey: keyFor(recipientId),
    createdAt,
  }));
  await db.notification.createMany({ data: rows, skipDuplicates: true });
  const inserted = n.dedupeKey
    ? new Set((await db.notification.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true } })).map((r) => r.id))
    : null;

  // Live push (rail, unread badge, toast for priority ≥ 2) — committed with the notifications.
  const events = rows
    .filter((r) => !inserted || inserted.has(r.id))
    .map((r) => ({
      room: userRoom(r.recipientId),
      event: 'notification:new',
      payload: toJsonSafe({
        id: r.id,
        type: r.type,
        subject: r.subject,
        body: r.body,
        senderLabel: r.senderLabel,
        recordType: r.recordType,
        recordId: r.recordId,
        actionLabel: r.actionLabel,
        priority: r.priority,
        createdAt: r.createdAt,
        urgent: r.priority >= 2,
      }) as Prisma.InputJsonValue,
    }));
  if (events.length) await db.realtimeEvent.createMany({ data: events });
}

/** Notify every active user holding one of `roles`. */
export async function notifyRoles(db: Db, roles: Role[], n: NotifyInput): Promise<void> {
  const users = await db.user.findMany({ where: { role: { in: roles }, active: true }, select: { id: true } });
  await notifyUsers(
    db,
    users.map((u) => u.id),
    n,
  );
}

export type ReadFilter = 'unread' | 'read' | 'all';

/** Read filter is applied in the query itself (spec §22), not client-side. */
export async function listNotifications(userId: string, filter: ReadFilter, limit: number, cursor?: string) {
  const where = {
    recipientId: userId,
    ...(filter === 'unread' ? { readAt: null } : filter === 'read' ? { readAt: { not: null } } : {}),
  };
  const items = await prisma.notification.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const unreadCount = await prisma.notification.count({ where: { recipientId: userId, readAt: null } });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return {
    items: page.map((n) => ({ ...n, status: n.readAt ? 'read' : 'unread' })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
    unreadCount,
  };
}

/** One of my notifications (the push tap opens it, D-046). Someone else's is reported as not found. */
export async function getNotification(userId: string, id: string) {
  const n = await prisma.notification.findUnique({ where: { id }, select: { id: true, recipientId: true, type: true, subject: true, recordType: true, recordId: true, readAt: true } });
  if (!n || n.recipientId !== userId) throw new NotFoundError('Notification');
  const { recipientId: _r, ...rest } = n;
  return rest;
}

export async function markRead(userId: string, id: string): Promise<void> {
  const n = await prisma.notification.findUnique({ where: { id } });
  // Another user's notification is reported as not found (no existence leak).
  if (!n || n.recipientId !== userId) throw new NotFoundError('Notification');
  if (!n.readAt) await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
}

export async function markAllRead(userId: string): Promise<number> {
  const r = await prisma.notification.updateMany({ where: { recipientId: userId, readAt: null }, data: { readAt: new Date() } });
  return r.count;
}
