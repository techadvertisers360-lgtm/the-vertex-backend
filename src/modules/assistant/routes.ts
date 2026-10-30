import { Router } from 'express';
import { z } from 'zod';
import { idParam, route } from '../../middleware/route';
import { stockForUsage } from '../../services/stock';
import * as attendance from '../attendance/service';
import * as proc from '../procedures/service';
import * as rooms from './rooms';

/** Assistant endpoints (spec §12). Each procedure/room action re-checks that it is assigned to the caller. */
export const assistantRouter = Router();

const id = z.string().min(1).max(64);
const reason = z.string().trim().min(3).max(1000);

assistantRouter.get(
  '/today',
  route({ permission: 'assistant:tasks' }, async ({ actor }) => {
    const [att, r, p] = await Promise.all([attendance.today(actor), rooms.myRooms(actor), proc.myProcedures(actor)]);
    return { attendance: att, rooms: r.items, procedures: p.items };
  }),
);

assistantRouter.get('/rooms', route({ permission: 'assistant:rooms' }, async ({ actor }) => rooms.myRooms(actor)));
assistantRouter.post('/rooms/:id/accept', route({ permission: 'assistant:rooms', params: idParam }, async ({ actor, params }) => rooms.acceptRoom(actor, params.id)));
assistantRouter.post(
  '/rooms/:id/checklist',
  route(
    {
      permission: 'assistant:rooms',
      params: idParam,
      status: 201,
      body: z.object({
        kind: z.enum(['OPENING', 'CLOSING']),
        machineOk: z.boolean(),
        machineIssue: z.string().max(2000).optional(),
        roomNeat: z.boolean(),
        disinfected: z.boolean(),
        stockOk: z.boolean(),
        stockNotes: z.string().max(2000).optional(),
        demandSkipped: z.boolean().default(false),
        attachmentIds: z.array(id).max(8).default([]),
      }),
    },
    async ({ actor, params, body }) => rooms.submitChecklist(actor, params.id, body),
  ),
);

assistantRouter.get('/procedures', route({ permission: 'assistant:tasks' }, async ({ actor }) => proc.myProcedures(actor)));
/** Today's released planned sessions in my duty rooms (read-only until Reception assigns at check-in). Before /:id. */
assistantRouter.get('/procedures/planned', route({ permission: 'assistant:tasks' }, async ({ actor }) => proc.plannedToday(actor.id!)));
assistantRouter.get('/procedures/:id', route({ permission: 'assistant:tasks', params: idParam }, async ({ actor, params }) => proc.procedureDetail(actor, params.id)));
assistantRouter.post('/procedures/:id/accept', route({ permission: 'assistant:tasks', params: idParam }, async ({ actor, params }) => proc.acceptProcedure(actor, params.id)));
assistantRouter.post(
  '/procedures/:id/consent',
  route({ permission: 'assistant:tasks', params: idParam, body: z.object({ attachmentId: id }) }, async ({ actor, params, body }) => proc.recordConsent(actor, params.id, body.attachmentId)),
);
const photoBody = z.object({ attachmentId: id.optional(), attachmentIds: z.array(id).max(30).optional(), skipReason: z.string().max(1000).optional() });
assistantRouter.post('/procedures/:id/before-photo', route({ permission: 'assistant:tasks', params: idParam, body: photoBody }, async ({ actor, params, body }) => proc.recordPhoto(actor, params.id, 'before', body)));
assistantRouter.post('/procedures/:id/start', route({ permission: 'assistant:tasks', params: idParam }, async ({ actor, params }) => proc.startProcedure(actor, params.id)));
assistantRouter.post('/procedures/:id/finish', route({ permission: 'assistant:tasks', params: idParam }, async ({ actor, params }) => proc.finishProcedure(actor, params.id)));
assistantRouter.post('/procedures/:id/after-photo', route({ permission: 'assistant:tasks', params: idParam, body: photoBody }, async ({ actor, params, body }) => proc.recordPhoto(actor, params.id, 'after', body)));
assistantRouter.post(
  '/procedures/:id/items',
  route(
    {
      permission: 'assistant:tasks',
      params: idParam,
      idempotent: true,
      body: z.object({
        lines: z.array(z.object({ itemId: id, quantity: z.number().int().min(1).max(100_000) })).max(30),
        evidenceAttachmentIds: z.array(id).max(8).default([]),
        noItems: z.boolean().default(false),
      }),
    },
    async ({ actor, params, body }) => proc.recordItemsUsed(actor, params.id, body),
  ),
);
assistantRouter.post('/procedures/:id/send-to-reception', route({ permission: 'assistant:tasks', params: idParam }, async ({ actor, params }) => proc.sendToReception(actor, params.id)));
assistantRouter.post('/procedures/:id/clean', route({ permission: 'assistant:tasks', params: idParam, body: z.object({ attachmentId: id }) }, async ({ actor, params, body }) => proc.recordClean(actor, params.id, body.attachmentId)));
assistantRouter.post('/procedures/:id/emergency', route({ permission: 'assistant:tasks', params: idParam, body: z.object({ reason }) }, async ({ actor, params, body }) => proc.raiseEmergency(actor, params.id, body.reason)));

/** Names, units and usable quantity only — no cost (spec §4). */
assistantRouter.get('/stock-items', route({ permission: 'assistant:tasks' }, async () => ({ items: await stockForUsage() })));

/** Reception: same-day + session procedure assignment (spec §9) and the upcoming list. Mounted at /reception. */
export const receptionProceduresRouter = Router();
receptionProceduresRouter.get('/procedures/pending', route({ permission: 'reception:assign_procedure' }, async () => proc.pendingAssignments()));
receptionProceduresRouter.get('/procedures/active', route({ permission: 'reception:assign_procedure' }, async () => proc.activeTasks()));
receptionProceduresRouter.get('/procedures/planned-today', route({ permission: 'reception:assign_procedure' }, async () => proc.plannedToday()));
receptionProceduresRouter.get(
  '/procedures/options',
  route({ permission: 'reception:assign_procedure', query: z.object({ planItemId: id }) }, async ({ query }) => proc.assignOptions(query.planItemId)),
);
receptionProceduresRouter.post(
  '/procedures/assign',
  route({ permission: 'reception:assign_procedure', idempotent: true, status: 201, body: z.object({ planItemId: id, assistantId: id, roomId: id }) }, async ({ actor, body }) => proc.assign(actor, body)),
);
receptionProceduresRouter.get(
  '/upcoming',
  route({ permission: 'reception:assign_procedure', query: z.object({ days: z.coerce.number().int().min(1).max(60).default(14) }) }, async ({ query }) => proc.upcoming(query.days)),
);

/** Manager: room duty and emergency replacement (spec §6, §12). Mounted at /manager. */
export const managerProceduresRouter = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
managerProceduresRouter.get('/room-assignments', route({ permission: 'manager:room_assign', query: z.object({ date: isoDate.optional() }) }, async ({ query }) => rooms.listAssignments(undefined, query.date)));
managerProceduresRouter.post(
  '/room-assignments',
  route({ permission: 'manager:room_assign', body: z.object({ assistantId: id, roomIds: z.array(id).min(1).max(6), date: isoDate.optional() }) }, async ({ actor, body }) => rooms.assignRooms(actor, body)),
);
managerProceduresRouter.get('/procedures', route({ permission: 'manager:room_assign' }, async () => proc.activeTasks()));
managerProceduresRouter.get('/procedures/planned-today', route({ permission: 'manager:room_assign' }, async () => proc.plannedToday()));
managerProceduresRouter.post(
  '/procedures/:id/replace',
  route({ permission: 'manager:approvals', params: idParam, body: z.object({ assistantId: id, reason }) }, async ({ actor, params, body }) => proc.replaceAssistant(actor, params.id, body.assistantId, body.reason)),
);
