import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { addDaysStr, atClinicMinute, clinicDate, clinicDateStr, dateOnly } from '../../src/lib/time';
import { agentFor, call, doctorWithHours, ensureRooms, freeRoomsFrom, lastAudit, loginAs, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

type Api = ReturnType<typeof call>;
let mgr: Api;
let managerId: string;
let reception: Api;
let receptionId: string;

beforeAll(async () => {
  await ensureRooms();
  const m = await agentFor('MANAGER');
  mgr = call(m.agent);
  managerId = m.user.id;
  const r = await agentFor('RECEPTIONIST');
  reception = call(r.agent);
  receptionId = r.user.id;
});

const at = (date: string, hhmm: string) => atClinicMinute(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

async function patient() {
  return prisma.patient.create({ data: { name: `Mgr Patient ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: receptionId, whatsappConsent: true } });
}

/** A confirmed consultation with its room reservation, as the booking engine would leave it. */
async function booked(doctorId: string, date: string, hhmm: string) {
  const p = await patient();
  const room = await prisma.room.findFirstOrThrow({ where: { code: 'C03' } });
  const start = at(date, hhmm);
  const end = new Date(start.getTime() + 20 * 60_000);
  const a = await prisma.appointment.create({ data: { patientId: p.id, doctorId, type: 'CONSULTATION', startAt: start, endAt: end, roomId: room.id, status: 'CONFIRMED', source: 'RECEPTION', createdById: receptionId } });
  await prisma.roomReservation.create({ data: { roomId: room.id, appointmentId: a.id, startAt: start, endAt: end } });
  return { a, p, room };
}

describe('§14 — Manager-only endpoints', () => {
  it('other roles are refused', async () => {
    const asst = await agentFor('ASSISTANT');
    for (const path of ['/api/manager/dashboard', '/api/manager/staff', '/api/manager/reports/rooms', '/api/manager/leave-impacts', '/api/manager/followups', '/api/manager/audit']) {
      expect((await call(asst.agent).get(path)).status, path).toBe(403);
    }
    expect((await reception.get('/api/manager/audit')).status).toBe(403);
  });
});

describe('§14 — staff arrival review', () => {
  it('needs check-in, one per day, improvement note when not OK, comment only to that staff', async () => {
    const s = await agentFor('RECEPTIONIST');
    const other = await agentFor('RECEPTIONIST');
    const body = { uniformOk: true, hairOk: true, nailsOk: false, rating: 3, comment: 'Punctual' };
    expect((await mgr.post(`/api/manager/staff/${s.user.id}/review`, body)).body.error.code).toBe('NOT_CHECKED_IN');
    await call(s.agent).post('/api/attendance/check-in');
    const list = await mgr.get('/api/manager/staff');
    expect(list.body.items.find((x: { id: string }) => x.id === s.user.id).attendance).toBeTruthy();
    expect((await mgr.post(`/api/manager/staff/${s.user.id}/review`, body)).status).toBe(422); // nails not ok → note needed
    const ok = await mgr.post(`/api/manager/staff/${s.user.id}/review`, { ...body, improvementNote: 'Nails trim karein' });
    expect(ok.status).toBe(201);
    expect((await mgr.post(`/api/manager/staff/${s.user.id}/review`, { ...body, improvementNote: 'x' })).body.error.code).toBe('ALREADY_REVIEWED');
    const mine = await call(s.agent).get('/api/attendance/reviews');
    expect(mine.body.items[0]).toMatchObject({ rating: 3, nailsOk: false, improvementNote: 'Nails trim karein' });
    expect((await call(other.agent).get('/api/attendance/reviews')).body.items).toHaveLength(0);
    expect(await prisma.notification.count({ where: { recordId: ok.body.id, type: 'STAFF_REVIEW' } })).toBe(1);
    expect(await prisma.notification.count({ where: { recordId: ok.body.id, type: 'STAFF_REVIEW', recipientId: s.user.id } })).toBe(1);
    expect((await mgr.get('/api/manager/staff')).body.items.find((x: { id: string }) => x.id === s.user.id).review.rating).toBe(3);
  });
});

describe('§14 — room checklist verification / return / escalate; dashboard highlight until verified', () => {
  it('runs the verification states', async () => {
    const md = await makeUser('MD');
    const a = await agentFor('ASSISTANT');
    const room = await prisma.room.findFirstOrThrow({ where: { code: 'P03' } });
    const ra = await prisma.roomAssignment.create({ data: { assistantId: a.user.id, roomId: room.id, date: clinicDate(new Date()), assignedById: managerId, acceptedAt: new Date() } });
    const res = await call(a.agent).post(`/api/assistant/rooms/${ra.id}/checklist`, { kind: 'OPENING', machineOk: false, machineIssue: 'Laser fan noisy', roomNeat: true, disinfected: true, stockOk: true });
    expect(res.status).toBe(201);
    const reportId = res.body.id as string;

    const dash = await mgr.get('/api/manager/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.highlights.some((h: { key: string }) => h.key === `room:${reportId}`)).toBe(true);
    expect(dash.body.cards.verification.pending).toBeGreaterThan(0);
    expect((await mgr.get('/api/manager/reports/rooms')).body.items.find((r: { id: string }) => r.id === reportId)).toMatchObject({ issue: true, latestStatus: null, roomCode: 'P03' });

    const url = `/api/manager/reports/RoomChecklistReport/${reportId}/verify`;
    expect((await mgr.post(url, { status: 'RETURNED' })).status).toBe(422);
    expect((await mgr.post(url, { status: 'RETURNED', comment: 'Machine ka ticket kholo, phir batao' })).status).toBe(200);
    expect(await prisma.notification.count({ where: { recipientId: a.user.id, type: 'REPORT_RETURNED' } })).toBe(1);
    expect((await mgr.post(url, { status: 'ESCALATED', comment: 'Vendor visit chahiye' })).status).toBe(200);
    expect(await prisma.notification.count({ where: { recipientId: md.id, type: 'REPORT_ESCALATED', recordId: reportId } })).toBe(1);
    // still a highlight while unresolved
    expect((await mgr.get('/api/manager/dashboard')).body.highlights.some((h: { key: string }) => h.key === `room:${reportId}`)).toBe(true);

    expect((await mgr.post(url, { status: 'VERIFIED' })).status).toBe(200);
    expect((await mgr.post(url, { status: 'VERIFIED' })).body.error.code).toBe('ALREADY_VERIFIED');
    expect(await prisma.workflowTask.findFirstOrThrow({ where: { idempotencyKey: `roomreport:${reportId}` } })).toMatchObject({ status: 'COMPLETED', completedById: managerId });
    expect((await mgr.get('/api/manager/dashboard')).body.highlights.some((h: { key: string }) => h.key === `room:${reportId}`)).toBe(false);
    const hist = (await mgr.get('/api/manager/reports/rooms?scope=day')).body.items.find((r: { id: string }) => r.id === reportId).history;
    expect(hist.map((h: { status: string }) => h.status)).toEqual(['RETURNED', 'ESCALATED', 'VERIFIED']);
    // the report itself never changed
    expect(await prisma.roomChecklistReport.findUniqueOrThrow({ where: { id: reportId } })).toMatchObject({ machineOk: false, machineIssue: 'Laser fan noisy' });
  });
});

describe('§25 #14 — reschedule only after Manager confirms patient and Doctor; old slot released; history', () => {
  it('approves a Reception request through the engine and rejects another', async () => {
    const doctor = await doctorWithHours();
    const D = addDaysStr(clinicDateStr(new Date()), 9);
    await freeRoomsFrom(at(D, '00:00'));
    const { a, room } = await booked(doctor.id, D, '15:00');
    const req = await reception.post(`/api/reception/appointments/${a.id}/reschedule-request`, { reason: 'Patient travelling', requestedStartAt: at(D, '17:00').toISOString() });
    expect(req.status).toBe(201);
    const pending = await mgr.get('/api/manager/reschedule-requests');
    expect(pending.body.items.find((r: { id: string }) => r.id === req.body.id).appointment.patient.name).toMatch(/Mgr Patient/);

    const body = { start: at(D, '17:00').toISOString(), roomId: room.id, reason: 'Patient travelling', requestId: req.body.id };
    expect((await mgr.post(`/api/manager/appointments/${a.id}/reschedule`, { ...body, patientConfirmed: true, doctorConfirmed: false }, newKey())).status).toBe(422);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CONFIRMED');

    const ok = await mgr.post(`/api/manager/appointments/${a.id}/reschedule`, { ...body, patientConfirmed: true, doctorConfirmed: true }, newKey());
    expect(ok.status).toBe(200);
    const fresh = ok.body.appointment;
    expect(new Date(fresh.startAt).getTime()).toBe(at(D, '17:00').getTime());
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RESCHEDULED');
    expect((await prisma.roomReservation.findFirstOrThrow({ where: { appointmentId: a.id } })).status).toBe('RELEASED');
    expect(await prisma.rescheduleHistory.count({ where: { oldAppointmentId: a.id, newAppointmentId: fresh.id, approvedById: managerId } })).toBe(1);
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: req.body.id } })).toMatchObject({ status: 'APPROVED', patientConfirmed: true, doctorConfirmed: true, newAppointmentId: fresh.id });
    expect(await prisma.notification.count({ where: { recordId: fresh.id, type: 'APPOINTMENT_RESCHEDULED', recipientId: receptionId } })).toBe(1);
    expect(await prisma.notification.count({ where: { recordId: fresh.id, type: 'APPOINTMENT_RESCHEDULED', recipientId: doctor.id } })).toBe(1);
    // §25 #14 "messages update": the Doctor's WhatsApp for the new slot is queued once in the outbox
    expect(await prisma.messageOutbox.count({ where: { idempotencyKey: `appointment:${fresh.id}:rescheduled:doctor`, template: 'appointment_rescheduled' } })).toBe(1);
    expect((await lastAudit('RESCHEDULE_CONFIRMED', a.id))?.after).toMatchObject({ patientConfirmed: true, doctorConfirmed: true });

    const b = await booked(doctor.id, D, '19:00');
    const req2 = await reception.post(`/api/reception/appointments/${b.a.id}/reschedule-request`, { reason: 'Maybe later' });
    expect((await mgr.post(`/api/manager/reschedule-requests/${req2.body.id}/reject`, { reason: 'Patient ne confirm nahi kiya' })).status).toBe(200);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: b.a.id } })).status).toBe('CONFIRMED');
    expect(await prisma.notification.count({ where: { recipientId: receptionId, type: 'RESCHEDULE_REJECTED', recordId: b.a.id } })).toBe(1);
  });
});

describe('§11 / §14 — Doctor leave impact stays pending until every patient is handled', () => {
  it('lists affected patients, refuses to resolve early, and resolves after reschedule + cancel', async () => {
    const doctor = await doctorWithHours();
    const d = call(await loginAs(doctor.email!));
    const D = addDaysStr(clinicDateStr(new Date()), 11);
    await freeRoomsFrom(at(D, '00:00'));
    const one = await booked(doctor.id, D, '15:00');
    const two = await booked(doctor.id, D, '16:00');
    const leave = await d.post('/api/doctor/availability', { kind: 'LEAVE', date: D, reason: 'Conference' });
    expect(leave.status).toBe(201);
    const exId = leave.body.exception.id as string;

    const list = await mgr.get('/api/manager/leave-impacts');
    const item = list.body.items.find((x: { id: string }) => x.id === exId);
    expect(item.affected.map((x: { id: string }) => x.id).sort()).toEqual([one.a.id, two.a.id].sort());
    expect((await mgr.get('/api/manager/dashboard')).body.highlights.some((h: { key: string }) => h.key === `leave:${exId}`)).toBe(true);
    expect((await mgr.post(`/api/manager/leave-impacts/${exId}/resolve`)).body.error.code).toBe('IMPACT_PENDING');

    const next = addDaysStr(D, 1);
    expect((await mgr.post(`/api/manager/appointments/${one.a.id}/reschedule`, { start: at(next, '15:00').toISOString(), reason: 'Doctor leave', patientConfirmed: true, doctorConfirmed: true }, newKey())).status).toBe(200);
    // a slot on the leave date itself is refused by the engine
    expect((await mgr.post(`/api/manager/appointments/${two.a.id}/reschedule`, { start: at(D, '18:00').toISOString(), reason: 'Doctor leave', patientConfirmed: true, doctorConfirmed: true }, newKey())).status).toBe(409);
    expect((await mgr.post(`/api/manager/appointments/${two.a.id}/cancel`, { reason: 'Patient ne cancel karwaya' })).status).toBe(200);

    expect((await mgr.post(`/api/manager/leave-impacts/${exId}/resolve`)).status).toBe(200);
    expect(await prisma.workflowTask.findFirstOrThrow({ where: { idempotencyKey: `availability:${exId}:impact` } })).toMatchObject({ status: 'COMPLETED' });
    expect((await mgr.get('/api/manager/leave-impacts')).body.items.some((x: { id: string }) => x.id === exId)).toBe(false);
  });
});

describe('§14 — patient follow-up', () => {
  it("lists yesterday's patients, saves ratings, escalates an issue to the MD, and leaves the pending list", async () => {
    const md = await makeUser('MD');
    const doctor = await doctorWithHours();
    const p = await patient();
    const y = addDaysStr(clinicDateStr(new Date()), -1);
    const appt = await prisma.appointment.create({ data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: at(y, '15:00'), endAt: at(y, '15:20'), status: 'DONE', source: 'RECEPTION', createdById: receptionId } });
    const f = await prisma.followUp.create({ data: { patientId: p.id, appointmentId: appt.id, dueDate: dateOnly(clinicDateStr(new Date())) } });
    const pend = await mgr.get('/api/manager/followups');
    expect(pend.body.items.find((x: { id: string }) => x.id === f.id)).toMatchObject({ patient: { name: p.name }, visit: { id: appt.id } });

    expect((await mgr.post(`/api/manager/followups/${f.id}`, { escalateToMd: true })).status).toBe(422);
    const done = await mgr.post(`/api/manager/followups/${f.id}`, { doctorRating: 5, staffRating: 4, clinicRating: 2, issue: 'Waiting area bohat garam tha', escalateToMd: true });
    expect(done.status).toBe(200);
    const c = await prisma.complaint.findUniqueOrThrow({ where: { id: done.body.complaintId }, include: { recipients: true } });
    expect(c).toMatchObject({ source: 'PATIENT', patientId: p.id, status: 'IN_REVIEW' });
    expect(c.escalatedToMdAt).not.toBeNull();
    expect(c.recipients.map((r) => r.userId)).toContain(md.id);
    expect((await mgr.get('/api/manager/followups')).body.items.some((x: { id: string }) => x.id === f.id)).toBe(false);
    expect((await mgr.post(`/api/manager/followups/${f.id}`, {})).body.error.code).toBe('ALREADY_DONE');
  });
});

describe('11a — Office Boy area editor', () => {
  it('Manager edits the list; the Office Boy round uses it; others cannot edit', async () => {
    const before = (await mgr.get('/api/manager/office-areas')).body.areas as string[];
    expect(before).toContain('Washroom (Female)');
    expect((await mgr.put('/api/manager/office-areas', { areas: ['A', 'a'] })).status).toBe(422);
    const ob = await agentFor('OFFICE_BOY');
    expect((await call(ob.agent).put('/api/manager/office-areas', { areas: ['X'] })).status).toBe(403);
    const next = [...before, `Rooftop ${uid()}`];
    expect((await mgr.put('/api/manager/office-areas', { areas: next })).status).toBe(200);
    await call(ob.agent).post('/api/attendance/check-in');
    expect((await call(ob.agent).get('/api/office/today')).body.areas).toEqual(next);
    expect((await lastAudit('SETTING_UPDATED', 'officeBoy.areas')) ?? (await prisma.auditEvent.findFirst({ where: { recordId: 'officeBoy.areas' }, orderBy: { id: 'desc' } }))).toBeTruthy();
    await mgr.put('/api/manager/office-areas', { areas: before });
  });
});

describe('§14 — audit search', () => {
  it('finds a patient journey, filters by actor, pages, and masks clinical content for the Manager', async () => {
    const doctor = await doctorWithHours();
    const D = addDaysStr(clinicDateStr(new Date()), 13);
    await freeRoomsFrom(at(D, '00:00'));
    const { a, p } = await booked(doctor.id, D, '15:00');
    await mgr.post(`/api/manager/appointments/${a.id}/cancel`, { reason: 'Audit test cancel' });
    await prisma.auditEvent.create({ data: { actorId: doctor.id, actorRole: 'DOCTOR', action: 'PLAN_SAVED', recordType: 'TreatmentPlanVersion', recordId: uid(), after: { consultationReason: 'Secret clinical note' } } });
    await prisma.auditEvent.create({ data: { actorId: doctor.id, actorRole: 'DOCTOR', action: 'TEST_MASK', recordType: 'Appointment', recordId: a.id, after: { status: 'X', consultationReason: 'Secret note 2' } } });

    const byPatient = await mgr.get(`/api/manager/audit?patientId=${p.id}`);
    expect(byPatient.status).toBe(200);
    expect(byPatient.body.items.some((e: { action: string; recordId: string }) => e.action === 'APPOINTMENT_CANCELLED' || e.recordId === a.id)).toBe(true);
    const masked = byPatient.body.items.find((e: { action: string }) => e.action === 'TEST_MASK');
    expect(masked.after).toEqual({ status: 'X', consultationReason: '[restricted]' });
    const plan = await mgr.get(`/api/manager/audit?actorId=${doctor.id}&recordType=TreatmentPlanVersion`);
    expect(plan.body.items[0]).toMatchObject({ after: '[restricted]', restricted: true });
    expect(JSON.stringify(plan.body)).not.toContain('Secret clinical note');

    const page1 = await mgr.get('/api/manager/audit?limit=2');
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await mgr.get(`/api/manager/audit?limit=2&cursor=${page1.body.nextCursor}`);
    expect(BigInt(page2.body.items[0].id)).toBeLessThan(BigInt(page1.body.items[1].id));
    expect((await mgr.get(`/api/manager/audit?actorId=${managerId}&action=cancel`)).body.items.every((e: { actorId: string }) => e.actorId === managerId)).toBe(true);
  });
});

describe('§14 — Assistants list for room assignment / replacement', () => {
  it('shows on-duty and busy flags', async () => {
    const a = await agentFor('ASSISTANT');
    await call(a.agent).post('/api/attendance/check-in');
    const list = await mgr.get('/api/manager/assistants');
    expect(list.body.items.find((x: { id: string }) => x.id === a.user.id)).toMatchObject({ onDuty: true, busy: false, available: true });
  });
});
