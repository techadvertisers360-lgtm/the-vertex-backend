import { Router } from 'express';
import { z } from 'zod';
import { AvailabilityKind } from '@prisma/client';
import { idParam, route } from '../../middleware/route';
import * as svc from './service';

/** Doctor endpoints (spec §10–11). Every appointment action re-checks `doctorId === me` in the service. */
export const doctorRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paisa = z.number().int().min(0).max(1_000_000_000_00);

doctorRouter.get('/queue', route({ permission: 'doctor:queue', query: z.object({ date: isoDate.optional() }) }, async ({ actor, query }) => svc.queue(actor, query.date)));
doctorRouter.post('/appointments/:id/accept', route({ permission: 'doctor:queue', params: idParam }, async ({ actor, params }) => svc.accept(actor, params.id)));
doctorRouter.get('/appointments/:id', route({ permission: 'doctor:queue', params: idParam }, async ({ actor, params }) => svc.getConsultation(actor, params.id)));

doctorRouter.put(
  '/appointments/:id/plan',
  route(
    {
      permission: 'doctor:plan',
      params: idParam,
      body: z.object({
        consultationReason: z.string().min(2).max(2000),
        consultationFeePaisa: paisa,
        consultationFeeWaived: z.boolean().default(false),
        consultationDiscountPaisa: paisa.default(0),
        items: z
          .array(
            z.object({
              serviceId: z.string().optional(),
              procedureName: z.string().min(1).max(200),
              sameDay: z.boolean(),
              start: z.coerce.date().optional(),
              roomId: z.string().optional(),
              pricePaisa: paisa,
              discountPaisa: paisa.default(0),
            }),
          )
          .max(12),
        totalDiscountPaisa: paisa.default(0),
        advanceRequestedPaisa: paisa.default(0),
        installmentCount: z.number().int().min(0).max(12).default(0),
        firstInstallmentDate: isoDate.optional(),
        installmentIntervalDays: z.number().int().min(1).max(365).optional(),
      }),
    },
    async ({ actor, params, body }) => svc.savePlan(actor, params.id, body),
  ),
);

doctorRouter.post('/appointments/:id/send-to-reception', route({ permission: 'doctor:plan', params: idParam }, async ({ actor, params }) => svc.sendToReception(actor, params.id)));

doctorRouter.get('/patients', route({ permission: 'doctor:history_own', query: z.object({ q: z.string().max(80).optional() }) }, async ({ actor, query }) => svc.myPatients(actor, query.q)));
doctorRouter.get('/patients/:id/history', route({ permission: 'doctor:history_own', params: idParam }, async ({ actor, params }) => svc.patientHistory(actor, params.id)));

doctorRouter.get('/history-requests', route({ permission: 'doctor:history_request' }, async ({ actor }) => svc.myHistoryRequests(actor)));
doctorRouter.post(
  '/history-requests',
  route({ permission: 'doctor:history_request', status: 201, body: z.object({ phone: z.string().min(7).max(20), reason: z.string().min(5).max(1000) }) }, async ({ actor, body }) =>
    svc.requestHistoryAccess(actor, body.phone, body.reason),
  ),
);

const availabilityBody = z.object({
  kind: z.nativeEnum(AvailabilityKind),
  date: isoDate,
  startMinute: z.number().int().min(0).max(1440).optional(),
  endMinute: z.number().int().min(0).max(1440).optional(),
  reason: z.string().max(1000).optional(),
});
doctorRouter.get('/availability', route({ permission: 'availability:own' }, async ({ actor }) => svc.myAvailability(actor)));
doctorRouter.post('/availability/preview', route({ permission: 'availability:own', body: availabilityBody }, async ({ actor, body }) => svc.leaveImpact(actor.id!, body)));
doctorRouter.post('/availability', route({ permission: 'availability:own', status: 201, body: availabilityBody }, async ({ actor, body }) => svc.setAvailability(actor, body)));

doctorRouter.get('/aftercare', route({ permission: 'doctor:aftercare' }, async ({ actor }) => svc.aftercareQueue(actor)));
doctorRouter.post(
  '/appointments/:id/aftercare',
  route({ permission: 'doctor:aftercare', params: idParam, body: z.object({ skip: z.boolean().default(false), content: z.string().max(4000).optional() }) }, async ({ actor, params, body }) =>
    svc.sendAftercare(actor, params.id, body),
  ),
);

/** Manager approvals needed by the Doctor workflow (full Manager screens in Phase 8). */
export const managerApprovalsRouter = Router();
const decision = z.object({ approve: z.boolean(), reason: z.string().max(1000).optional() });
managerApprovalsRouter.get('/', route({ permission: ['manager:approvals', 'availability:approve'] }, async () => svc.pendingApprovals()));
managerApprovalsRouter.post('/history-access/:id', route({ permission: 'manager:approvals', params: idParam, body: decision }, async ({ actor, params, body }) => svc.decideHistoryAccess(actor, params.id, body.approve, body.reason)));
managerApprovalsRouter.post('/alternate-hours/:id', route({ permission: 'availability:approve', params: idParam, body: decision }, async ({ actor, params, body }) => svc.decideAlternateHours(actor, params.id, body.approve, body.reason)));
