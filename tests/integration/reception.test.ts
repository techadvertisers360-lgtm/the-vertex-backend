import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addDaysStr, atClinicMinute, clinicDateStr, dateOnly } from '../../src/lib/time';
import { runInstallmentReminders } from '../../src/services/installments';
import { normalizePhone } from '../../src/lib/phone';
import { agentFor, app, call, doctorWithHours, ensureRooms, lastAudit, makeUser, newKey, prisma, uniquePhone } from './helpers';

beforeAll(async () => {
  await ensureRooms();
  await makeUser('MANAGER');
  if (!(await prisma.bankAccount.findFirst({ where: { active: true } }))) {
    await prisma.bankAccount.create({ data: { name: 'Test Bank', bankName: 'Test', accountNo: 'PK00TEST' } });
  }
});

async function reception() {
  const { user, agent } = await agentFor('RECEPTIONIST');
  return { user, api: call(agent) };
}

async function patient(createdById: string, phoneRaw = uniquePhone()) {
  return prisma.patient.create({ data: { name: 'Front Desk Patient', phone: normalizePhone(phoneRaw)!, createdById, whatsappConsent: true } });
}

/** An appointment for *today* in a given status (rows are created directly so tests don't depend on the clock). */
async function todayAppt(opts: { doctorId: string; patientId: string; createdById: string; status?: 'CONFIRMED' | 'RECEPTION' | 'WAITING'; leadMemberId?: string; serviceId?: string }) {
  const now = new Date();
  return prisma.appointment.create({
    data: {
      patientId: opts.patientId,
      doctorId: opts.doctorId,
      type: 'CONSULTATION',
      startAt: now,
      endAt: new Date(now.getTime() + 20 * 60_000),
      status: opts.status ?? 'CONFIRMED',
      source: opts.leadMemberId ? 'LEAD' : 'RECEPTION',
      createdById: opts.createdById,
      leadMemberId: opts.leadMemberId ?? null,
      serviceId: opts.serviceId ?? null,
    },
  });
}

describe('search & new patient (spec §9, §24)', () => {
  it('finds patients by normalized phone and name; shows previous visits', async () => {
    const r = await reception();
    const raw = uniquePhone();
    const p = await patient(r.user.id, raw);
    const res = await r.api.get(`/api/reception/search?q=${encodeURIComponent('+92 ' + raw.slice(1))}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((x: { id: string }) => x.id)).toContain(p.id);
    expect(res.body.items[0]).toHaveProperty('previousVisits');
  });

  it('new patient: invalid phone is a field error; duplicate phone warns with existing patient; confirmation is audited', async () => {
    const r = await reception();
    expect((await r.api.post('/api/reception/patients', { name: 'Bad', phone: '12345', contactConsent: true, whatsappConsent: true })).status).toBe(422);
    const raw = uniquePhone();
    const first = await r.api.post('/api/reception/patients', { name: 'Ahmed', phone: raw, contactConsent: true, whatsappConsent: true });
    expect(first.status).toBe(201);
    const dup = await r.api.post('/api/reception/patients', { name: 'Ahmed', phone: raw, contactConsent: true, whatsappConsent: true });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PHONE');
    expect(dup.body.error.details.existing[0].id).toBe(first.body.id);
    const ok = await r.api.post('/api/reception/patients', { name: 'Ahmed Jr', phone: raw, contactConsent: true, whatsappConsent: true, confirmSharedPhone: { reason: 'Son, same phone' } });
    expect(ok.status).toBe(201);
    expect(await lastAudit('PATIENT_DUPLICATE_PHONE_CONFIRMED', ok.body.id)).not.toBeNull();
  });
});

describe('§25 #9 — check-in, notices, vitals skippable', () => {
  it('records arrival time and actor; Doctor and booking Lead Member get the right notices', async () => {
    const r = await reception();
    const doctor = await makeUser('DOCTOR');
    const lead = await makeUser('LEAD_MEMBER');
    const p = await patient(r.user.id);
    const a = await todayAppt({ doctorId: doctor.id, patientId: p.id, createdById: lead.id, leadMemberId: lead.id });

    const res = await r.api.post(`/api/reception/appointments/${a.id}/check-in`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CHECKED_IN');
    expect(res.body.checkedInById).toBe(r.user.id);
    expect(Math.abs(new Date(res.body.checkedInAt).getTime() - Date.now())).toBeLessThan(10_000);

    const dn = await prisma.notification.findFirst({ where: { recipientId: doctor.id, recordId: a.id } });
    expect(dn?.type).toBe('PATIENT_WAITING');
    const ln = await prisma.notification.findFirst({ where: { recipientId: lead.id, recordId: a.id } });
    expect(ln?.type).toBe('PATIENT_CHECKED_IN');
    // live updates queued for Reception/Manager tracker and the Doctor queue
    expect(await prisma.realtimeEvent.count({ where: { event: 'tracker:changed', payload: { path: '$.appointmentId', equals: a.id } } })).toBeGreaterThan(0);
    expect(await prisma.realtimeEvent.count({ where: { room: `user:${doctor.id}`, event: 'queue:changed' } })).toBeGreaterThan(0);

    // second check-in is rejected
    expect((await r.api.post(`/api/reception/appointments/${a.id}/check-in`)).status).toBe(409);
  });

  it('vitals can be skipped (patient moves to Waiting) or recorded', async () => {
    const r = await reception();
    const doctor = await makeUser('DOCTOR');
    const p = await patient(r.user.id);
    const a = await todayAppt({ doctorId: doctor.id, patientId: p.id, createdById: r.user.id });
    await r.api.post(`/api/reception/appointments/${a.id}/check-in`);
    expect((await r.api.post(`/api/reception/appointments/${a.id}/vitals`, {})).status).toBe(422);
    const skip = await r.api.post(`/api/reception/appointments/${a.id}/vitals`, { skip: true, skipReason: 'Patient in hurry' });
    expect(skip.status).toBe(201);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('WAITING');
    const rec = await r.api.post(`/api/reception/appointments/${a.id}/vitals`, { bpSystolic: 120, bpDiastolic: 80, weightKg: 72.5, heightCm: 170 });
    expect(rec.status).toBe(201);
    expect(rec.body.weightGrams).toBe(72500);
    expect((await r.api.post(`/api/reception/appointments/${a.id}/vitals`, { bpSystolic: 120 })).status).toBe(422); // both BP values
  });

  it('check-in only on the appointment date', async () => {
    const r = await reception();
    const doctor = await makeUser('DOCTOR');
    const p = await patient(r.user.id);
    const future = atClinicMinute(addDaysStr(clinicDateStr(new Date()), 2), 15 * 60);
    const a = await prisma.appointment.create({ data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: future, endAt: new Date(future.getTime() + 1200_000), status: 'CONFIRMED', source: 'RECEPTION', createdById: r.user.id } });
    const res = await r.api.post(`/api/reception/appointments/${a.id}/check-in`);
    expect(res.body.error.code).toBe('NOT_TODAY');
  });
});

/** Plan: Rs 10,500 total, Rs 5,000 advance, then two installments of Rs 2,750 due `dueOffsets` days from today. */
async function billableVisit(r: Awaited<ReturnType<typeof reception>>, dueOffsets: [number, number] = [30, 60]) {
  const today = clinicDateStr(new Date());
  const doctor = await makeUser('DOCTOR');
  const p = await patient(r.user.id);
  const a = await todayAppt({ doctorId: doctor.id, patientId: p.id, createdById: r.user.id, status: 'RECEPTION' });
  // Doctor's immutable plan version (Phase 5 creates these; inserted directly here)
  const plan = await prisma.treatmentPlan.create({ data: { patientId: p.id, doctorId: doctor.id, appointmentId: a.id, currentVersionNo: 1 } });
  await prisma.treatmentPlanVersion.create({
    data: {
      planId: plan.id,
      versionNo: 1,
      consultationReason: 'test',
      consultationFeePaisa: 200_000n,
      consultationDiscountPaisa: 0n,
      itemsSubtotalPaisa: 1_000_000n,
      itemsDiscountPaisa: 100_000n,
      totalDiscountPaisa: 50_000n,
      grandTotalPaisa: 1_050_000n,
      advanceRequestedPaisa: 500_000n,
      balancePaisa: 1_050_000n,
      installmentCount: 2,
      createdById: doctor.id,
      items: { create: [{ sessionNumber: 1, procedureName: 'Hydrafacial', sameDay: true, scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 3600_000), pricePaisa: 1_000_000n, discountPaisa: 100_000n }] },
      installments: {
        create: [
          { seq: 1, dueDate: dateOnly(addDaysStr(today, dueOffsets[0])), amountPaisa: 275_000n },
          { seq: 2, dueDate: dateOnly(addDaysStr(today, dueOffsets[1])), amountPaisa: 275_000n },
        ],
      },
    },
  });
  return { doctor, p, a };
}

describe('billing (spec §9, §22, §24)', () => {
  it('invoice lines come from the Doctor plan and reconcile', async () => {
    const r = await reception();
    const { a } = await billableVisit(r);
    const inv = await r.api.post(`/api/reception/appointments/${a.id}/invoice`);
    expect(inv.status).toBe(201);
    expect(inv.body.totalPaisa).toBe(1_050_000); // 2000 + (10000-1000) - 500 Rs
    expect(inv.body.balancePaisa).toBe(1_050_000);
    expect(inv.body.number).toMatch(/^VH-INV-\d{4}-\d{4}$/);
    const again = await r.api.post(`/api/reception/appointments/${a.id}/invoice`);
    expect(again.body.id).toBe(inv.body.id); // one invoice per visit
  });

  it('payment is idempotent, cannot exceed the balance, and writes the ledger atomically', async () => {
    const r = await reception();
    const { a } = await billableVisit(r);
    const inv = (await r.api.post(`/api/reception/appointments/${a.id}/invoice`)).body;
    const key = newKey();
    const body = { amountPaisa: 500_000, method: 'CASH' };
    const [p1, p2] = await Promise.all([r.api.post(`/api/reception/invoices/${inv.id}/payments`, body, key), r.api.post(`/api/reception/invoices/${inv.id}/payments`, body, key)]);
    const statuses = [p1.status, p2.status].sort();
    expect(statuses[0]).toBe(201); // one succeeds…
    expect([201, 409]).toContain(statuses[1]); // …the concurrent retry is replayed or told it is in progress
    const replay = await r.api.post(`/api/reception/invoices/${inv.id}/payments`, body, key);
    expect(replay.body.payment.id).toBe((p1.status === 201 ? p1 : p2).body.payment.id);
    expect(await prisma.payment.count({ where: { invoiceId: inv.id } })).toBe(1);
    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(updated.paidPaisa).toBe(500_000n);
    expect(updated.balancePaisa).toBe(550_000n);
    const ledger = await prisma.ledgerEntry.findMany({ where: { refType: 'Payment', refId: replay.body.payment.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.account).toBe('CASH_IN_HAND');

    expect((await r.api.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 600_000, method: 'CASH' }, newKey())).status).toBe(422); // over balance
    expect((await r.api.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 100, method: 'CHEQUE' }, newKey())).status).toBe(422); // needs bank + reference
    const bank = await prisma.bankAccount.findFirstOrThrow({ where: { active: true } });
    const chq = await r.api.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 100_000, method: 'CHEQUE', reference: 'CHQ-1', bankAccountId: bank.id }, newKey());
    expect(chq.status).toBe(201);
    expect((await prisma.ledgerEntry.findFirstOrThrow({ where: { refId: chq.body.payment.id } })).account).toBe('BANK');
  });

  it('§25 #12 — invoice cannot close without a prescription photo; feedback Skip still permits close', async () => {
    const r = await reception();
    const { a, doctor, p } = await billableVisit(r);
    const inv = (await r.api.post(`/api/reception/appointments/${a.id}/invoice`)).body;

    const blocked = await r.api.post(`/api/reception/invoices/${inv.id}/close`);
    expect(blocked.status).toBe(423);
    expect(blocked.body.error.message).toBe('Prescription upload required');
    const detail = await r.api.get(`/api/reception/invoices/${inv.id}`);
    expect(detail.body.canClose).toBe(false);
    expect(detail.body.closeBlockers).toContain('Prescription upload required');

    expect((await r.api.post(`/api/reception/appointments/${a.id}/feedback`, { skip: true })).status).toBe(200);
    const up = await r.api.post('/api/files/dev-upload', { route: 'prescriptionPhoto', recordType: 'Invoice', recordId: inv.id, fileName: 'rx.jpg', mime: 'image/jpeg', size: 1000 });
    expect(up.status).toBe(201);

    // Q7: a balance may stay open only when the installment schedule covers it — the advance is not covered.
    const uncovered = await r.api.post(`/api/reception/invoices/${inv.id}/close`);
    expect(uncovered.body.error.code).toBe('BALANCE_NOT_SCHEDULED');
    await r.api.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 500_000, method: 'CASH' }, newKey());

    const closed = await r.api.post(`/api/reception/invoices/${inv.id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(appt.status).toBe('DONE');
    expect(appt.hiddenFromQueueAt).not.toBeNull(); // leaves the active queue…
    expect((await r.api.get('/api/reception/done')).body.items.map((x: { id: string }) => x.id)).toContain(a.id); // …stays in Patient Done
    expect(await prisma.notification.count({ where: { recipientId: doctor.id, type: 'PATIENT_DONE', recordId: a.id } })).toBe(1);
    expect(await prisma.workflowTask.count({ where: { appointmentId: a.id, type: 'DOCTOR_AFTERCARE' } })).toBe(1);
    const thanks = await prisma.messageOutbox.findFirstOrThrow({ where: { relatedId: a.id, template: 'visit_thanks' } });
    expect((thanks.payload as { feedbackLink: string | null }).feedbackLink).toBeNull(); // skipped at desk → no link
    expect(await prisma.followUp.count({ where: { appointmentId: a.id, patientId: p.id } })).toBe(1);
    expect((await r.api.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 100, method: 'CASH' }, newKey())).status).toBe(409); // closed
  });

  it('close is refused while the patient is still in a procedure', async () => {
    const r = await reception();
    const { a } = await billableVisit(r);
    const inv = (await r.api.post(`/api/reception/appointments/${a.id}/invoice`)).body;
    await r.api.post('/api/files/dev-upload', { route: 'prescriptionPhoto', recordType: 'Invoice', recordId: inv.id, fileName: 'rx.jpg', mime: 'image/jpeg', size: 1000 });
    await prisma.appointment.update({ where: { id: a.id }, data: { status: 'PROCEDURE' } });
    const res = await r.api.post(`/api/reception/invoices/${inv.id}/close`);
    expect(res.body.error.code).toBe('PROCEDURE_IN_PROGRESS');
  });
});

describe('installments (clinic decision Q7)', () => {
  it('patient file shows outstanding balance with per-installment status; reminders queue once; overdue alerts Manager once', async () => {
    const r = await reception();
    const mgr = await makeUser('MANAGER');
    // installment 1 overdue (due 3 days ago), installment 2 due tomorrow (inside the 2-day reminder window)
    const { a, p } = await billableVisit(r, [-3, 1]);
    const inv = (await r.api.post(`/api/reception/appointments/${a.id}/invoice`)).body;
    await r.api.post('/api/files/dev-upload', { route: 'prescriptionPhoto', recordType: 'Invoice', recordId: inv.id, fileName: 'rx.jpg', mime: 'image/jpeg', size: 1000 });
    await r.api.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 600_000, method: 'CASH' }, newKey()); // advance + Rs 1,000
    expect((await r.api.post(`/api/reception/invoices/${inv.id}/close`)).status).toBe(200);

    const file = await r.api.get(`/api/reception/patients/${p.id}`);
    expect(file.body.outstandingPaisa).toBe(450_000);
    const sched = file.body.balances[0].installments;
    expect(sched.map((i: { state: string }) => i.state)).toEqual(['OVERDUE', 'UPCOMING']);
    expect(sched.map((i: { outstandingPaisa: number }) => i.outstandingPaisa)).toEqual([175_000, 275_000]);

    await runInstallmentReminders(new Date());
    await runInstallmentReminders(new Date());
    const reminders = await prisma.messageOutbox.findMany({ where: { relatedId: inv.id, template: 'installment_reminder' } });
    expect(reminders).toHaveLength(1); // only the installment inside the window, once
    expect(await prisma.notification.count({ where: { recipientId: mgr.id, type: 'INSTALLMENT_OVERDUE', recordId: inv.id } })).toBe(1);
  });
});

describe('Reception cancel (clinic decision Q6)', () => {
  it('cancel before arrival needs a reason and informs Manager + linked Lead member; not allowed after check-in', async () => {
    const r = await reception();
    const mgr = await makeUser('MANAGER');
    const lead = await makeUser('LEAD_MEMBER');
    const doctor = await makeUser('DOCTOR');
    const p = await patient(r.user.id);
    const a = await todayAppt({ doctorId: doctor.id, patientId: p.id, createdById: lead.id, leadMemberId: lead.id });
    expect((await r.api.post(`/api/reception/appointments/${a.id}/cancel`, { reason: '' })).status).toBe(422);
    const res = await r.api.post(`/api/reception/appointments/${a.id}/cancel`, { reason: 'Patient called to cancel' });
    expect(res.status).toBe(200);
    expect(await prisma.notification.count({ where: { recipientId: mgr.id, recordId: a.id, type: 'APPOINTMENT_CANCELLED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: lead.id, recordId: a.id } })).toBe(1);

    const b = await todayAppt({ doctorId: doctor.id, patientId: p.id, createdById: r.user.id });
    await r.api.post(`/api/reception/appointments/${b.id}/check-in`);
    expect((await r.api.post(`/api/reception/appointments/${b.id}/cancel`, { reason: 'too late' })).body.error.code).toBe('NOT_CANCELLABLE');
  });
});

describe('file serving modes (D-030)', () => {
  it('clinical files never expose a storage URL: proxy URL on the free plan, stub for dev files; scope still enforced', async () => {
    const r = await reception();
    const { a } = await billableVisit(r);
    const inv = (await r.api.post(`/api/reception/appointments/${a.id}/invoice`)).body;
    const stub = await r.api.post('/api/files/dev-upload', { route: 'prescriptionPhoto', recordType: 'Invoice', recordId: inv.id, fileName: 'rx.jpg', mime: 'image/jpeg', size: 1000 });
    expect((await r.api.get(`/api/files/${stub.body.attachmentId}/url`)).body.mode).toBe('stub');
    expect((await r.api.get(`/api/files/${stub.body.attachmentId}/content`)).body.error.code).toBe('DEV_STUB_FILE');

    // A real (non-stub) clinical attachment as written by onUploadComplete: no publicUrl stored.
    const real = await prisma.attachment.create({ data: { fileKey: `ut_${Date.now()}`, route: 'prescriptionPhoto', fileName: 'rx.png', mime: 'image/png', size: 68, isPrivate: true, uploadedById: r.user.id, recordType: 'Invoice', recordId: inv.id } });
    const url = await r.api.get(`/api/files/${real.id}/url`);
    expect(url.body).toMatchObject({ mode: 'proxy', url: `/api/files/${real.id}/content` });
    expect(JSON.stringify(url.body)).not.toMatch(/ufs\.sh|utfs\.io|uploadthing/);
    const ob = await agentFor('OFFICE_BOY');
    expect((await call(ob.agent).get(`/api/files/${real.id}/content`)).status).toBe(403);
    expect((await call(ob.agent).get(`/api/files/${real.id}/url`)).status).toBe(403);
  });
});

describe('public feedback link (patient-facing)', () => {
  it('patient can submit once via token; no staff/clinical data exposed', async () => {
    const r = await reception();
    const { a } = await billableVisit(r);
    const inv = (await r.api.post(`/api/reception/appointments/${a.id}/invoice`)).body;
    await r.api.post('/api/files/dev-upload', { route: 'prescriptionPhoto', recordType: 'Invoice', recordId: inv.id, fileName: 'rx.jpg', mime: 'image/jpeg', size: 1000 });
    await r.api.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 500_000, method: 'CASH' }, newKey());
    expect((await r.api.post(`/api/reception/invoices/${inv.id}/close`)).status).toBe(200);
    const fb = await prisma.feedback.findUniqueOrThrow({ where: { appointmentId: a.id } });
    const view = await request(app).get(`/api/public/feedback/${fb.token}`);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toMatch(/phone|92\d{9}|consult/i);
    const sub = await request(app).post(`/api/public/feedback/${fb.token}`).send({ doctorRating: 5, staffRating: 4, clinicRating: 5, suggestion: 'Great' });
    expect(sub.status).toBe(200);
    expect((await request(app).post(`/api/public/feedback/${fb.token}`).send({ doctorRating: 1, staffRating: 1, clinicRating: 1 })).status).toBe(409);
    expect((await request(app).get('/api/public/feedback/not-a-real-token-123456')).status).toBe(404);
  });
});

describe('patient complaint & reschedule request → Manager', () => {
  it('patient complaint lands in the Manager inbox; reschedule request notifies Managers', async () => {
    const r = await reception();
    const mgr = await agentFor('MANAGER');
    const doctor = await makeUser('DOCTOR');
    const p = await patient(r.user.id);
    const c = await r.api.post('/api/reception/complaints', { patientId: p.id, subject: 'Wait time', detail: 'Patient waited 1 hour' });
    expect(c.status).toBe(201);
    const inbox = await call(mgr.agent).get('/api/requests/complaints?box=inbox');
    expect(inbox.body.items.map((x: { id: string }) => x.id)).toContain(c.body.id);

    const a = await todayAppt({ doctorId: doctor.id, patientId: p.id, createdById: r.user.id });
    const rr = await r.api.post(`/api/reception/appointments/${a.id}/reschedule-request`, { reason: 'Patient asked for evening' });
    expect(rr.status).toBe(201);
    expect(await prisma.notification.count({ where: { recipientId: mgr.user.id, type: 'RESCHEDULE_REQUEST', recordId: rr.body.id } })).toBe(1);
    expect((await r.api.post(`/api/reception/appointments/${a.id}/reschedule-request`, { reason: 'again' })).status).toBe(409);
  });
});

describe('attendance & access', () => {
  it('staff check-in notifies each Manager once; double check-in rejected; check-out recorded', async () => {
    const r = await reception();
    const mgr = await makeUser('MANAGER');
    const ci = await r.api.post('/api/attendance/check-in');
    expect(ci.status).toBe(201);
    expect(await prisma.notification.count({ where: { recipientId: mgr.id, type: 'STAFF_CHECK_IN', recordId: ci.body.id } })).toBe(1);
    expect((await r.api.post('/api/attendance/check-in')).status).toBe(409);
    const co = await r.api.post('/api/attendance/check-out');
    expect(co.body.checkOutAt).not.toBeNull();
  });

  it('Office Boy and Lead members cannot reach Reception patient endpoints', async () => {
    for (const role of ['OFFICE_BOY', 'LEAD_MEMBER', 'ASSISTANT'] as const) {
      const { agent } = await agentFor(role);
      expect((await call(agent).get('/api/reception/search?q=test')).status).toBe(403);
      expect((await call(agent).get('/api/reception/tracker')).status).toBe(403);
    }
  });

  it('Reception booking goes through the scheduling engine and is idempotent', async () => {
    const r = await reception();
    const doctor = await doctorWithHours();
    const p = await patient(r.user.id);
    const start = atClinicMinute(addDaysStr(clinicDateStr(new Date()), 6), 11 * 60).toISOString();
    await prisma.roomReservation.updateMany({ where: { status: 'ACTIVE', startAt: { gte: atClinicMinute(addDaysStr(clinicDateStr(new Date()), 6), 0) } }, data: { status: 'CANCELLED' } });
    const key = newKey();
    const b1 = await r.api.post('/api/reception/appointments', { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', start }, key);
    expect(b1.status).toBe(201);
    expect(b1.body.appointment.source).toBe('RECEPTION');
    const b2 = await r.api.post('/api/reception/appointments', { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', start }, key);
    expect(b2.body.appointment.id).toBe(b1.body.appointment.id);
    const clash = await r.api.post('/api/reception/appointments', { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', start }, newKey());
    expect(clash.body.error.code).toBe('SLOT_UNAVAILABLE');
  });
});
