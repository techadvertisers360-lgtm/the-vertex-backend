import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/misc';

/**
 * Transport-neutral relay of the realtime outbox (`realtime_events`, D-024 / D-042). Services only ever call
 * `publish(tx, …)` inside their business transaction; this relay delivers committed rows afterwards.
 *
 * Several relays may run at once (API timer, serverless invocations, cron tick): rows are claimed with
 * `FOR UPDATE SKIP LOCKED` inside a transaction and marked delivered only after the transport accepted them, so an
 * event is sent once, and a failed send leaves it for the next relay.
 */
export interface RelayEvent {
  room: string;
  event: string;
  payload: Prisma.JsonValue;
}

export interface RealtimeTransport {
  readonly name: string;
  send(events: RelayEvent[]): Promise<void>;
}

/** A `session:revoked` older than this is stale (resolveSession already enforces revocation on every request). */
const REVOKE_FRESH_MS = 120_000;

export async function relayPending(transport: RealtimeTransport, batch = 500): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      const ids = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM realtime_events WHERE deliveredAt IS NULL ORDER BY id ASC LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
      if (!ids.length) return 0;
      const rows = await tx.realtimeEvent.findMany({ where: { id: { in: ids.map((r) => r.id) } }, orderBy: { id: 'asc' } });
      const now = Date.now();
      const live = rows.filter((r) => r.event !== 'session:revoked' || now - r.createdAt.getTime() <= REVOKE_FRESH_MS);
      if (live.length) await transport.send(live.map((r) => ({ room: r.room, event: r.event, payload: r.payload })));
      await tx.realtimeEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { deliveredAt: new Date() } });
      return rows.length;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/** Relay until the outbox is empty or `budgetMs` is used; errors are logged (rows stay queued for the next run). */
export async function drainRealtime(transport: RealtimeTransport, budgetMs = 10_000): Promise<number> {
  const end = Date.now() + budgetMs;
  let total = 0;
  try {
    for (;;) {
      const n = await relayPending(transport);
      total += n;
      if (!n || Date.now() > end) break;
    }
  } catch (err) {
    logger.error({ err, transport: transport.name }, 'realtime relay failed');
  }
  return total;
}

/** Delivered events are ephemeral: prune after a day. */
export async function pruneRealtime(): Promise<number> {
  const r = await prisma.realtimeEvent.deleteMany({ where: { deliveredAt: { lt: new Date(Date.now() - 86_400_000) } } });
  return r.count;
}
