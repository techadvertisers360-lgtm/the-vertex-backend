import { createHash } from 'node:crypto';
import webpush, { WebPushError } from 'web-push';
import { env } from '../config/env';
import { logger } from '../lib/misc';
import { prisma } from '../lib/prisma';

/**
 * Web Push (D-046): every in-app notification is also pushed to the recipient's phones / desktops, so it arrives
 * like a WhatsApp message while the app is closed or the phone is locked. Standard Web Push with VAPID keys — no
 * paid service. Pushes are relayed from the realtime outbox (`notification:new` rows) after the business commit,
 * so the same path works on a long-running server and on Vercel (post-response hook + cron tick).
 *
 * Privacy: the lock screen shows at most the patient's name, a time and a room — never treatments, procedures,
 * complaint text or other clinical / free text (see `pushContent`).
 */

export function pushEnabled(): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

let configured = false;
function vapid(): void {
  if (configured) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT!, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  configured = true;
}

type Sender = (sub: webpush.PushSubscription, body: string, opts: webpush.RequestOptions) => Promise<unknown>;
let sender: Sender = (sub, body, opts) => webpush.sendNotification(sub, body, opts);
/** Test seam: replace the network send (null restores web-push). */
export function setPushSender(f: Sender | null): void {
  sender = f ?? ((sub, body, opts) => webpush.sendNotification(sub, body, opts));
}

export const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

export interface PushPayload {
  title: string;
  body: string;
  /** Path the tap opens (inside the app). */
  url: string;
  /** Same tag replaces the earlier notification on the device instead of stacking. */
  tag: string;
  urgent: boolean;
}

/** Notification fields the relay reads from the `notification:new` outbox payload. */
export interface NotificationLike {
  id: string;
  type: string;
  subject: string;
  body?: string | null;
  recordType?: string | null;
  priority?: number | null;
}

/** Records about a patient: their pushes carry only name / time / room. */
const PATIENT_RECORDS = new Set(['Appointment', 'ProcedureTask', 'UpcomingProcedure', 'PlannedProcedure', 'Patient', 'Invoice', 'TreatmentPlan', 'Complaint', 'PatientFeedback', 'FollowUp']);
/** Bodies that hold only times / dates / rooms — safe on a lock screen. */
const SAFE_BODY = new Set(['PATIENT_WAITING', 'PATIENT_CHECKED_IN', 'ROOM_ASSIGNED', 'RESCHEDULE_APPROVED', 'CALLBACK_DUE']);
/** Free-text subjects (complaint titles typed by people) get a fixed title instead. */
const FIXED_TITLE: Record<string, string> = {
  COMPLAINT_RECEIVED: 'Nayi complaint',
  COMPLAINT_UPDATED: 'Complaint update',
  COMPLAINT_ESCALATED: 'Complaint escalation',
  COMPLAINT_DELEGATED: 'Complaint aap ko di gayi',
  PATIENT_COMPLAINT: 'Patient complaint',
  MD_ESCALATION: 'Escalation',
};
const TAP = 'Kholne ke liye tap karein';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the phone shows for a notification. */
export function pushContent(n: NotificationLike): PushPayload {
  const patient = PATIENT_RECORDS.has(n.recordType ?? '') || /PATIENT|PROCEDURE|COMPLAINT|AFTERCARE|SLA_/.test(n.type);
  const title = FIXED_TITLE[n.type] ?? n.subject;
  const body = patient ? (SAFE_BODY.has(n.type) && n.body ? n.body : TAP) : n.body || TAP;
  return { title: clip(title, 120), body: clip(body, 180), url: `/n/${n.id}`, tag: `n:${n.id}`, urgent: (n.priority ?? 0) >= 2 };
}

export interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

/** Push to every device of the given active users. Dead subscriptions (404 / 410) are removed. */
export async function sendToUsers(userIds: string[], payload: PushPayload): Promise<SendResult> {
  const r: SendResult = { sent: 0, removed: 0, failed: 0 };
  if (!pushEnabled() || !userIds.length) return r;
  vapid();
  const subs = await prisma.pushSubscription.findMany({ where: { userId: { in: userIds }, user: { active: true } } });
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          TTL: payload.urgent ? 6 * 3600 : 24 * 3600,
          urgency: payload.urgent ? 'high' : 'normal',
          topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
          timeout: 10_000,
        });
        r.sent++;
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSuccessAt: new Date(), failures: 0 } }).catch(() => undefined);
      } catch (err) {
        const status = err instanceof WebPushError ? err.statusCode : 0;
        // Gone / unknown at the push service, or failing for long: the device unsubscribed or the app was removed.
        if (status === 404 || status === 410 || s.failures >= 20) {
          await prisma.pushSubscription.deleteMany({ where: { id: s.id } });
          r.removed++;
        } else {
          r.failed++;
          await prisma.pushSubscription.updateMany({ where: { id: s.id }, data: { failures: { increment: 1 } } });
          logger.warn({ status, subscription: s.id }, 'web push failed');
        }
      }
    }),
  );
  return r;
}

/** A push older than this is no longer useful (the person has seen it in the app, or it is stale). */
const FRESH_MS = 15 * 60_000;

/**
 * Push pending `notification:new` outbox rows. Rows are claimed (SKIP LOCKED, `pushedAt` set) in a short
 * transaction and pushed after it commits, so overlapping relays (API timer, post-response hook, cron tick) push each
 * notification once and the in-app realtime relay is never held up by slow push services. At most once: a crash
 * mid-send loses that push, never the notification itself (it is still in the app).
 */
export async function relayPush(batch = 100): Promise<number> {
  if (!pushEnabled()) return 0;
  const rows = await prisma.$transaction(
    async (tx) => {
      const since = new Date(Date.now() - FRESH_MS);
      const ids = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM realtime_events WHERE event = 'notification:new' AND pushedAt IS NULL AND createdAt >= ${since}
        ORDER BY id ASC LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
      if (!ids.length) return [];
      await tx.realtimeEvent.updateMany({ where: { id: { in: ids.map((r) => r.id) } }, data: { pushedAt: new Date() } });
      return tx.realtimeEvent.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select: { id: true, room: true, payload: true } });
    },
    { timeout: 10_000, maxWait: 5_000 },
  );
  await Promise.all(
    rows.map(async (row) => {
      const userId = row.room.startsWith('user:') ? row.room.slice(5) : null;
      const n = row.payload as unknown as NotificationLike | null;
      if (!userId || !n?.id) return;
      try {
        await sendToUsers([userId], pushContent(n));
      } catch (err) {
        logger.error({ err, event: String(row.id) }, 'web push relay send failed');
      }
    }),
  );
  return rows.length;
}

/** Push until nothing is pending or `budgetMs` is used; errors are logged. */
export async function drainPush(budgetMs = 8_000): Promise<number> {
  if (!pushEnabled()) return 0;
  const end = Date.now() + budgetMs;
  let total = 0;
  try {
    for (;;) {
      const n = await relayPush();
      total += n;
      if (!n || Date.now() > end) break;
    }
  } catch (err) {
    logger.error({ err }, 'web push relay failed');
  }
  return total;
}

/** Register (or move to this user) a device subscription. One row per endpoint. */
export async function saveSubscription(userId: string, s: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
  const hash = endpointHash(s.endpoint);
  const data = { userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: userAgent?.slice(0, 255) ?? null, failures: 0 };
  await prisma.pushSubscription.upsert({ where: { endpointHash: hash }, create: { endpointHash: hash, ...data }, update: data });
  return { ok: true, devices: await prisma.pushSubscription.count({ where: { userId } }) };
}

/** Remove this device (own subscription only). */
export async function removeSubscription(userId: string, endpoint: string) {
  const r = await prisma.pushSubscription.deleteMany({ where: { userId, endpointHash: endpointHash(endpoint) } });
  return { ok: true, removed: r.count, devices: await prisma.pushSubscription.count({ where: { userId } }) };
}
