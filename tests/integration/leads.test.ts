import { beforeAll, describe, expect, it } from 'vitest';
import { addDaysStr, atClinicMinute, clinicDateStr, dateOnly } from '../../src/lib/time';
import { normalizePhone } from '../../src/lib/phone';
import { runCallbackReminders } from '../../src/jobs/callbacks';
import { listMyAppointments } from '../../src/modules/leads/service';
import { createPatient } from '../../src/modules/patients/service';
import {
  agentFor,
  call,
  doctorWithHours,
  ensureRooms,
  freeRoomsFrom,
  lastAudit,
  makeLead,
  makeSheet,
  makeUser,
  newKey,
  prisma,
  uniquePhone,
} from './helpers';

const D = addDaysStr(clinicDateStr(new Date()), 4);
const at = (hhmm: string, date = D) => atClinicMinute(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

let hamza: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  await ensureRooms();
  hamza = await makeUser('MARKETING_DIRECTOR');
  await makeUser('MARKETING_LEAD');
  await makeUser('MANAGER');
  await makeUser('MD');
  await makeUser('RECEPTIONIST');
});

async function leadMember() {
  const { user, agent } = await agentFor('LEAD_MEMBER');
  return { user, agent, api: call(agent) };
}

describe('§25 #1 — Lead member sees only assigned sheets', () => {
  it('three assigned sheets visible; unassigned sheet and its leads denied by direct API calls', async () => {
    const m = await leadMember();
    const other = await makeUser('LEAD_MEMBER');
    const mine = [await makeSheet(m.user.id, hamza.id), await makeSheet(m.user.id, hamza.id), await makeSheet(m.user.id, hamza.id)];
    const foreign = await makeSheet(other.id, hamza.id);
    const foreignLead = await makeLead(foreign.id, other.id);
    await makeLead(mine[0]!.id, m.user.id);

    const sheets = await m.api.get('/api/lead/sheets');
    expect(sheets.status).toBe(200);
    expect(sheets.body.items.map((s: { id: string }) => s.id).sort()).toEqual(mine.map((s) => s.id).sort());

    expect((await m.api.get(`/api/lead/sheets/${foreign.id}`)).status).toBe(403);
    expect((await m.api.get(`/api/lead/leads?sheetId=${foreign.id}`)).status).toBe(403);
    expect((await m.api.get(`/api/lead/leads/${foreignLead.id}`)).status).toBe(403);
    expect((await m.api.post(`/api/lead/leads/${foreignLead.id}/activities`, { channel: 'CALL', result: 'CONNECTED' })).status).toBe(403);
    const all = await m.api.get('/api/lead/leads');
    expect(all.body.items.every((l: { sheet: { id: string } }) => mine.some((s) => s.id === l.sheet.id))).toBe(true);
    expect(await prisma.auditEvent.count({ where: { action: 'AUTHZ_DENIED', actorId: m.user.id } })).toBeGreaterThanOrEqual(4);
  });

  it('unassigning a sheet removes access on the next request', async () => {
    const m = await leadMember();
    const sheet = await makeSheet(m.user.id, hamza.id);
    expect((await m.api.get(`/api/lead/sheets/${sheet.id}`)).status).toBe(200);
    await prisma.sheetAssignment.updateMany({ where: { sheetId: sheet.id, memberId: m.user.id }, data: { unassignedAt: new Date() } });
    expect((await m.api.get(`/api/lead/sheets/${sheet.id}`)).status).toBe(403);
  });

  it('other roles cannot use lead endpoints', async () => {
    const { agent } = await agentFor('RECEPTIONIST');
    expect((await call(agent).get('/api/lead/sheets')).status).toBe(403);
  });
});

describe('lead activity & status (spec §5, §7)', () => {
  it('call/WhatsApp attempts are logged with actor and move the lead status', async () => {
    const m = await leadMember();
    const sheet = await makeSheet(m.user.id, hamza.id);
    const lead = await makeLead(sheet.id, m.user.id);
    const r1 = await m.api.post(`/api/lead/leads/${lead.id}/activities`, { channel: 'CALL', result: 'NO_ANSWER' });
    expect(r1.status).toBe(201);
    expect(r1.body.lead.status).toBe('UNREACHABLE');
    const r2 = await m.api.post(`/api/lead/leads/${lead.id}/activities`, { channel: 'WHATSAPP', result: 'REPLIED', remarks: 'Interested in Hydrafacial' });
    expect(r2.body.lead.status).toBe('CONTACTED');
    expect(r2.body.activity.successful).toBe(true);
    const detail = await m.api.get(`/api/lead/leads/${lead.id}`);
    expect(detail.body.activities).toHaveLength(2);
    expect(detail.body.activities[0].actorId).toBe(m.user.id);
    expect((await m.api.post(`/api/lead/leads/${lead.id}/activities`, { channel: 'CALL', result: 'BOOKED' })).status).toBe(422);
    const ni = await m.api.post(`/api/lead/leads/${lead.id}/activities`, { channel: 'CALL', result: 'NOT_INTERESTED' });
    expect(ni.body.lead.status).toBe('NOT_INTERESTED');
  });

  it('phone search uses normalized matching', async () => {
    const m = await leadMember();
    const sheet = await makeSheet(m.user.id, hamza.id);
    const raw = uniquePhone();
    const lead = await makeLead(sheet.id, m.user.id, raw);
    const pretty = `+92 ${raw.slice(1, 4)} ${raw.slice(4)}`;
    const res = await m.api.get(`/api/lead/leads?q=${encodeURIComponent(pretty)}`);
    expect(res.body.items.map((l: { id: string }) => l.id)).toEqual([lead.id]);
  });
});

describe('§25 #8 — callbacks', () => {
  it('a 2-hour callback reminds exactly once; rescheduling changes the due time; completion is audited', async () => {
    const m = await leadMember();
    const sheet = await makeSheet(m.user.id, hamza.id);
    const lead = await makeLead(sheet.id, m.user.id);

    const set = await m.api.post(`/api/lead/leads/${lead.id}/follow-up`, { preset: '2h' });
    expect(set.status).toBe(201);
    const firstDue = new Date(set.body.callback.dueAt);
    expect(Math.round((firstDue.getTime() - Date.now()) / 60000)).toBeGreaterThanOrEqual(119);
    expect(set.body.lead.status).toBe('FOLLOW_UP_DUE');

    // Reschedule to 3h → old callback superseded; reminder at the old due time must not fire.
    const later = new Date(Date.now() + 3 * 3600_000);
    const re = await m.api.post(`/api/lead/leads/${lead.id}/follow-up`, { preset: 'custom', at: later.toISOString() });
    expect(new Date(re.body.lead.nextContactAt).getTime()).toBe(later.getTime());
    await runCallbackReminders(new Date(firstDue.getTime() + 60_000));
    expect(await prisma.notification.count({ where: { recipientId: m.user.id, type: 'CALLBACK_DUE', recordId: lead.id } })).toBe(0);

    // At the new time it fires — once, even if the watcher runs repeatedly / concurrently.
    const fireAt = new Date(later.getTime() + 60_000);
    await Promise.all([runCallbackReminders(fireAt), runCallbackReminders(fireAt)]);
    await runCallbackReminders(fireAt);
    expect(await prisma.notification.count({ where: { recipientId: m.user.id, type: 'CALLBACK_DUE', recordId: lead.id } })).toBe(1);
    const due = await m.api.get('/api/lead/callbacks?state=all');
    expect(due.body.items.find((c: { leadId: string; status: string }) => c.leadId === lead.id && c.status === 'DUE')).toBeTruthy();

    // Completing the call closes the callback and leaves an audit trail.
    await m.api.post(`/api/lead/leads/${lead.id}/activities`, { channel: 'CALL', result: 'CONNECTED' });
    const cbs = await prisma.leadCallback.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: 'asc' } });
    expect(cbs.map((c) => c.status)).toEqual(['SUPERSEDED', 'COMPLETED']);
    expect(cbs[1]!.completedAt).not.toBeNull();
    for (const action of ['LEAD_FOLLOW_UP_SET', 'LEAD_FOLLOW_UP_RESCHEDULED', 'LEAD_ACTIVITY_LOGGED']) {
      expect(await lastAudit(action, lead.id)).not.toBeNull();
    }
    expect(await prisma.auditEvent.count({ where: { action: 'CALLBACK_REMINDER_SENT', recordId: cbs[1]!.id } })).toBe(1);
  });

  it('custom follow-up must be in the future', async () => {
    const m = await leadMember();
    const lead = await makeLead((await makeSheet(m.user.id, hamza.id)).id, m.user.id);
    const res = await m.api.post(`/api/lead/leads/${lead.id}/follow-up`, { preset: 'custom', at: new Date(Date.now() - 60_000).toISOString() });
    expect(res.status).toBe(422);
  });
});

describe('§25 #3 — Lead books an available consult', () => {
  it('Patient, Doctor and Reception get matching appointment details; booking is attributed to member, campaign and lead', async () => {
    await freeRoomsFrom(at('00:00'));
    const m = await leadMember();
    const sheet = await makeSheet(m.user.id, hamza.id);
    const lead = await makeLead(sheet.id, m.user.id);
    const doctor = await doctorWithHours();
    const key = newKey();
    const body = {
      patient: { name: 'Booked Patient', whatsappConsent: true, contactConsent: true },
      doctorId: doctor.id,
      type: 'CONSULTATION',
      reason: 'Acne consultation',
      start: at('10:00').toISOString(),
    };
    const res = await m.api.post(`/api/lead/leads/${lead.id}/book`, body, key);
    expect(res.status).toBe(201);
    const appt = res.body.appointment;
    expect(appt).toMatchObject({ status: 'CONFIRMED', source: 'LEAD', leadId: lead.id, leadMemberId: m.user.id, sheetId: sheet.id, doctorId: doctor.id });

    const msgs = await prisma.messageOutbox.findMany({ where: { relatedType: 'Appointment', relatedId: appt.id } });
    expect(msgs.map((x) => x.idempotencyKey).sort()).toEqual([`appointment:${appt.id}:confirmed:doctor`, `appointment:${appt.id}:confirmed:patient`]);
    const [a, b] = msgs.map((x) => x.payload as Record<string, unknown>);
    for (const k of ['patientName', 'doctorName', 'when', 'type', 'room']) expect(a![k]).toEqual(b![k]); // same facts
    expect(await prisma.notification.count({ where: { recipientId: doctor.id, recordId: appt.id } })).toBe(1);
    const receptionists = await prisma.user.findMany({ where: { role: 'RECEPTIONIST', active: true }, select: { id: true } });
    expect(await prisma.notification.count({ where: { recordId: appt.id, recipientId: { in: receptionists.map((r) => r.id) } } })).toBe(receptionists.length);

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('BOOKED');

    // Retry with the same Idempotency-Key replays the booking — no second appointment, no extra messages.
    const replay = await m.api.post(`/api/lead/leads/${lead.id}/book`, body, key);
    expect(replay.body.appointment.id).toBe(appt.id);
    expect(await prisma.appointment.count({ where: { leadId: lead.id } })).toBe(1);
    expect(await prisma.messageOutbox.count({ where: { relatedId: appt.id } })).toBe(2);
  });

  it('§25 #4 — booking on a Doctor leave date is refused with the next available date/time', async () => {
    await freeRoomsFrom(at('00:00'));
    const m = await leadMember();
    const lead = await makeLead((await makeSheet(m.user.id, hamza.id)).id, m.user.id);
    const doctor = await doctorWithHours();
    await prisma.doctorAvailabilityException.create({ data: { doctorId: doctor.id, kind: 'LEAVE', date: dateOnly(D), status: 'APPROVED', requestedById: doctor.id } });
    const res = await m.api.post(`/api/lead/leads/${lead.id}/book`, { patient: { name: 'Leave Test' }, doctorId: doctor.id, type: 'CONSULTATION', start: at('11:00').toISOString() }, newKey());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(res.body.error.details.conflicts[0].code).toBe('DOCTOR_ON_LEAVE');
    expect(clinicDateStr(new Date(res.body.error.details.suggestions[0].start))).toBe(addDaysStr(D, 1));
    expect(await prisma.appointment.count({ where: { leadId: lead.id } })).toBe(0);
    // the patient created inside the failed transaction was rolled back too
    expect(await prisma.patient.count({ where: { phone: lead.phone } })).toBe(0);
  });
});

describe('D-071 — connection booking', () => {
  it('member books an own contact without a lead; it shows in their appointments; a busy slot is refused; other roles denied', async () => {
    await freeRoomsFrom(at('00:00'));
    const m = await leadMember();
    const doctor = await doctorWithHours();
    const phone = uniquePhone();
    const body = { patient: { name: 'Connection Patient', phone, whatsappConsent: true, contactConsent: true }, doctorId: doctor.id, type: 'CONSULTATION', start: at('11:00').toISOString() };
    const key = newKey();
    const res = await m.api.post('/api/lead/connection-book', body, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.appointment).toMatchObject({ status: 'CONFIRMED', source: 'CONNECTION', leadId: null, sheetId: null, leadMemberId: m.user.id, doctorId: doctor.id });
    expect((await m.api.post('/api/lead/connection-book', body, key)).body.appointment.id).toBe(res.body.appointment.id);
    expect(await lastAudit('CONNECTION_BOOKED', res.body.appointment.id)).not.toBeNull();
    const mine = await listMyAppointments({ id: m.user.id, role: 'LEAD_MEMBER' } as never, 'total');
    expect(JSON.stringify(mine)).toContain(res.body.appointment.id);

    // same Doctor, same time → refused with suggestions
    const busy = await m.api.post('/api/lead/connection-book', { ...body, patient: { ...body.patient, phone: uniquePhone(), name: 'Other Person' } }, newKey());
    expect(busy.status).toBe(409);
    // phone is required
    expect((await m.api.post('/api/lead/connection-book', { ...body, patient: { name: 'No Phone' } }, newKey())).status).toBe(400);
    const office = call((await agentFor('OFFICE_BOY')).agent);
    expect((await office.post('/api/lead/connection-book', body, newKey())).status).toBe(403);
  });
});

describe('shared phone numbers (D-010, clinic-confirmed)', () => {
  it('duplicate warning lists existing patients; staff must confirm; confirmation is audited', async () => {
    await freeRoomsFrom(at('00:00'));
    const m = await leadMember();
    const raw = uniquePhone();
    const lead = await makeLead((await makeSheet(m.user.id, hamza.id)).id, m.user.id, raw, 'Sister');
    const creator = await makeUser('RECEPTIONIST');
    const existing = await prisma.patient.create({ data: { name: 'Brother', phone: normalizePhone(raw)!, createdById: creator.id } });
    const doctor = await doctorWithHours();
    const base = { doctorId: doctor.id, type: 'CONSULTATION', start: at('12:00').toISOString() };

    const warn = await m.api.post(`/api/lead/leads/${lead.id}/book`, { ...base, patient: { name: 'Sister' } }, newKey());
    expect(warn.status).toBe(409);
    expect(warn.body.error.code).toBe('DUPLICATE_PHONE');
    expect(warn.body.error.details.existing.map((p: { id: string }) => p.id)).toEqual([existing.id]);

    const ok = await m.api.post(`/api/lead/leads/${lead.id}/book`, { ...base, patient: { name: 'Sister', confirmSharedPhone: { reason: 'Family member, same phone' } } }, newKey());
    expect(ok.status).toBe(201);
    const newPatientId = ok.body.appointment.patientId;
    expect(newPatientId).not.toBe(existing.id);
    const ev = await lastAudit('PATIENT_DUPLICATE_PHONE_CONFIRMED', newPatientId);
    expect(ev?.actorId).toBe(m.user.id);
    expect(ev?.reason).toBe('Family member, same phone');
    expect((ev?.after as { existingPatientIds: string[] }).existingPatientIds).toEqual([existing.id]);
  });

  it('booking for an existing patient is allowed only for a patient on the same phone', async () => {
    await freeRoomsFrom(at('00:00'));
    const m = await leadMember();
    const raw = uniquePhone();
    const lead = await makeLead((await makeSheet(m.user.id, hamza.id)).id, m.user.id, raw);
    const creator = await makeUser('RECEPTIONIST');
    const samePhone = await prisma.patient.create({ data: { name: 'Same', phone: normalizePhone(raw)!, createdById: creator.id } });
    const unrelated = await prisma.patient.create({ data: { name: 'Unrelated', phone: normalizePhone(uniquePhone())!, createdById: creator.id } });
    const doctor = await doctorWithHours();
    const base = { doctorId: doctor.id, type: 'CONSULTATION', start: at('13:00').toISOString() };
    expect((await m.api.post(`/api/lead/leads/${lead.id}/book`, { ...base, patient: { existingPatientId: unrelated.id } }, newKey())).status).toBe(403);
    const ok = await m.api.post(`/api/lead/leads/${lead.id}/book`, { ...base, patient: { existingPatientId: samePhone.id } }, newKey());
    expect(ok.status).toBe(201);
    expect(ok.body.appointment.patientId).toBe(samePhone.id);
  });

  it('a second patient on the same phone without confirmation is impossible even under a race', async () => {
    const creator = await makeUser('RECEPTIONIST');
    const actor = { id: creator.id, role: 'RECEPTIONIST' as const, displayName: 'r' };
    const phone = uniquePhone();
    const results = await Promise.allSettled([0, 1, 2].map(() => prisma.$transaction((tx) => createPatient(tx, actor, { name: 'Racer', phone, contactConsent: true, whatsappConsent: false }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.patient.count({ where: { phone: normalizePhone(phone)! } })).toBe(1);
  });
});

describe('appointment buckets & own-booking actions (spec §7)', () => {
  it('appointments land in the right bucket and also stay in Total', async () => {
    const m = await leadMember();
    const doctor = await makeUser('DOCTOR');
    const creator = await makeUser('RECEPTIONIST');
    const p = await prisma.patient.create({ data: { name: 'Bucket', phone: normalizePhone(uniquePhone())!, createdById: creator.id } });
    const now = new Date();
    const today = clinicDateStr(now);
    const mk = (days: number, status: 'CONFIRMED' | 'CANCELLED' = 'CONFIRMED') =>
      prisma.appointment.create({
        data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: atClinicMinute(addDaysStr(today, days), 15 * 60), endAt: atClinicMinute(addDaysStr(today, days), 15 * 60 + 20), status, source: 'LEAD', createdById: m.user.id, leadMemberId: m.user.id },
      });
    await Promise.all([mk(0), mk(1), mk(2), mk(5), mk(7), mk(12), mk(1, 'CANCELLED')]);
    const actor = { id: m.user.id, role: 'LEAD_MEMBER' as const, displayName: 'x' };
    const res = await listMyAppointments(actor, 'today', now);
    expect(res.counts).toMatchObject({ today: 1, after2: 2, after7: 2, total: 7 });
    expect((await listMyAppointments(actor, 'after7', now)).items).toHaveLength(2);
    expect((await listMyAppointments(actor, 'total', now)).items).toHaveLength(7);
  });

  it('member can reschedule/cancel own booking only; reschedule releases the old slot', async () => {
    await freeRoomsFrom(at('00:00'));
    const m = await leadMember();
    const otherMember = await leadMember();
    const lead = await makeLead((await makeSheet(m.user.id, hamza.id)).id, m.user.id);
    const doctor = await doctorWithHours();
    const booked = await m.api.post(`/api/lead/leads/${lead.id}/book`, { patient: { name: 'Mover' }, doctorId: doctor.id, type: 'CONSULTATION', start: at('14:00').toISOString() }, newKey());
    const id = booked.body.appointment.id;

    expect((await otherMember.api.post(`/api/lead/appointments/${id}/cancel`, { reason: 'not mine' })).status).toBe(403);
    expect((await otherMember.api.post(`/api/lead/appointments/${id}/reschedule`, { start: at('15:00').toISOString(), reason: 'not my booking' })).status).toBe(403);

    const r = await m.api.post(`/api/lead/appointments/${id}/reschedule`, { start: at('15:00').toISOString(), reason: 'Patient asked for later' });
    expect(r.status).toBe(200);
    expect(r.body.appointment.rescheduledFromId).toBe(id);
    expect(r.body.appointment.leadMemberId).toBe(m.user.id); // attribution carried over
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id } })).status).toBe('RESCHEDULED');
    expect(await prisma.messageOutbox.count({ where: { relatedId: r.body.appointment.id, template: 'appointment_rescheduled' } })).toBeGreaterThan(0);

    const c = await m.api.post(`/api/lead/appointments/${r.body.appointment.id}/cancel`, { reason: 'Patient travelling' });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('CANCELLED');
    // cancellation is not a lead outcome
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('BOOKED');
  });
});

describe('§8 performance & drill-down', () => {
  it('bookings exclude reschedules; check-ins counted separately; drill-down shows the exact lead', async () => {
    await freeRoomsFrom(at('00:00'));
    const m = await leadMember();
    const sheet = await makeSheet(m.user.id, hamza.id);
    const lead = await makeLead(sheet.id, m.user.id, uniquePhone(), 'Metric Lead');
    const doctor = await doctorWithHours();
    await m.api.post(`/api/lead/leads/${lead.id}/activities`, { channel: 'CALL', result: 'CONNECTED' });
    await m.api.post(`/api/lead/leads/${lead.id}/activities`, { channel: 'WHATSAPP', result: 'MESSAGE_SENT' });
    const b = await m.api.post(`/api/lead/leads/${lead.id}/book`, { patient: { name: 'Metric Patient' }, doctorId: doctor.id, type: 'CONSULTATION', start: at('16:00').toISOString() }, newKey());
    const r = await m.api.post(`/api/lead/appointments/${b.body.appointment.id}/reschedule`, { start: at('17:00').toISOString(), reason: 'later' });
    await prisma.appointment.update({ where: { id: r.body.appointment.id }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });

    const perf = await m.api.get('/api/lead/performance');
    expect(perf.body).toMatchObject({ contacted: 1, calls: 1, whatsapp: 1, bookings: 1, checkIns: 1 });
    expect(perf.body.conversion).toEqual({ contactedToBookingBp: 10000, bookingToCheckInBp: 10000 });

    const dd = await m.api.get('/api/lead/performance/drilldown?metric=checkIns');
    expect(dd.body.items).toHaveLength(1);
    expect(dd.body.items[0].lead).toMatchObject({ id: lead.id, name: 'Metric Lead' });
    expect(dd.body.items[0].lead.sheet.campaign).toBe(sheet.campaign);

    const hz = await agentFor('MARKETING_DIRECTOR');
    const rep = await call(hz.agent).get(`/api/lead-reports/performance?memberId=${m.user.id}`);
    expect(rep.body.bookings).toBe(1);
    const ob = await agentFor('OFFICE_BOY');
    expect((await call(ob.agent).get('/api/lead-reports/performance')).status).toBe(403);
  });
});

describe('§25 #23 — Ad / Issue request to Muaz and Hamza', () => {
  it('reaches both; either reply is visible to the sender on the same thread', async () => {
    const m = await leadMember();
    const sheet = await makeSheet(m.user.id, hamza.id);
    const res = await m.api.post('/api/requests/ad', { kind: 'RADIUS_CHANGE', sheetId: sheet.id, detail: 'Radius 5km se 10km karein', reason: 'Leads kam aa rahe hain' });
    expect(res.status).toBe(201);
    const id = res.body.id;
    const marketing = await prisma.user.findMany({ where: { role: { in: ['MARKETING_LEAD', 'MARKETING_DIRECTOR'] }, active: true }, select: { id: true } });
    expect(await prisma.notification.count({ where: { recordId: id, type: 'AD_REQUEST' } })).toBe(marketing.length);

    const muaz = await agentFor('MARKETING_LEAD');
    const hz = await agentFor('MARKETING_DIRECTOR');
    expect((await call(muaz.agent).post(`/api/requests/ad/${id}/messages`, { body: 'Kaunsa area?', status: 'NEED_DETAILS' })).status).toBe(201);
    expect((await m.api.post(`/api/requests/ad/${id}/messages`, { body: 'DHA Phase 5 tak' })).status).toBe(201);
    expect((await call(hz.agent).post(`/api/requests/ad/${id}/messages`, { body: 'Done, radius updated', status: 'COMPLETED' })).status).toBe(201);

    const t = await m.api.get(`/api/requests/ad/${id}`);
    expect(t.body.status).toBe('COMPLETED');
    expect(t.body.thread.map((x: { body: string }) => x.body)).toEqual(['Radius 5km se 10km karein', 'Kaunsa area?', 'DHA Phase 5 tak', 'Done, radius updated']);
    expect(t.body.thread.map((x: { statusChange: string | null }) => x.statusChange)).toEqual(['PENDING', 'NEED_DETAILS', 'PENDING', 'COMPLETED']);

    // Sender cannot set status; other lead members cannot see the thread.
    expect((await m.api.post(`/api/requests/ad/${id}/messages`, { body: 'approve it', status: 'COMPLETED' })).status).toBe(403);
    const stranger = await leadMember();
    expect((await stranger.api.get(`/api/requests/ad/${id}`)).status).toBe(403);
  });
});

describe('§25 #24 — complaint and leave routing', () => {
  it('Lead complaint → selected recipient + Hamza + Muaz; staff complaint → selected only; Manager complaint → MD + Hamza', async () => {
    const m = await leadMember();
    const lc = await m.api.post('/api/requests/complaints', { subject: 'Sheet issue', detail: 'Leads duplicate aa rahe', recipient: 'MANAGER' });
    expect(lc.status).toBe(201);
    const recRoles = async (id: string) => {
      const rec = await prisma.complaintRecipient.findMany({ where: { complaintId: id } });
      const users = await prisma.user.findMany({ where: { id: { in: rec.map((r) => r.userId) } }, select: { role: true } });
      return new Set(users.map((u) => u.role));
    };
    expect([...(await recRoles(lc.body.id))].sort()).toEqual(['MANAGER', 'MARKETING_DIRECTOR', 'MARKETING_LEAD']);

    // MD must exist before the complaint is raised: recipients are the active users holding the role at that time.
    const md = await agentFor('MD');
    const asst = await agentFor('ASSISTANT');
    expect((await call(asst.agent).post('/api/requests/complaints', { subject: 'xy', detail: 'no recipient' })).status).toBe(422);
    const ac = await call(asst.agent).post('/api/requests/complaints', { subject: 'Shift', detail: 'Shift issue', recipient: 'MD' });
    expect([...(await recRoles(ac.body.id))]).toEqual(['MD']);

    const mgr = await agentFor('MANAGER');
    const mc = await call(mgr.agent).post('/api/requests/complaints', { subject: 'Ops', detail: 'Ops issue' });
    expect([...(await recRoles(mc.body.id))].sort()).toEqual(['MARKETING_DIRECTOR', 'MD']);

    // Non-parties cannot open it; rejection needs a reason (body) and is kept in history.
    const stranger = await agentFor('RECEPTIONIST');
    expect((await call(stranger.agent).get(`/api/requests/complaints/${ac.body.id}`)).status).toBe(403);
    const resolve = await call(md.agent).post(`/api/requests/complaints/${ac.body.id}/messages`, { body: 'Shift change kar di', status: 'RESOLVED' });
    expect(resolve.status).toBe(201);
    const view = await call(asst.agent).get(`/api/requests/complaints/${ac.body.id}`);
    expect(view.body.status).toBe('RESOLVED');
    expect(view.body.thread).toHaveLength(2);
  });

  it('staff leave → Manager; Manager leave → MD (Manager cannot approve own); reasons required; history saved', async () => {
    const asst = await agentFor('ASSISTANT');
    const mgr = await agentFor('MANAGER');
    const md = await agentFor('MD');
    const tomorrow = addDaysStr(clinicDateStr(new Date()), 1);
    const body = { kind: 'LEAVE', startAt: atClinicMinute(tomorrow, 9 * 60).toISOString(), endAt: atClinicMinute(tomorrow, 21 * 60).toISOString(), reason: 'Family event' };

    const sl = await call(asst.agent).post('/api/requests/leave', body);
    expect(sl.body.approverRole).toBe('MANAGER');
    expect((await call(md.agent).post(`/api/requests/leave/${sl.body.id}/decision`, { status: 'APPROVED' })).status).toBe(403); // MD is not this approver
    expect((await call(mgr.agent).post(`/api/requests/leave/${sl.body.id}/decision`, { status: 'REJECTED' })).status).toBe(422); // reason required
    const ret = await call(mgr.agent).post(`/api/requests/leave/${sl.body.id}/decision`, { status: 'RETURNED_FOR_CORRECTION', reason: 'Coverage plan add karein' });
    expect(ret.body.status).toBe('RETURNED_FOR_CORRECTION');
    const resub = await call(asst.agent).put(`/api/requests/leave/${sl.body.id}`, { ...body, coveragePlan: 'Zara covers P01' });
    expect(resub.body.status).toBe('PENDING');
    const ok = await call(mgr.agent).post(`/api/requests/leave/${sl.body.id}/decision`, { status: 'APPROVED' });
    expect(ok.body.status).toBe('APPROVED');
    const hist = await call(asst.agent).get(`/api/requests/leave/${sl.body.id}`);
    expect(hist.body.thread.map((t: { statusChange: string }) => t.statusChange)).toEqual(['PENDING', 'RETURNED_FOR_CORRECTION', 'PENDING', 'APPROVED']);

    const ml = await call(mgr.agent).post('/api/requests/leave', { ...body, kind: 'EARLY_LEAVE' });
    expect(ml.body.approverRole).toBe('MD');
    expect((await call(mgr.agent).post(`/api/requests/leave/${ml.body.id}/decision`, { status: 'APPROVED' })).status).toBe(403);
    expect((await call(md.agent).post(`/api/requests/leave/${ml.body.id}/decision`, { status: 'APPROVED' })).body.status).toBe('APPROVED');
  });

  it('Lead member leave: Manager approves; Hamza + Muaz notified of request and decision (D-013)', async () => {
    const m = await leadMember();
    const mgr = await agentFor('MANAGER');
    const tomorrow = addDaysStr(clinicDateStr(new Date()), 1);
    const lv = await m.api.post('/api/requests/leave', { kind: 'LEAVE', startAt: atClinicMinute(tomorrow, 600).toISOString(), endAt: atClinicMinute(tomorrow, 1200).toISOString(), reason: 'Exam' });
    expect(lv.body.approverRole).toBe('MANAGER');
    const marketing = await prisma.user.findMany({ where: { role: { in: ['MARKETING_DIRECTOR', 'MARKETING_LEAD'] }, active: true }, select: { id: true } });
    expect(await prisma.notification.count({ where: { recordId: lv.body.id, type: 'LEAVE_REQUESTED', recipientId: { in: marketing.map((x) => x.id) } } })).toBe(marketing.length);
    await call(mgr.agent).post(`/api/requests/leave/${lv.body.id}/decision`, { status: 'APPROVED' });
    expect(await prisma.notification.count({ where: { recordId: lv.body.id, type: 'LEAVE_DECIDED', recipientId: { in: [m.user.id, ...marketing.map((x) => x.id)] } } })).toBe(marketing.length + 1);
    const hz = await agentFor('MARKETING_DIRECTOR');
    expect((await call(hz.agent).get(`/api/requests/leave/${lv.body.id}`)).status).toBe(200);
    expect((await call(hz.agent).post(`/api/requests/leave/${lv.body.id}/decision`, { status: 'REJECTED', reason: 'x' })).status).toBe(403);
  });

  it('Doctor uses the availability workflow, not generic leave', async () => {
    const dr = await agentFor('DOCTOR');
    const res = await call(dr.agent).post('/api/requests/leave', { kind: 'LEAVE', startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'x' });
    expect(res.status).toBe(422);
  });
});
