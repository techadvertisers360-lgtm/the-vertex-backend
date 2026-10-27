import { Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { idParam, route } from '../../middleware/route';
import { doctorsToday } from '../reception/service';
import * as auditSvc from './audit';
import { dashboard } from './dashboard';
import * as followups from './followups';
import * as reports from './reports';
import * as schedule from './schedule';
import * as doctorHours from './doctorHours';
import * as doctorsAdmin from './doctorsAdmin';
import * as roomsAdmin from './roomsAdmin';
import * as staff from './staff';
import * as stockChecks from './stockChecks';

/** Manager operations (spec §14). Mounted at /manager next to the room/procedure, office and approvals routers. */
export const managerRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reason = z.string().trim().min(2).max(2000);

managerRouter.get('/dashboard', route({ permission: 'manager:dashboard' }, async ({ actor }) => dashboard(actor)));

// Procedure stock checks created 2 days before each procedure (spec §19)
managerRouter.get('/stock-checks', route({ permission: 'stock:manage', query: z.object({ scope: z.enum(['open', 'done']).default('open') }) }, async ({ query }) => stockChecks.list(query.scope)));
managerRouter.post('/stock-checks/:id/complete', route({ permission: 'stock:manage', params: idParam, body: z.object({ note: z.string().trim().max(2000).optional() }) }, async ({ actor, params, body }) => stockChecks.complete(actor, params.id, body.note)));

// Staff arrival review, Office Boy areas, Assistants
managerRouter.get('/staff', route({ permission: 'manager:staff_review' }, async () => staff.staffToday()));
managerRouter.post(
  '/staff/:id/review',
  route(
    {
      permission: 'manager:staff_review',
      params: idParam,
      status: 201,
      body: z.object({ uniformOk: z.boolean(), hairOk: z.boolean(), nailsOk: z.boolean(), rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional(), improvementNote: z.string().max(2000).optional() }),
    },
    async ({ actor, params, body }) => staff.reviewArrival(actor, params.id, body),
  ),
);
managerRouter.get('/assistants', route({ permission: 'manager:room_assign' }, async () => staff.assistants()));
managerRouter.get('/office-areas', route({ permission: 'manager:staff_review' }, async () => staff.officeAreas()));
managerRouter.put(
  '/office-areas',
  route({ permission: 'manager:staff_review', body: z.object({ areas: z.array(z.string().trim().min(1).max(80)).min(1).max(40) }) }, async ({ actor, body }) => staff.setOfficeAreas(actor, body.areas)),
);

// Report verification (room checklists, Office Boy rounds)
const reportQuery = z.object({ scope: z.enum(['open', 'day']).default('open'), date: isoDate.optional() });
managerRouter.get('/reports/rooms', route({ permission: 'manager:room_verify', query: reportQuery }, async ({ query }) => reports.roomReports(query)));
managerRouter.get('/reports/rounds', route({ permission: 'manager:room_verify', query: reportQuery }, async ({ query }) => reports.officeRounds(query)));
managerRouter.post(
  '/reports/:type/:id/verify',
  route(
    {
      permission: 'manager:room_verify',
      params: z.object({ type: z.enum(['RoomChecklistReport', 'OfficeRound']), id: z.string().min(1).max(64) }),
      body: z.object({ status: z.enum(['VERIFIED', 'RETURNED', 'ESCALATED']), comment: z.string().max(2000).optional() }),
    },
    async ({ actor, params, body }) => reports.verifyReport(actor, params.type, params.id, body),
  ),
);

// Doctors, leave impact, reschedule
managerRouter.get('/doctors-today', route({ permission: 'availability:approve' }, async () => doctorsToday()));
managerRouter.get('/doctors/:id/day', route({ permission: 'availability:approve', params: idParam, query: z.object({ date: isoDate.optional() }) }, async ({ params, query }) => schedule.doctorDay(params.id, query.date)));
// Rooms: add / edit / take out of use (D-051)
const roomKind = z.enum(['CONSULT', 'PROCEDURE', 'CONSULT_PROCEDURE']);
managerRouter.get('/rooms-admin', route({ permission: 'availability:approve' }, async () => roomsAdmin.listRooms()));
managerRouter.post(
  '/rooms-admin',
  route({ permission: 'availability:approve', status: 201, body: z.object({ code: z.string().trim().min(1).max(20), name: z.string().max(60).optional(), kind: roomKind }) }, async ({ actor, body }) => roomsAdmin.createRoom(actor, body)),
);
managerRouter.patch(
  '/rooms-admin/:id',
  route(
    { permission: 'availability:approve', params: idParam, body: z.object({ code: z.string().trim().min(1).max(20).optional(), name: z.string().max(60).optional(), kind: roomKind.optional(), active: z.boolean().optional(), sortOrder: z.number().int().min(0).max(999).optional() }) },
    async ({ actor, params, body }) => roomsAdmin.updateRoom(actor, params.id, body),
  ),
);
managerRouter.delete('/rooms-admin/:id', route({ permission: 'availability:approve', params: idParam }, async ({ actor, params }) => roomsAdmin.deleteRoom(actor, params.id)));
// Doctors: add / edit profile / switch off or back on (D-064)
const doctorFields = {
  displayName: z.string().trim().min(2).max(100),
  specialty: z.string().max(120).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
  email: z.union([z.string().trim().email().max(120), z.literal('')]).nullable().optional(),
  phone: z.string().max(20).nullable().optional(),
  memberCode: z.union([z.string().trim().regex(/^[A-Za-z0-9-]{3,20}$/), z.literal('')]).nullable().optional(),
};
managerRouter.get('/doctors-admin', route({ permission: 'users:manage' }, async ({ actor }) => doctorsAdmin.listDoctors(actor)));
managerRouter.post(
  '/doctors-admin',
  route({ permission: 'users:manage', status: 201, body: z.object({ ...doctorFields, password: z.string().min(8).max(200) }) }, async ({ actor, body }) => doctorsAdmin.createDoctor(actor, body)),
);
managerRouter.patch(
  '/doctors-admin/:id',
  route({ permission: 'users:manage', params: idParam, body: z.object(doctorFields).partial() }, async ({ actor, params, body }) => doctorsAdmin.updateDoctor(actor, params.id, body)),
);
managerRouter.put(
  '/doctors-admin/:id/active',
  route({ permission: 'users:manage', params: idParam, body: z.object({ active: z.boolean() }) }, async ({ actor, params, body }) => doctorsAdmin.setDoctorActive(actor, params.id, body.active)),
);
// Doctor weekly hours + consultation room (D-049)
managerRouter.get('/doctor-hours', route({ permission: 'availability:approve' }, async () => doctorHours.list()));
managerRouter.put(
  '/doctor-hours/:id',
  route(
    {
      permission: 'availability:approve',
      params: idParam,
      body: z.object({
        effectiveFrom: isoDate,
        days: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: z.string().max(5), end: z.string().max(5) })).max(28),
      }),
    },
    async ({ actor, params, body }) => doctorHours.saveHours(actor, params.id, body),
  ),
);
managerRouter.put(
  '/doctor-hours/:id/room',
  route({ permission: 'availability:approve', params: idParam, body: z.object({ roomId: z.string().min(1).max(64).nullable() }) }, async ({ actor, params, body }) => doctorHours.setRoom(actor, params.id, body.roomId)),
);
managerRouter.get('/leave-impacts', route({ permission: 'availability:approve' }, async () => schedule.leaveImpacts()));
managerRouter.post('/leave-impacts/:id/resolve', route({ permission: 'availability:approve', params: idParam }, async ({ actor, params }) => schedule.resolveLeaveImpact(actor, params.id)));
managerRouter.get('/reschedule-requests', route({ permission: 'appointments:reschedule_approve' }, async () => schedule.rescheduleRequests()));
managerRouter.post(
  '/reschedule-requests/:id/reject',
  route({ permission: 'appointments:reschedule_approve', params: idParam, body: z.object({ reason }) }, async ({ actor, params, body }) => schedule.rejectRescheduleRequest(actor, params.id, body.reason)),
);
managerRouter.post(
  '/appointments/:id/reschedule',
  route(
    {
      permission: 'appointments:reschedule_approve',
      params: idParam,
      idempotent: true,
      body: z.object({ start: z.coerce.date(), roomId: z.string().optional(), reason, patientConfirmed: z.boolean(), doctorConfirmed: z.boolean(), requestId: z.string().optional() }),
    },
    async ({ actor, params, body }) => schedule.managerReschedule(actor, params.id, body),
  ),
);
managerRouter.post(
  '/appointments/:id/cancel',
  route({ permission: 'appointments:reschedule_approve', params: idParam, body: z.object({ reason }) }, async ({ actor, params, body }) => schedule.managerCancel(actor, params.id, body.reason)),
);

// Patient follow-ups
managerRouter.get('/followups', route({ permission: 'manager:followups', query: z.object({ scope: z.enum(['pending', 'done']).default('pending'), date: isoDate.optional() }) }, async ({ query }) => followups.list(query.scope, query.date)));
const stars = z.number().int().min(1).max(5).optional();
managerRouter.post(
  '/followups/:id',
  route(
    {
      permission: 'manager:followups',
      params: idParam,
      body: z.object({ doctorRating: stars, staffRating: stars, clinicRating: stars, issue: z.string().max(4000).optional(), suggestion: z.string().max(4000).optional(), escalateToMd: z.boolean().default(false) }),
    },
    async ({ actor, params, body }) => followups.complete(actor, params.id, body),
  ),
);

// Audit / history search
managerRouter.get(
  '/audit',
  route(
    {
      permission: 'audit:search',
      query: z.object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        actorId: z.string().max(64).optional(),
        role: z.nativeEnum(Role).optional(),
        action: z.string().max(80).optional(),
        recordType: z.string().max(60).optional(),
        recordId: z.string().max(64).optional(),
        patientId: z.string().max(64).optional(),
        appointmentId: z.string().max(64).optional(),
        stockItemId: z.string().max(64).optional(),
        requestId: z.string().max(64).optional(),
        cursor: z.string().regex(/^\d+$/).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ actor, query }) => auditSvc.search(actor, query),
  ),
);
managerRouter.get('/audit/lookups', route({ permission: 'audit:search' }, async () => auditSvc.lookups()));
