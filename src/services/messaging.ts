import type { MessageChannel, MessageOutbox, Prisma } from '@prisma/client';
import type { Db } from '../lib/prisma';
import { toJsonSafe } from '../lib/misc';

export interface EnqueueMessage {
  channel?: MessageChannel;
  template: string;
  toPhone: string;
  patientId?: string | null;
  recipientUserId?: string | null;
  payload: Record<string, unknown>;
  relatedType?: string;
  relatedId?: string;
  /** Deterministic key, e.g. `appointment:<id>:confirmed:patient`. Re-enqueueing with the same key is a no-op. */
  idempotencyKey: string;
  createdById?: string | null;
}

/**
 * Write a message to the outbox inside the caller's transaction. The worker delivers it (spec §20, §23).
 * Idempotent on `idempotencyKey`.
 */
export async function enqueueMessage(db: Db, m: EnqueueMessage): Promise<MessageOutbox> {
  return db.messageOutbox.upsert({
    where: { idempotencyKey: m.idempotencyKey },
    update: {},
    create: {
      channel: m.channel ?? 'WHATSAPP',
      template: m.template,
      toPhone: m.toPhone,
      patientId: m.patientId ?? null,
      recipientUserId: m.recipientUserId ?? null,
      payload: toJsonSafe(m.payload) as Prisma.InputJsonValue,
      relatedType: m.relatedType ?? null,
      relatedId: m.relatedId ?? null,
      idempotencyKey: m.idempotencyKey,
      createdById: m.createdById ?? null,
    },
  });
}
