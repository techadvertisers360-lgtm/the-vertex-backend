import type { Prisma, Role } from '@prisma/client';
import type { Db } from '../lib/prisma';
import { toJsonSafe } from '../lib/misc';

/**
 * Publish a live event through the transactional outbox (`realtime_events`). Call it with the business
 * transaction so the event exists only if the change commits; the API process relays committed rows to
 * Socket.IO rooms. Works for events created by the worker process too (D-024).
 */
export const userRoom = (userId: string) => `user:${userId}`;
export const roleRoom = (role: Role) => `role:${role}`;

export type RealtimeEventName =
  | 'notification:new'
  | 'session:revoked'
  | 'appointment:updated'
  | 'queue:changed'
  | 'tracker:changed';

export async function publish(db: Db, rooms: string[], event: RealtimeEventName, payload: Record<string, unknown> = {}): Promise<void> {
  const unique = [...new Set(rooms)];
  if (!unique.length) return;
  const json = toJsonSafe(payload) as Prisma.InputJsonValue;
  await db.realtimeEvent.createMany({ data: unique.map((room) => ({ room, event, payload: json })) });
}
