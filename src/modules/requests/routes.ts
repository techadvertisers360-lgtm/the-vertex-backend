import { Router } from 'express';
import { z } from 'zod';
import { AdRequestKind, LeaveKind, RequestStatus } from '@prisma/client';
import { idParam, route } from '../../middleware/route';
import * as svc from './service';

/** Leave, complaints and Ad/Issue requests with shared threads (spec §7, §17, §21). */
export const requestsRouter = Router();

const leaveBody = z.object({
  kind: z.nativeEnum(LeaveKind),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  reason: z.string().min(2).max(2000),
  coveragePlan: z.string().max(2000).optional(),
});
const box = z.object({ box: z.enum(['mine', 'inbox']).default('mine'), status: z.nativeEnum(RequestStatus).optional() });
const attachmentIds = z.array(z.string().min(1).max(64)).max(10).default([]);

// Leave / early leave
requestsRouter.post('/leave', route({ permission: 'requests:own', body: leaveBody, status: 201 }, async ({ actor, body }) => svc.createLeave(actor, body)));
requestsRouter.get(
  '/leave',
  route({ permission: ['requests:own', 'requests:inbox'], query: box }, async ({ actor, query }) => ({ items: await svc.listLeave(actor, query.box, query.status) })),
);
requestsRouter.get('/leave/:id', route({ permission: ['requests:own', 'requests:inbox'], params: idParam }, async ({ actor, params }) => svc.getLeave(actor, params.id)));
requestsRouter.post(
  '/leave/:id/decision',
  route(
    {
      permission: 'requests:inbox',
      params: idParam,
      body: z.object({ status: z.enum(['IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION']), reason: z.string().max(2000).optional() }),
    },
    async ({ actor, params, body }) => svc.decideLeave(actor, params.id, body.status, body.reason),
  ),
);
requestsRouter.put('/leave/:id', route({ permission: 'requests:own', params: idParam, body: leaveBody }, async ({ actor, params, body }) => svc.resubmitLeave(actor, params.id, body)));

// Complaints
requestsRouter.post(
  '/complaints',
  route(
    {
      permission: 'requests:own',
      status: 201,
      body: z.object({
        subject: z.string().min(2).max(200),
        detail: z.string().min(2).max(5000),
        recipient: z.enum(['MANAGER', 'MD', 'HAMZA']).optional(),
        attachmentIds,
      }),
    },
    async ({ actor, body }) => svc.createComplaint(actor, body),
  ),
);
requestsRouter.get(
  '/complaints',
  route({ permission: ['requests:own', 'requests:inbox'], query: box }, async ({ actor, query }) => ({ items: await svc.listComplaints(actor, query.box, query.status) })),
);
requestsRouter.get('/complaints/:id', route({ permission: ['requests:own', 'requests:inbox'], params: idParam }, async ({ actor, params }) => svc.getComplaint(actor, params.id)));
requestsRouter.post(
  '/complaints/:id/messages',
  route(
    {
      permission: ['requests:own', 'requests:inbox'],
      params: idParam,
      status: 201,
      body: z.object({ body: z.string().min(1).max(5000), status: z.nativeEnum(RequestStatus).optional(), attachmentIds }),
    },
    async ({ actor, params, body }) => svc.replyComplaint(actor, params.id, body.body, body.status, body.attachmentIds),
  ),
);
requestsRouter.post(
  '/complaints/:id/escalate',
  route({ permission: 'requests:inbox', params: idParam, body: z.object({ reason: z.string().min(2).max(2000), to: z.enum(['MD', 'HAMZA']).default('MD') }) }, async ({ actor, params, body }) => {
    await svc.escalateComplaint(actor, params.id, body.reason, body.to);
    return { ok: true };
  }),
);
requestsRouter.post(
  '/complaints/:id/delegate',
  route({ permission: 'requests:inbox', params: idParam, body: z.object({ note: z.string().min(2).max(2000) }) }, async ({ actor, params, body }) => {
    await svc.delegateComplaint(actor, params.id, body.note);
    return { ok: true };
  }),
);

// Ad / Issue requests — Lead creates; Muaz + Hamza share one thread
requestsRouter.post(
  '/ad',
  route(
    {
      permission: 'leads:own',
      status: 201,
      body: z.object({
        kind: z.nativeEnum(AdRequestKind),
        sheetId: z.string().optional(),
        campaign: z.string().max(200).optional(),
        detail: z.string().min(2).max(5000),
        reason: z.string().max(2000).optional(),
        attachmentIds,
      }),
    },
    async ({ actor, body }) => svc.createAdRequest(actor, body),
  ),
);
requestsRouter.get(
  '/ad',
  route({ permission: ['leads:own', 'marketing:ad_requests'], query: z.object({ status: z.nativeEnum(RequestStatus).optional() }) }, async ({ actor, query }) => ({
    items: await svc.listAdRequests(actor, query.status),
  })),
);
requestsRouter.get('/ad/:id', route({ permission: ['leads:own', 'marketing:ad_requests'], params: idParam }, async ({ actor, params }) => svc.getAdRequest(actor, params.id)));
requestsRouter.post(
  '/ad/:id/messages',
  route(
    {
      permission: ['leads:own', 'marketing:ad_requests'],
      params: idParam,
      status: 201,
      body: z.object({ body: z.string().min(1).max(5000), status: z.nativeEnum(RequestStatus).optional(), attachmentIds }),
    },
    async ({ actor, params, body }) => svc.replyAdRequest(actor, params.id, body.body, body.status, body.attachmentIds),
  ),
);
