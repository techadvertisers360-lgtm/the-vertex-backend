import { Router } from 'express';
import { z } from 'zod';
import { AppointmentType, LeadActivityChannel, LeadActivityResult, LeadStatus } from '@prisma/client';
import { addDaysStr, clinicDateStr } from '../../lib/time';
import { idParam, paging, route } from '../../middleware/route';
import { breakdown, computeMetrics, drilldown, type MetricKey } from './metrics';
import * as svc from './service';

/** Lead Team Member endpoints (spec §7–8). Every handler re-checks sheet / own-booking scope in the service. */
export const leadRouter = Router();
const P = 'leads:own' as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

leadRouter.get('/sheets', route({ permission: P }, async ({ actor }) => ({ items: await svc.listMySheets(actor) })));
leadRouter.get('/sheets/:id', route({ permission: P, params: idParam }, async ({ actor, params }) => svc.getMySheet(actor, params.id)));

leadRouter.get(
  '/leads',
  route(
    {
      permission: P,
      query: z.object({
        sheetId: z.string().optional(),
        status: z.nativeEnum(LeadStatus).optional(),
        q: z.string().max(80).optional(),
        due: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        ...paging,
      }),
    },
    async ({ actor, query }) => svc.listLeads(actor, query),
  ),
);

leadRouter.get('/leads/:id', route({ permission: P, params: idParam }, async ({ actor, params }) => svc.getLead(actor, params.id)));

leadRouter.post(
  '/leads/:id/activities',
  route(
    {
      permission: P,
      params: idParam,
      status: 201,
      body: z.object({
        channel: z.nativeEnum(LeadActivityChannel),
        result: z.nativeEnum(LeadActivityResult).optional(),
        remarks: z.string().max(2000).optional(),
        status: z.enum(['NOT_INTERESTED', 'UNREACHABLE', 'CONTACTED']).optional(),
      }),
    },
    async ({ actor, params, body }) => svc.logActivity(actor, params.id, body),
  ),
);

leadRouter.post(
  '/leads/:id/follow-up',
  route(
    {
      permission: P,
      params: idParam,
      status: 201,
      body: z.object({ preset: z.enum(['2h', '2d', 'custom']), at: z.coerce.date().optional() }),
    },
    async ({ actor, params, body }) => svc.setFollowUp(actor, params.id, body.preset, body.at),
  ),
);

leadRouter.get(
  '/callbacks',
  route({ permission: P, query: z.object({ state: z.enum(['due', 'upcoming', 'all']).default('due') }) }, async ({ actor, query }) => ({
    items: await svc.listCallbacks(actor, query.state),
  })),
);

const patientInput = z.object({
  existingPatientId: z.string().optional(),
  name: z.string().min(2).max(120).optional(),
  phone: z.string().min(7).max(20).optional(),
  contactConsent: z.boolean().optional(),
  whatsappConsent: z.boolean().optional(),
  ageYears: z.number().int().min(0).max(120).optional(),
  gender: z.string().max(20).optional(),
  confirmSharedPhone: z.object({ reason: z.string().min(3).max(300) }).optional(),
});

leadRouter.post(
  '/leads/:id/book',
  route(
    {
      permission: 'appointments:book',
      params: idParam,
      idempotent: true,
      status: 201,
      body: z.object({
        patient: patientInput,
        doctorId: z.string().min(1),
        type: z.nativeEnum(AppointmentType),
        serviceId: z.string().optional(),
        reason: z.string().max(1000).optional(),
        start: z.coerce.date(),
        roomId: z.string().optional(),
      }),
    },
    async ({ actor, params, body, idempotencyKey }) => svc.bookFromLead(actor, params.id, body, idempotencyKey!),
  ),
);

leadRouter.get(
  '/appointments',
  route({ permission: 'appointments:read', query: z.object({ bucket: z.enum(['today', 'after2', 'after7', 'total']).default('today') }) }, async ({ actor, query }) =>
    svc.listMyAppointments(actor, query.bucket),
  ),
);

leadRouter.post(
  '/appointments/:id/reschedule',
  route(
    { permission: 'appointments:reschedule', params: idParam, body: z.object({ start: z.coerce.date(), roomId: z.string().optional(), reason: z.string().min(2).max(500) }) },
    async ({ actor, params, body }) => svc.rescheduleOwnBooking(actor, params.id, body.start, body.reason, body.roomId),
  ),
);

leadRouter.post(
  '/appointments/:id/cancel',
  route({ permission: 'appointments:reschedule', params: idParam, body: z.object({ reason: z.string().min(2).max(500) }) }, async ({ actor, params, body }) =>
    svc.cancelOwnBooking(actor, params.id, body.reason),
  ),
);

const METRICS = ['leads', 'contacted', 'calls', 'whatsapp', 'bookings', 'checkIns', 'cancellations', 'noShows', 'callbacksDue', 'callbacksOnTime', 'callbacksOverdue'] as const;
const periodQuery = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};
function period(q: { from?: string; to?: string }) {
  const today = clinicDateStr(new Date());
  return { from: q.from ?? addDaysStr(today, -29), to: q.to ?? today };
}

/** Member's own performance with drill-down (spec §7 attribution). */
leadRouter.get(
  '/performance',
  route({ permission: P, query: z.object({ ...periodQuery, sheetId: z.string().optional() }) }, async ({ actor, query }) => {
    const ids = await svc.mySheetIds(actor.id!);
    return computeMetrics({ ...period(query), memberId: actor.id!, sheetId: query.sheetId && ids.includes(query.sheetId) ? query.sheetId : undefined });
  }),
);

leadRouter.get(
  '/performance/drilldown',
  route({ permission: P, query: z.object({ ...periodQuery, metric: z.enum(METRICS) }) }, async ({ actor, query }) => ({
    items: await drilldown(query.metric as MetricKey, { ...period(query), memberId: actor.id! }),
  })),
);

/** Leadership / marketing reports across members and campaigns (spec §8, §16, §17). */
export const leadReportsRouter = Router();

leadReportsRouter.get(
  '/performance',
  route({ permission: 'leads:reports', query: z.object({ ...periodQuery, memberId: z.string().optional(), sheetId: z.string().optional() }) }, async ({ query }) =>
    query.memberId || query.sheetId ? computeMetrics({ ...period(query), memberId: query.memberId, sheetId: query.sheetId }) : breakdown(period(query)),
  ),
);

leadReportsRouter.get(
  '/performance/drilldown',
  route(
    { permission: 'leads:reports', query: z.object({ ...periodQuery, metric: z.enum(METRICS), memberId: z.string().optional(), sheetId: z.string().optional() }) },
    async ({ query }) => ({ items: await drilldown(query.metric as MetricKey, { ...period(query), memberId: query.memberId, sheetId: query.sheetId }) }),
  ),
);
