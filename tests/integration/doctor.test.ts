import { beforeAll, describe, expect, it } from 'vitest';
import { addDaysStr, atClinicMinute, clinicDateStr, dateOnly } from '../../src/lib/time';
import { normalizePhone } from '../../src/lib/phone';
import { agentFor, call, doctorWithHours, ensureRooms, freeRoomsFrom, loginAs, makeUser, newKey, prisma, uniquePhone } from './helpers';

const D = addDaysStr(clinicDateStr(new Date()), 5);
const at = (hhmm: string, date = D) => atClinicMinute(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

let receptionId: string;
beforeAll(async () => {
  await ensureRooms();
  receptionId = (await makeUser('RECEPTIONIST')).id;
  await makeUser('MANAGER');
});

async function doctorSession() {
  const doctor = await doctorWithHours();
  const agent = await loginAs(doctor.email!);
  return { doctor, api: call(agent) };
}

async function patient(raw = uniquePhone()) {
  return prisma.patient.create({ data: { name: 'Doctor Test Patient', phone: normalizePhone(raw)!, createdById: receptionId, whatsappConsent: true, ageYears: 34 } });
}

/** A visit for today already checked in & waiting for `doctorId`. */
async function waitingVisit(doctorId: string, patientId: string) {
  const now = new Date();
  return prisma.appointment.create({
    data: { patientId, doctorId, type: 'CONSULTATION', startAt: now, endAt: new Date(now.getTime() + 1200_000), status: 'WAITING', source: 'RECEPTION', createdById: receptionId, checkedInAt: now },
  });
}

const planBody = (futureStart: Date) => ({
  consultationReason: 'Acne scarring, plan for 2 sessions',
  consultationFeePaisa: 200_000,
  consultationDiscountPaisa: 50_000,
  items: [
    { procedureName: 'Chemical peel', sameDay: true, pricePaisa: 800_000, discountPaisa: 100_000 },
    { procedureName: 'Microneedling', sameDay: false, start: futureStart.toISOString(), pricePaisa: 1_500_000, discountPaisa: 0 },
  ],
  totalDiscountPaisa: 50_000,
  advanceRequestedPaisa: 500_000,
  installmentCount: 3,
  firstInstallmentDate: addDaysStr(clinicDateStr(new Date()), 30),
  installmentIntervalDays: 30,
});

describe('§25 #10 — Doctor sees only own patients; other-Doctor history needs Manager approval; no product cost', () => {
  it('queue and appointment actions are scoped to the Doctor', async () => {
    const a = await doctorSession();
    const b = await doctorSession();
    const p = await patient();
    const visit = await waitingVisit(a.doctor.id, p.id);
    const q = await a.api.get('/api/doctor/queue');
    expect(q.body.items.map((x: { id: string }) => x.id)).toContain(visit.id);
    expect((await b.api.get('/api/doctor/queue')).body.items.map((x: { id: string }) => x.id)).not.toContain(visit.id);
    expect((await b.api.post(`/api/doctor/appointments/${visit.id}/accept`)).status).toBe(403);
    expect((await b.api.get(`/api/doctor/appointments/${visit.id}`)).status).toBe(403);
  });

  it('another Doctor cannot open the history until a Manager approves; the request leaks nothing', async () => {
    const owner = await doctorSession();
    const other = await doctorSession();
    const raw = uniquePhone();
    const p = await patient(raw);
    await waitingVisit(owner.doctor.id, p.id);
    // stock with a cost exists in the clinic — it must never appear in Doctor payloads
    const item = await prisma.stockItem.create({ data: { name: `Cost probe ${Date.now()}`, category: 'x', baseUnit: 'piece', minQty: 1 } });
    await prisma.stockBatch.create({ data: { itemId: item.id, lotNo: 'L1', unitCostPaisa: 123_456n } });

    const denied = await other.api.get(`/api/doctor/patients/${p.id}/history`);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('Doctor Test Patient');
    expect(await prisma.auditEvent.count({ where: { action: 'AUTHZ_DENIED', actorId: other.doctor.id, recordId: p.id } })).toBeGreaterThan(0);

    const req = await other.api.post('/api/doctor/history-requests', { phone: raw, reason: 'Patient referred for second opinion' });
    expect(req.status).toBe(201);
    expect(JSON.stringify(req.body)).not.toMatch(/Doctor Test Patient|patientId|92\d{9}/);
    const mine = await other.api.get('/api/doctor/history-requests');
    expect(mine.body.items[0]).toMatchObject({ status: 'PENDING', patientName: null, patientId: null });

    const mgr = await agentFor('MANAGER');
    // a Doctor cannot approve (endpoint is Manager-only)
    expect((await other.api.post(`/api/manager/approvals/history-access/${req.body.requests[0].id}`, { approve: true })).status).toBe(403);
    expect((await call(mgr.agent).post(`/api/manager/approvals/history-access/${req.body.requests[0].id}`, { approve: true })).status).toBe(200);

    const allowed = await other.api.get(`/api/doctor/patients/${p.id}/history`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.access).toBe('approved');
    expect(allowed.body.visits.length).toBeGreaterThan(0); // includes the owner's visit
    const json = JSON.stringify(allowed.body);
    expect(json).not.toMatch(/unitCost|123456|estUnitCost|costPaisa/i);
  });

  it('own history shows only the Doctor’s own visits and no product cost', async () => {
    const d = await doctorSession();
    const p = await patient();
    await waitingVisit(d.doctor.id, p.id);
    const res = await d.api.get(`/api/doctor/patients/${p.id}/history`);
    expect(res.body.access).toBe('own');
    expect(JSON.stringify(res.body)).not.toMatch(/unitCost|costPaisa/i);
    expect((await d.api.get('/api/doctor/patients')).body.items.map((x: { id: string }) => x.id)).toContain(p.id);
  });
});

describe('consultation → plan → Reception (spec §10, §25 #7, #11)', () => {
  it('accept starts the timer and tells Reception; plan with 2 items reconciles; future session is booked; send to Reception', async () => {
    await freeRoomsFrom(at('00:00'));
    const d = await doctorSession();
    const p = await patient();
    const visit = await waitingVisit(d.doctor.id, p.id);

    const acc = await d.api.post(`/api/doctor/appointments/${visit.id}/accept`);
    expect(acc.body.status).toBe('WITH_DOCTOR');
    expect(acc.body.acceptedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { recordId: visit.id, type: 'PATIENT_ACCEPTED', recipientId: receptionId } })).toBe(1);

    // Send before a plan is refused
    expect((await d.api.post(`/api/doctor/appointments/${visit.id}/send-to-reception`)).body.error.code).toBe('PLAN_REQUIRED');

    const futureStart = at('15:00');
    const res = await d.api.put(`/api/doctor/appointments/${visit.id}/plan`, planBody(futureStart));
    expect(res.status).toBe(200);
    const v = res.body.version;
    // consult 2000-500 + peel 8000-1000 + microneedling 15000 - 500 total discount = 23,000 Rs
    expect(v.grandTotalPaisa).toBe(2_300_000);
    expect(v.balancePaisa).toBe(1_800_000);
    expect(v.installments.map((i: { amountPaisa: number }) => i.amountPaisa).reduce((s: number, x: number) => s + x, 0)).toBe(1_800_000);
    expect(v.items).toHaveLength(2);
    const future = v.items.find((i: { sameDay: boolean }) => !i.sameDay);
    expect(future.status).toBe('SCHEDULED');
    expect(future.roomCode).toMatch(/^P0[1-3]$/);
    const booked = await prisma.appointment.findUniqueOrThrow({ where: { treatmentPlanItemId: future.id } });
    expect(booked).toMatchObject({ type: 'PROCEDURE', source: 'DOCTOR_PLAN', status: 'CONFIRMED' });

    // §25 #7: the planned session now blocks other bookings for this Doctor at that time (source: planned procedure)
    const r = await agentFor('RECEPTIONIST');
    const clash = await call(r.agent).post('/api/reception/appointments', { patientId: (await patient()).id, doctorId: d.doctor.id, type: 'CONSULTATION', start: at('15:20').toISOString() }, newKey());
    expect(clash.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(clash.body.error.details.conflicts[0]).toMatchObject({ code: 'DOCTOR_BUSY', source: 'planned_procedure' });

    const sent = await d.api.post(`/api/doctor/appointments/${visit.id}/send-to-reception`);
    expect(sent.body.status).toBe('RECEPTION');
    expect(await prisma.workflowTask.count({ where: { appointmentId: visit.id, type: 'RECEPTION_COLLECTION' } })).toBe(1);
    // §20: Reception is told the consultation is complete, with charges and next action
    const notice = await prisma.notification.findFirstOrThrow({ where: { recipientId: r.user.id, type: 'SENT_TO_RECEPTION', recordId: visit.id } });
    expect(notice.subject).toMatch(/^Consultation complete/);
    expect(notice.body).toMatch(/Total Rs .* advance Rs/);
    expect(notice.actionLabel).toBe('Billing');

    // Reception's invoice uses exactly the Doctor's immutable plan totals
    const inv = await call(r.agent).post(`/api/reception/appointments/${visit.id}/invoice`);
    expect(inv.body.totalPaisa).toBe(2_300_000);
    // Plan is locked once invoiced
    expect((await d.api.put(`/api/doctor/appointments/${visit.id}/plan`, planBody(futureStart))).body.error.code).toBe('PLAN_LOCKED');
  });

  it('revising the plan releases the previous version’s future booking', async () => {
    await freeRoomsFrom(at('00:00'));
    const d = await doctorSession();
    const visit = await waitingVisit(d.doctor.id, (await patient()).id);
    await d.api.post(`/api/doctor/appointments/${visit.id}/accept`);
    const v1 = (await d.api.put(`/api/doctor/appointments/${visit.id}/plan`, planBody(at('16:00')))).body.version;
    const oldItem = v1.items.find((i: { sameDay: boolean }) => !i.sameDay);
    const v2 = (await d.api.put(`/api/doctor/appointments/${visit.id}/plan`, planBody(at('18:00')))).body.version;
    expect(v2.versionNo).toBe(2);
    const oldAppt = await prisma.appointment.findUniqueOrThrow({ where: { treatmentPlanItemId: oldItem.id } });
    expect(oldAppt.status).toBe('CANCELLED');
    expect((await prisma.treatmentPlanItem.findUniqueOrThrow({ where: { id: oldItem.id } })).status).toBe('SUPERSEDED');
    expect(await prisma.treatmentPlanVersion.count({ where: { planId: v2.planId } })).toBe(2); // v1 kept, immutable
  });

  it('a future session that cannot be booked rolls back the whole plan and names the item', async () => {
    await freeRoomsFrom(at('00:00'));
    const d = await doctorSession();
    await prisma.doctorAvailabilityException.create({ data: { doctorId: d.doctor.id, kind: 'LEAVE', date: dateOnly(D), status: 'APPROVED', requestedById: d.doctor.id } });
    const visit = await waitingVisit(d.doctor.id, (await patient()).id);
    await d.api.post(`/api/doctor/appointments/${visit.id}/accept`);
    const res = await d.api.put(`/api/doctor/appointments/${visit.id}/plan`, planBody(at('15:00')));
    expect(res.status).toBe(409);
    expect(res.body.error.details.itemIndex).toBe(1);
    expect(res.body.error.message).toMatch(/Item 2/);
    expect(await prisma.treatmentPlan.count({ where: { appointmentId: visit.id } })).toBe(0);
  });
});

describe('leave & alternate availability (spec §11, §4)', () => {
  it('leave shows affected patients, blocks new slots, alerts the Manager with the count', async () => {
    await freeRoomsFrom(at('00:00'));
    const d = await doctorSession();
    const date = addDaysStr(D, 1);
    const r = await agentFor('RECEPTIONIST');
    const p = await patient();
    await call(r.agent).post('/api/reception/appointments', { patientId: p.id, doctorId: d.doctor.id, type: 'CONSULTATION', start: atClinicMinute(date, 11 * 60).toISOString() }, newKey());

    const preview = await d.api.post('/api/doctor/availability/preview', { kind: 'LEAVE', date });
    expect(preview.body.count).toBe(1);
    const set = await d.api.post('/api/doctor/availability', { kind: 'LEAVE', date, reason: 'Family wedding' });
    expect(set.status).toBe(201);
    expect(set.body.exception.status).toBe('APPROVED');
    expect(set.body.impact.count).toBe(1);
    expect(await prisma.notification.count({ where: { recordId: set.body.exception.id, type: 'DOCTOR_LEAVE' } })).toBeGreaterThan(0);
    expect(await prisma.workflowTask.count({ where: { type: 'MANAGER_LEAVE_IMPACT', idempotencyKey: `availability:${set.body.exception.id}:impact` } })).toBe(1);

    const blocked = await call(r.agent).post('/api/reception/appointments', { patientId: p.id, doctorId: d.doctor.id, type: 'CONSULTATION', start: atClinicMinute(date, 15 * 60).toISOString() }, newKey());
    expect(blocked.body.error.details.conflicts[0].code).toBe('DOCTOR_ON_LEAVE');
    // existing booking is not silently removed — it stays for the Manager to resolve
    expect(await prisma.appointment.count({ where: { doctorId: d.doctor.id, status: 'CONFIRMED' } })).toBe(1);
  });

  it('alternate hours are not bookable until a Manager approves', async () => {
    await freeRoomsFrom(at('00:00'));
    const d = await doctorSession();
    const date = addDaysStr(D, 2);
    const alt = await d.api.post('/api/doctor/availability', { kind: 'ALTERNATE_HOURS', date, startMinute: 6 * 60, endMinute: 8 * 60, reason: 'Early clinic' });
    expect(alt.body.exception.status).toBe('PENDING');
    const r = await agentFor('RECEPTIONIST');
    const p = await patient();
    const body = { patientId: p.id, doctorId: d.doctor.id, type: 'CONSULTATION', start: atClinicMinute(date, 7 * 60).toISOString() };
    expect((await call(r.agent).post('/api/reception/appointments', body, newKey())).body.error.details.conflicts[0].code).toBe('ALTERNATE_PENDING');
    expect((await d.api.post(`/api/manager/approvals/alternate-hours/${alt.body.exception.id}`, { approve: true })).status).toBe(403);
    const mgr = await agentFor('MANAGER');
    expect((await call(mgr.agent).post(`/api/manager/approvals/alternate-hours/${alt.body.exception.id}`, { approve: false })).status).toBe(422); // reason required
    expect((await call(mgr.agent).post(`/api/manager/approvals/alternate-hours/${alt.body.exception.id}`, { approve: true })).status).toBe(200);
    expect((await call(r.agent).post('/api/reception/appointments', body, newKey())).status).toBe(201);
  });
});

describe('aftercare (spec §10)', () => {
  it('after Patient Done the Doctor sends guidance (outbox) or skips; recorded once with attribution', async () => {
    const d = await doctorSession();
    const p = await patient();
    const now = new Date();
    const appt = await prisma.appointment.create({ data: { patientId: p.id, doctorId: d.doctor.id, type: 'CONSULTATION', startAt: now, endAt: now, status: 'DONE', source: 'RECEPTION', createdById: receptionId, doneAt: now } });
    await prisma.workflowTask.create({ data: { type: 'DOCTOR_AFTERCARE', title: 'Aftercare', patientId: p.id, appointmentId: appt.id, assignedRole: 'DOCTOR', assignedUserId: d.doctor.id, idempotencyKey: `appointment:${appt.id}:aftercare` } });
    expect((await d.api.get('/api/doctor/aftercare')).body.items.map((t: { appointmentId: string }) => t.appointmentId)).toContain(appt.id);
    expect((await d.api.post(`/api/doctor/appointments/${appt.id}/aftercare`, { skip: false })).status).toBe(422);
    const sent = await d.api.post(`/api/doctor/appointments/${appt.id}/aftercare`, { content: 'Sunscreen SPF 50, avoid sun 48h' });
    expect(sent.body.delivered).toBe(true);
    const msg = await prisma.messageOutbox.findFirstOrThrow({ where: { relatedId: appt.id, template: 'aftercare' } });
    expect((msg.payload as { doctorName: string }).doctorName).toBe(d.doctor.displayName);
    expect((await d.api.post(`/api/doctor/appointments/${appt.id}/aftercare`, { skip: true })).status).toBe(409);
    expect((await prisma.workflowTask.findFirstOrThrow({ where: { appointmentId: appt.id, type: 'DOCTOR_AFTERCARE' } })).status).toBe('COMPLETED');
  });
});
