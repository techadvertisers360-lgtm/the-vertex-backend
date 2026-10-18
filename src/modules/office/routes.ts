import { Router } from 'express';
import { z } from 'zod';
import { idParam, route } from '../../middleware/route';
import { stockForUsage } from '../../services/stock';
import * as demands from '../stock/demands';
import * as svc from './service';

/** Office Boy (spec §13). Zero patient data in every payload. */
export const officeRouter = Router();

officeRouter.get('/today', route({ permission: 'officeboy:rounds' }, async ({ actor }) => svc.today(actor)));
officeRouter.get('/rounds/:id', route({ permission: 'officeboy:rounds', params: idParam }, async ({ actor, params }) => svc.getRound(actor, params.id)));
officeRouter.post(
  '/rounds/:id',
  route(
    {
      permission: 'officeboy:rounds',
      params: idParam,
      body: z.object({
        areas: z.array(z.object({ name: z.string().min(1).max(80), clean: z.boolean(), note: z.string().max(1000).optional() })).min(1).max(40),
        stockOk: z.boolean(),
        stockNotes: z.string().max(2000).optional(),
        issues: z.string().max(2000).optional(),
        demandsReviewed: z.boolean().optional(),
        attachmentIds: z.array(z.string().min(1).max(64)).max(8).default([]),
      }),
    },
    async ({ actor, params, body }) => svc.submitRound(actor, params.id, body),
  ),
);

/** Stock demands — Assistant and Office Boy (spec §12–13). Mounted at /stock. */
export const stockRouter = Router();
stockRouter.get('/items', route({ permission: 'stock:demand_create' }, async () => ({ items: await stockForUsage() })));
stockRouter.get('/demands/mine', route({ permission: 'stock:demand_create' }, async ({ actor }) => demands.myDemands(actor)));
stockRouter.post(
  '/demands',
  route(
    {
      permission: 'stock:demand_create',
      idempotent: true,
      status: 201,
      body: z.object({ lines: z.array(z.object({ itemId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(100_000) })).min(1).max(30), reason: z.string().trim().min(3).max(2000) }),
    },
    async ({ actor, body }) => demands.createDemand(actor, body),
  ),
);

/** Manager / MD read of Office Boy rounds (screens in Phase 8). Mounted at /manager. */
export const managerOfficeRouter = Router();
managerOfficeRouter.get('/office-rounds', route({ permission: 'manager:staff_review', query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }, async ({ query }) => svc.roundsFor(query.date)));
