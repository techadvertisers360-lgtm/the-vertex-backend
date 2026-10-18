import { Router } from 'express';
import { z } from 'zod';
import { AppointmentStatus, AppointmentType, PaymentMethod } from '@prisma/client';
import { idParam, route } from '../../middleware/route';
import * as svc from './service';

/** Receptionist endpoints (spec §9). Manager may use the read views too. */
export const receptionRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rating = z.number().int().min(1).max(5);

receptionRouter.get('/search', route({ permission: 'patients:search', query: z.object({ q: z.string().max(80) }) }, async ({ query }) => svc.search(query.q)));

receptionRouter.post(
  '/patients',
  route(
    {
      permission: 'patients:create',
      status: 201,
      body: z.object({
        name: z.string().min(2).max(120),
        phone: z.string().min(7).max(20),
        contactConsent: z.boolean(),
        whatsappConsent: z.boolean(),
        ageYears: z.number().int().min(0).max(120).optional(),
        gender: z.string().max(20).optional(),
        confirmSharedPhone: z.object({ reason: z.string().min(3).max(300) }).optional(),
      }),
    },
    async ({ actor, body }) => svc.newPatient(actor, body),
  ),
);

receptionRouter.get('/patients/:id', route({ permission: 'patients:search', params: idParam }, async ({ params }) => svc.patientDetail(params.id)));

receptionRouter.get(
  '/appointments',
  route(
    {
      permission: ['reception:checkin', 'manager:dashboard'],
      query: z.object({
        date: isoDate.optional(),
        status: z.nativeEnum(AppointmentStatus).optional(),
        doctorId: z.string().optional(),
        q: z.string().max(80).optional(),
        active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      }),
    },
    async ({ query }) => svc.listAppointments(query),
  ),
);

receptionRouter.post(
  '/appointments',
  route(
    {
      permission: 'appointments:book',
      idempotent: true,
      status: 201,
      body: z.object({
        patientId: z.string().min(1),
        doctorId: z.string().min(1),
        type: z.nativeEnum(AppointmentType),
        serviceId: z.string().optional(),
        reason: z.string().max(1000).optional(),
        start: z.coerce.date(),
        roomId: z.string().optional(),
      }),
    },
    async ({ actor, body, idempotencyKey }) => svc.book(actor, body, idempotencyKey!),
  ),
);

receptionRouter.post(
  '/appointments/:id/cancel',
  route({ permission: 'reception:checkin', params: idParam, body: z.object({ reason: z.string().min(2).max(500) }) }, async ({ actor, params, body }) => svc.cancel(actor, params.id, body.reason)),
);

receptionRouter.post('/appointments/:id/check-in', route({ permission: 'reception:checkin', params: idParam }, async ({ actor, params }) => svc.checkIn(actor, params.id)));

receptionRouter.post(
  '/appointments/:id/vitals',
  route(
    {
      permission: 'reception:vitals',
      params: idParam,
      status: 201,
      body: z.object({
        skip: z.boolean().optional(),
        skipReason: z.string().max(300).optional(),
        bpSystolic: z.number().int().min(40).max(300).optional(),
        bpDiastolic: z.number().int().min(20).max(200).optional(),
        glucoseMgDl: z.number().int().min(10).max(1000).optional(),
        weightKg: z.number().min(0.5).max(400).optional(),
        heightCm: z.number().min(20).max(260).optional(),
      }),
    },
    async ({ actor, params, body }) => svc.recordVitals(actor, params.id, body),
  ),
);

receptionRouter.get('/tracker', route({ permission: ['reception:checkin', 'manager:dashboard'], query: z.object({ date: isoDate.optional() }) }, async ({ query }) => svc.tracker(query.date)));
receptionRouter.get('/doctors-today', route({ permission: ['reception:checkin', 'manager:dashboard'] }, async () => svc.doctorsToday()));
receptionRouter.get('/done', route({ permission: ['reception:checkin', 'manager:dashboard'], query: z.object({ date: isoDate.optional() }) }, async ({ query }) => svc.doneList(query.date)));

// Billing
receptionRouter.post('/appointments/:id/invoice', route({ permission: 'reception:billing', params: idParam, status: 201 }, async ({ actor, params }) => svc.openInvoice(actor, params.id)));
receptionRouter.get('/invoices/:id', route({ permission: 'reception:billing', params: idParam }, async ({ params }) => svc.invoiceDetail(params.id)));
receptionRouter.post(
  '/invoices/:id/payments',
  route(
    {
      permission: 'reception:billing',
      params: idParam,
      idempotent: true,
      status: 201,
      body: z.object({
        amountPaisa: z.number().int().positive(),
        method: z.nativeEnum(PaymentMethod),
        reference: z.string().max(100).optional(),
        bankAccountId: z.string().optional(),
      }),
    },
    async ({ actor, params, body, idempotencyKey }) => svc.recordPayment(actor, params.id, body, idempotencyKey!),
  ),
);
receptionRouter.post('/invoices/:id/close', route({ permission: 'reception:billing', params: idParam }, async ({ actor, params }) => svc.closeInvoice(actor, params.id)));
receptionRouter.get('/bank-accounts', route({ permission: 'reception:billing' }, async () => ({ items: await svc.bankAccounts() })));

receptionRouter.post(
  '/appointments/:id/feedback',
  route(
    {
      permission: 'reception:feedback',
      params: idParam,
      body: z.object({ skip: z.boolean().optional(), doctorRating: rating.optional(), staffRating: rating.optional(), clinicRating: rating.optional(), suggestion: z.string().max(2000).optional() }),
    },
    async ({ actor, params, body }) => svc.saveFeedback(actor, params.id, body),
  ),
);

// Patient complaint → Manager inbox; reschedule request → Manager
receptionRouter.post(
  '/complaints',
  route(
    { permission: 'complaints:patient', status: 201, body: z.object({ patientId: z.string().min(1), appointmentId: z.string().optional(), subject: z.string().min(2).max(200), detail: z.string().min(2).max(5000) }) },
    async ({ actor, body }) => svc.patientComplaint(actor, body),
  ),
);
receptionRouter.post(
  '/appointments/:id/reschedule-request',
  route(
    { permission: 'appointments:reschedule_request', params: idParam, status: 201, body: z.object({ requestedStartAt: z.coerce.date().optional(), reason: z.string().min(2).max(1000) }) },
    async ({ actor, params, body }) => svc.rescheduleRequest(actor, params.id, body),
  ),
);
