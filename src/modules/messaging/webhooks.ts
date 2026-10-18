import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { UnauthorizedError, ValidationError } from '../../lib/errors';
import { normalizePhone } from '../../lib/phone';
import { markTerminal } from '../../jobs/outbox';
import { optOutPhone } from './service';

/**
 * Provider callbacks (spec §20). Vendor adapters translate their payloads into these generic shapes; requests are
 * authenticated with the shared secret header `x-webhook-secret` (WHATSAPP_WEBHOOK_SECRET) until a vendor is chosen.
 */
export const webhooksRouter = Router();

const statusPayload = z.object({
  providerMessageId: z.string().min(1).max(191),
  status: z.enum(['SENT', 'DELIVERED', 'READ', 'FAILED']),
  error: z.string().max(1000).optional(),
});

function secretOk(given: string | undefined): boolean {
  const expected = env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function guard(req: { get(h: string): string | undefined }) {
  if (!secretOk(req.get('x-webhook-secret'))) throw new UnauthorizedError('Invalid webhook secret', 'WEBHOOK_UNAUTHORIZED');
}

/**
 * Delivery receipt. Receipts can arrive out of order, so status only moves forward
 * (SENDING/SENT → DELIVERED; READ counts as delivered). A FAILED receipt is terminal and alerts the Manager.
 */
webhooksRouter.post('/whatsapp/status', async (req, res) => {
  guard(req);
  const r = statusPayload.safeParse(req.body);
  if (!r.success) throw new ValidationError('Invalid webhook payload', r.error.flatten());
  const { providerMessageId, status, error } = r.data;
  const now = new Date();
  const msg = await prisma.messageOutbox.findUnique({ where: { providerMessageId } });
  if (!msg) {
    res.json({ ok: true, matched: false });
    return;
  }
  if (status === 'FAILED') {
    if (msg.status !== 'FAILED' && msg.status !== 'CANCELLED') {
      await prisma.$transaction((tx) => markTerminal(tx, msg, { error: error ?? 'Provider ne delivery fail report ki', errorClass: 'permanent', now }));
    }
  } else if (status === 'DELIVERED' || status === 'READ') {
    await prisma.messageOutbox.updateMany({ where: { id: msg.id, status: { in: ['SENDING', 'SENT'] } }, data: { status: 'DELIVERED', deliveredAt: now } });
  } else {
    await prisma.messageOutbox.updateMany({ where: { id: msg.id, status: 'SENDING' }, data: { status: 'SENT', sentAt: msg.sentAt ?? now } });
  }
  res.json({ ok: true, matched: true });
});

/** Explicit opt-out from the provider (e.g. the patient blocked / unsubscribed). */
webhooksRouter.post('/whatsapp/opt-out', async (req, res) => {
  guard(req);
  const r = z.object({ phone: z.string().min(7).max(20) }).safeParse(req.body);
  if (!r.success) throw new ValidationError('Invalid payload', r.error.flatten());
  const phone = normalizePhone(r.data.phone);
  const n = phone ? await optOutPhone(phone, 'provider opt-out') : 0;
  res.json({ ok: true, patients: n });
});

/** Inbound patient message: STOP-style keywords opt the number out. Other text is ignored (no inbox in scope). */
const STOP_WORDS = /^\s*(stop|unsubscribe|band karo|band karein|bund karo)\s*[.!]*\s*$/i;
webhooksRouter.post('/whatsapp/inbound', async (req, res) => {
  guard(req);
  const r = z.object({ from: z.string().min(7).max(20), text: z.string().max(4000) }).safeParse(req.body);
  if (!r.success) throw new ValidationError('Invalid payload', r.error.flatten());
  const phone = normalizePhone(r.data.from);
  const optOut = !!phone && STOP_WORDS.test(r.data.text);
  const n = optOut ? await optOutPhone(phone!, 'patient replied STOP') : 0;
  res.json({ ok: true, optOut, patients: n });
});
