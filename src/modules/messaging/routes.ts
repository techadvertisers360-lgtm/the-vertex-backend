import { Router } from 'express';
import { z } from 'zod';
import { MessageStatus } from '@prisma/client';
import { idParam, route } from '../../middleware/route';
import { clinicDateStr } from '../../lib/time';
import * as svc from './service';

/** Manager message log (spec §20). Mounted at /manager/messages. */
export const messagesRouter = Router();
const P = 'messages:log' as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reason = z.string().trim().min(2).max(1000);

messagesRouter.get('/summary', route({ permission: P }, async () => svc.messageSummary(clinicDateStr(new Date()))));
messagesRouter.get(
  '/',
  route(
    {
      permission: P,
      query: z.object({
        status: z.nativeEnum(MessageStatus).optional(),
        template: z.string().max(60).optional(),
        q: z.string().max(100).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        cursor: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
    async ({ query }) => svc.listMessages(query),
  ),
);
messagesRouter.get('/:id', route({ permission: P, params: idParam }, async ({ params }) => svc.messageDetail(params.id)));
messagesRouter.post('/:id/retry', route({ permission: P, params: idParam }, async ({ actor, params }) => svc.retryMessage(actor, params.id)));
messagesRouter.post('/:id/cancel', route({ permission: P, params: idParam, body: z.object({ reason }) }, async ({ actor, params, body }) => svc.cancelMessage(actor, params.id, body.reason)));
messagesRouter.post('/:id/handled', route({ permission: P, params: idParam, body: z.object({ note: reason }) }, async ({ actor, params, body }) => svc.markHandled(actor, params.id, body.note)));
messagesRouter.post(
  '/patients/:id/whatsapp',
  route({ permission: P, params: idParam, body: z.object({ optIn: z.boolean(), reason }) }, async ({ actor, params, body }) => svc.setPatientWhatsapp(actor, params.id, body)),
);
