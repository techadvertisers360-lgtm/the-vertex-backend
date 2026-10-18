import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageOutbox, Prisma } from '@prisma/client';
import { deliverMessage } from '../../src/jobs/outbox';
import { runProcedureDayRelease, runProcedureReminders } from '../../src/jobs/procedureDay';
import { normalizePhone } from '../../src/lib/phone';
import { addDaysStr, addMinutes, atClinicMinute, clinicDateStr, dateOnly } from '../../src/lib/time';
import { enqueueMessage } from '../../src/services/messaging';
import { registerProvider, ScriptedProvider } from '../../src/services/providers';
import { clearSettingsCache } from '../../src/services/settings';
import { agentFor, app, call, ensureRooms, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

type Api = ReturnType<typeof call>;
let mgr: Api;
let managerId: string;
let reception: Api;
let receptionId: string;
let rooms: { id: string; code: string }[];
const SECRET = process.env.WHATSAPP_WEBHOOK_SECRET!;

beforeAll(async () => {
  await ensureRooms();
  const m = await agentFor('MANAGER');
  mgr = call(m.agent);
  managerId = m.user.id;
  const r = await agentFor('RECEPTIONIST');
  reception = call(r.agent);
  receptionId = r.user.id;
  rooms = await prisma.room.findMany({ where: { kind: 'PROCEDURE' }, orderBy: { sortOrder: 'asc' }, select: { id: true, code: true } });
});

/** Settings changed by a test are restored after it (shared test DB). */
const touched = new Map<string, Prisma.JsonValue | undefined>();
async function setSetting(key: string, value: unknown) {
  if (!touched.has(key)) touched.set(key, (await prisma.setting.findUnique({ where: { key } }))?.value);
  await prisma.setting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue, isPlaceholder: false, description: 'test' }, update: { value: value as Prisma.InputJsonValue } });
  clearSettingsCache();
}
async function restoreSettings() {
  for (const [key, value] of touched) {
    if (value === undefined) await prisma.setting.deleteMany({ where: { key } });
    else await prisma.setting.update({ where: { key }, data: { value: value as Prisma.InputJsonValue } });
  }
  touched.clear();
  clearSettingsCache();
}
afterAll(restoreSettings);

/** A Doctor (with a WhatsApp number) and a patient whose plan has one future session per `starts` entry. */
async function plannedSessions(starts: Date[], opts: { consent?: boolean; roomId?: string | null } = {}) {
  const doctor = await makeUser('DOCTOR');
  await prisma.user.update({ where: { id: doctor.id }, data: { phone: normalizePhone(uniquePhone()) } });
  const patient = await prisma.patient.create({ data: { name: `Plan Patient ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: receptionId, whatsappConsent: opts.consent ?? true } });
  const past = addMinutes(new Date(), -60 * 24 * 3);
  const consult = await prisma.appointment.create({ data: { patientId: patient.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: past, endAt: addMinutes(past, 20), status: 'DONE', source: 'RECEPTION', createdById: receptionId } });
  const plan = await prisma.treatmentPlan.create({ data: { patientId: patient.id, doctorId: doctor.id, appointmentId: consult.id, currentVersionNo: 1 } });
  const version = await prisma.treatmentPlanVersion.create({
    data: { planId: plan.id, versionNo: 1, consultationReason: 'Laser course', consultationFeePaisa: 0n, itemsSubtotalPaisa: 0n, itemsDiscountPaisa: 0n, totalDiscountPaisa: 0n, grandTotalPaisa: 0n, advanceRequestedPaisa: 0n, balancePaisa: 0n, installmentCount: 0, createdById: doctor.id },
  });
  const sessions = [];
  for (const [i, start] of starts.entries()) {
    const item = await prisma.treatmentPlanItem.create({ data: { versionId: version.id, sessionNumber: i + 2, procedureName: 'Laser session', sameDay: false, scheduledStart: start, scheduledEnd: addMinutes(start, 60), pricePaisa: 0n, status: 'SCHEDULED' } });
    const appt = await prisma.appointment.create({
      data: { patientId: patient.id, doctorId: doctor.id, type: 'PROCEDURE', startAt: start, endAt: addMinutes(start, 60), status: 'CONFIRMED', source: 'DOCTOR_PLAN', treatmentPlanItemId: item.id, roomId: opts.roomId === undefined ? rooms[1]!.id : opts.roomId, createdById: doctor.id },
    });
    sessions.push({ item, appt });
  }
  return { doctor, patient, sessions };
}

const DAY = 86_400_000;
const reminderMsgs = (appointmentId: string) => prisma.messageOutbox.findMany({ where: { relatedType: 'Appointment', relatedId: appointmentId, template: 'procedure_reminder' } });

describe('§19 — procedure reminder exactly 2 days before, per session, never combined', () => {
  it('fires at the 2-day mark only, once per session, to patient + Doctor, with a Manager stock check', async () => {
    const base = Date.now() + 10 * DAY + Math.floor(Math.random() * 30) * 60_000;
    const t1 = new Date(base);
    const t2 = new Date(base + 2 * 60 * 60_000); // same patient, same day, two hours later — still separate
    const { doctor, patient, sessions } = await plannedSessions([t1, t2]);
    const [s1, s2] = sessions;

    await runProcedureReminders(new Date(t1.getTime() - 2 * DAY - 60_000));
    expect(await reminderMsgs(s1!.appt.id)).toHaveLength(0);

    const at = new Date(t1.getTime() - 2 * DAY + 1000);
    await Promise.all([runProcedureReminders(at), runProcedureReminders(at)]); // two workers at once
    const m1 = await reminderMsgs(s1!.appt.id);
    expect(m1.map((m) => (m.patientId ? 'patient' : 'doctor')).sort()).toEqual(['doctor', 'patient']);
    expect(m1.find((m) => m.patientId)).toMatchObject({ toPhone: patient.phone, status: 'QUEUED' });
    expect((m1[0]!.payload as { procedure: string; session: number }).session).toBe(2);
    expect(await reminderMsgs(s2!.appt.id)).toHaveLength(0); // 2 h later → not yet 2 days away

    await runProcedureReminders(at);
    expect(await reminderMsgs(s1!.appt.id)).toHaveLength(2);
    expect(await prisma.job.count({ where: { idempotencyKey: `procedure:${s1!.appt.id}:reminder_2d` } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: doctor.id, type: 'PROCEDURE_REMINDER', recordId: s1!.appt.id } })).toBe(1);
    const check = await prisma.workflowTask.findUniqueOrThrow({ where: { idempotencyKey: `procedure:${s1!.appt.id}:stock_check` } });
    expect(check).toMatchObject({ type: 'MANAGER_STOCK_CHECK', status: 'PENDING', assignedRole: 'MANAGER' });
    expect(await prisma.notification.count({ where: { recipientId: managerId, type: 'STOCK_CHECK', recordId: check.id } })).toBe(1);

    await runProcedureReminders(new Date(t2.getTime() - 2 * DAY + 1000));
    expect(await reminderMsgs(s2!.appt.id)).toHaveLength(2);
    expect(await prisma.workflowTask.count({ where: { type: 'MANAGER_STOCK_CHECK', patientId: patient.id } })).toBe(2);

    // Manager sees and completes the stock check
    const open = await mgr.get('/api/manager/stock-checks');
    expect(open.body.items.some((t: { id: string }) => t.id === check.id)).toBe(true);
    expect((await mgr.post(`/api/manager/stock-checks/${check.id}/complete`, { note: 'Gel 3 tubes available' })).status).toBe(200);
    expect((await mgr.post(`/api/manager/stock-checks/${check.id}/complete`, {})).status).toBe(409);
    expect((await reception.post(`/api/manager/stock-checks/${check.id}/complete`, {})).status).toBe(403);
  });

  it('cancel / reschedule: the old reminder is not sent and its stock check is dropped; the new date gets its own', async () => {
    const t = new Date(Date.now() + 20 * DAY);
    const { sessions } = await plannedSessions([t]);
    const s = sessions[0]!;
    await runProcedureReminders(new Date(t.getTime() - 2 * DAY + 1000));
    const [patientMsg] = (await reminderMsgs(s.appt.id)).filter((m) => m.patientId);

    // Rescheduled before delivery (D-012: a new appointment carries the plan item)
    await prisma.appointment.update({ where: { id: s.appt.id }, data: { status: 'RESCHEDULED', treatmentPlanItemId: null } });
    const t2 = new Date(t.getTime() + 3 * DAY);
    const moved = await prisma.appointment.create({ data: { ...s.appt, id: undefined, startAt: t2, endAt: addMinutes(t2, 60), status: 'CONFIRMED', treatmentPlanItemId: s.item.id, createdAt: undefined, updatedAt: undefined } as Prisma.AppointmentUncheckedCreateInput });

    await deliverMessage({ ...patientMsg!, status: 'SENDING' });
    expect(await prisma.messageOutbox.findUniqueOrThrow({ where: { id: patientMsg!.id } })).toMatchObject({ status: 'CANCELLED', errorClass: 'superseded' });
    await runProcedureReminders(new Date(t.getTime() - 2 * DAY + 2000));
    expect((await prisma.workflowTask.findUniqueOrThrow({ where: { idempotencyKey: `procedure:${s.appt.id}:stock_check` } })).status).toBe('CANCELLED');

    await runProcedureReminders(new Date(t2.getTime() - 2 * DAY - 60_000));
    expect(await reminderMsgs(moved.id)).toHaveLength(0);
    await runProcedureReminders(new Date(t2.getTime() - 2 * DAY + 1000));
    expect(await reminderMsgs(moved.id)).toHaveLength(2);
  });

  it('Reception upcoming list shows patient / Doctor reminder status and the stock check', async () => {
    const t = new Date(Date.now() + 2 * DAY - 60 * 60_000); // inside the window already (booked late) → sent on the next run
    const { sessions } = await plannedSessions([t]);
    await runProcedureReminders(new Date());
    const up = await reception.get('/api/reception/upcoming');
    const row = up.body.items.find((r: { id: string }) => r.id === sessions[0]!.appt.id);
    expect(row).toMatchObject({ reminderStatus: 'QUEUED', doctorReminderStatus: 'QUEUED', stockCheck: 'PENDING' });
  });
});

// ───────────── WhatsApp provider / outbox ─────────────

async function patient(consent = true) {
  return prisma.patient.create({ data: { name: `Msg Patient ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: receptionId, whatsappConsent: consent } });
}
async function queued(p: { id: string; phone: string } | null, template = 'visit_thanks', payload: Record<string, unknown> = { patientName: 'Test' }): Promise<MessageOutbox> {
  const m = await enqueueMessage(prisma, { template, toPhone: p?.phone ?? normalizePhone(uniquePhone())!, patientId: p?.id ?? null, payload, idempotencyKey: `test:${uid()}` });
  return prisma.messageOutbox.update({ where: { id: m.id }, data: { status: 'SENDING' } });
}
const reload = (id: string) => prisma.messageOutbox.findUniqueOrThrow({ where: { id } });

describe('§20 — WhatsApp outbox: consent, quiet hours, provider + templates, retries, terminal alert', () => {
  beforeEach(restoreSettings);
  afterEach(restoreSettings);

  it('console (default) delivers; no consent / opt-out cancels; quiet hours delay patient messages only', async () => {
    const ok = await queued(await patient());
    await deliverMessage(ok);
    expect(await reload(ok.id)).toMatchObject({ status: 'DELIVERED', retryCount: 1 });

    const noConsent = await queued(await patient(false));
    await deliverMessage(noConsent);
    expect(await reload(noConsent.id)).toMatchObject({ status: 'CANCELLED', errorClass: 'consent' });

    await setSetting('notify.quietHoursStart', '00:00');
    await setSetting('notify.quietHoursEnd', '23:59');
    const quiet = await queued(await patient());
    const now = new Date();
    await deliverMessage(quiet, now);
    const q = await reload(quiet.id);
    expect(q.status).toBe('QUEUED');
    expect(q.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    const staff = await queued(null, 'password_reset', { name: 'X', link: 'http://x' });
    await deliverMessage(staff, now);
    expect((await reload(staff.id)).status).toBe('DELIVERED');
  });

  it('retries transient failures with backoff, then fails terminally: Manager alert + open task; Manager retry closes it', async () => {
    const prov = new ScriptedProvider([
      { ok: false, errorClass: 'transient', error: 'timeout 1' },
      { ok: false, errorClass: 'transient', error: 'timeout 2' },
      { ok: false, errorClass: 'transient', error: 'timeout 3' },
    ]);
    registerProvider(prov);
    await setSetting('whatsapp.provider', 'scripted');
    await setSetting('whatsapp.senderNumber', '923000000000');
    await setSetting('notify.maxRetries', 2);
    await setSetting('notify.retryBaseSec', 60);
    const p = await patient();
    let m = await queued(p);
    const t0 = new Date();
    await deliverMessage(m, t0);
    m = await reload(m.id);
    expect(m).toMatchObject({ status: 'QUEUED', retryCount: 1, lastError: 'timeout 1' });
    expect(m.nextAttemptAt.getTime() - t0.getTime()).toBe(60_000);
    await deliverMessage({ ...m, status: 'SENDING' }, t0);
    m = await reload(m.id);
    expect(m.nextAttemptAt.getTime() - t0.getTime()).toBe(120_000); // exponential
    await deliverMessage({ ...m, status: 'SENDING' }, t0);
    m = await reload(m.id);
    expect(m).toMatchObject({ status: 'FAILED', terminal: true, retryCount: 3 });
    expect(await prisma.notification.count({ where: { recipientId: managerId, type: 'MESSAGE_FAILED', recordId: m.id } })).toBe(1);
    const task = await prisma.workflowTask.findUniqueOrThrow({ where: { idempotencyKey: `message:${m.id}:failure` } });
    expect(task).toMatchObject({ type: 'MANAGER_MESSAGE_FAILURE', status: 'PENDING' });
    expect(prov.contexts[0]).toMatchObject({ senderNumber: '923000000000', text: expect.stringContaining('shukriya') });

    const dash = await mgr.get('/api/manager/dashboard');
    expect(dash.body.highlights.some((h: { kind: string }) => h.kind === 'message_failure')).toBe(true);

    const retry = await mgr.post(`/api/manager/messages/${m.id}/retry`);
    expect(retry.status).toBe(200);
    expect(await reload(m.id)).toMatchObject({ status: 'QUEUED', retryCount: 0, terminal: false });
    expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('COMPLETED');
    expect((await mgr.post(`/api/manager/messages/${m.id}/retry`)).status).toBe(409);
    await deliverMessage({ ...(await reload(m.id)), status: 'SENDING' });
    expect((await reload(m.id)).status).toBe('SENT'); // real providers wait for the delivery webhook
  });

  it('permanent errors fail at once; configuration problems fail loudly with one alert per day, never silently "deliver"', async () => {
    registerProvider(new ScriptedProvider([{ ok: false, errorClass: 'permanent', error: 'invalid number' }]));
    await setSetting('whatsapp.provider', 'scripted');
    await setSetting('whatsapp.senderNumber', '923000000000');
    const perm = await queued(await patient());
    await deliverMessage(perm);
    expect(await reload(perm.id)).toMatchObject({ status: 'FAILED', retryCount: 1, errorClass: 'permanent' });

    const vendor = `no-such-${uid()}`; // unique per run: config alerts dedupe per reason per day
    await setSetting('whatsapp.provider', vendor);
    const a = await queued(await patient());
    const b = await queued(await patient());
    await deliverMessage(a);
    await deliverMessage(b);
    expect(await reload(a.id)).toMatchObject({ status: 'FAILED', errorClass: 'config' });
    expect((await reload(b.id)).lastError).toContain(vendor);
    const cfgAlerts = await prisma.notification.count({ where: { recipientId: managerId, type: 'MESSAGE_FAILED', recordId: { in: [a.id, b.id] } } });
    expect(cfgAlerts).toBe(1);

    // a template-only vendor without an approved template mapping
    const strict = new ScriptedProvider([], true);
    Object.defineProperty(strict, 'id', { value: 'strict' });
    registerProvider(strict);
    await setSetting('whatsapp.provider', 'strict');
    const c = await queued(await patient(), 'procedure_reminder', { patientName: 'A', procedure: 'Laser' });
    await deliverMessage(c);
    expect((await reload(c.id)).lastError).toContain('procedure_reminder');
    await setSetting('whatsapp.templates', { procedure_reminder: 'vh_procedure_reminder_v1' });
    const d = await queued(await patient(), 'procedure_reminder', { patientName: 'A', procedure: 'Laser', when: '20 Oct', doctorName: 'Dr X' });
    await deliverMessage(d);
    expect((await reload(d.id)).status).toBe('SENT');
    expect(strict.contexts.at(-1)).toMatchObject({ providerTemplate: 'vh_procedure_reminder_v1', variables: ['A', 'Laser', '', '20 Oct', 'Dr X', '', ''] });

    await setSetting('whatsapp.provider', 'scripted');
    await setSetting('whatsapp.senderNumber', '');
    const e = await queued(await patient());
    await deliverMessage(e);
    expect((await reload(e.id)).lastError).toContain('Sender number');
  });
});

describe('§20 — delivery webhook and opt-out', () => {
  const hook = (path: string, body: object, secret = SECRET) => request(app).post(`/api/webhooks/whatsapp/${path}`).set('x-webhook-secret', secret).send(body);

  async function sent() {
    const m = await queued(await patient());
    const pid = `prov_${uid()}`;
    return prisma.messageOutbox.update({ where: { id: m.id }, data: { status: 'SENT', providerMessageId: pid, sentAt: new Date() } });
  }

  it('moves status forward only; READ counts as delivered; FAILED alerts the Manager; bad secret is refused', async () => {
    const m = await sent();
    expect((await hook('status', { providerMessageId: m.providerMessageId, status: 'DELIVERED' }, 'wrong')).status).toBe(401);
    expect((await hook('status', { providerMessageId: m.providerMessageId, status: 'DELIVERED' })).status).toBe(200);
    expect((await hook('status', { providerMessageId: m.providerMessageId, status: 'SENT' })).status).toBe(200); // late, out of order
    expect((await reload(m.id)).status).toBe('DELIVERED');
    const r = await sent();
    await hook('status', { providerMessageId: r.providerMessageId, status: 'READ' });
    expect((await reload(r.id)).status).toBe('DELIVERED');

    const f = await sent();
    await hook('status', { providerMessageId: f.providerMessageId, status: 'FAILED', error: 'Number not on WhatsApp' });
    expect(await reload(f.id)).toMatchObject({ status: 'FAILED', terminal: true, lastError: 'Number not on WhatsApp' });
    expect(await prisma.notification.count({ where: { recipientId: managerId, type: 'MESSAGE_FAILED', recordId: f.id } })).toBe(1);
    expect((await hook('status', { providerMessageId: 'unknown', status: 'DELIVERED' })).body.matched).toBe(false);
  });

  it('a STOP reply opts the number out and cancels queued messages; other text is ignored; Manager can opt back in with a reason', async () => {
    const p = await patient();
    const waiting = await enqueueMessage(prisma, { template: 'visit_thanks', toPhone: p.phone, patientId: p.id, payload: { patientName: p.name }, idempotencyKey: `test:${uid()}` });
    expect((await hook('inbound', { from: `+${p.phone}`, text: 'Thanks!' })).body.optOut).toBe(false);
    const stop = await hook('inbound', { from: `0${p.phone.slice(2)}`, text: 'STOP' });
    expect(stop.body).toMatchObject({ optOut: true, patients: 1 });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).whatsappOptOutAt).not.toBeNull();
    expect(await reload(waiting.id)).toMatchObject({ status: 'CANCELLED', errorClass: 'opt_out' });
    expect(await prisma.auditEvent.count({ where: { action: 'PATIENT_WHATSAPP_OPT_OUT', recordId: p.id } })).toBe(1);

    expect((await mgr.post(`/api/manager/messages/patients/${p.id}/whatsapp`, { optIn: true })).status).toBe(422); // reason required
    const back = await mgr.post(`/api/manager/messages/patients/${p.id}/whatsapp`, { optIn: true, reason: 'Patient ne phone par dobara consent diya' });
    expect(back.body).toMatchObject({ whatsappConsent: true, whatsappOptOutAt: null });
    expect((await prisma.auditEvent.findFirst({ where: { action: 'PATIENT_WHATSAPP_OPT_IN', recordId: p.id } }))?.reason).toContain('consent');
  });
});

describe('§20 — Manager message log', () => {
  it('lists and filters, shows rendered text, hides password-reset links, cancels queued; Manager only', async () => {
    const p = await patient();
    const m = await enqueueMessage(prisma, { template: 'visit_thanks', toPhone: p.phone, patientId: p.id, payload: { patientName: p.name, feedbackLink: 'http://f/1' }, idempotencyKey: `test:${uid()}` });
    const secret = await enqueueMessage(prisma, { template: 'password_reset', toPhone: normalizePhone(uniquePhone())!, payload: { name: 'Staff', link: 'http://reset?token=SECRET123' }, idempotencyKey: `test:${uid()}` });

    const list = await mgr.get(`/api/manager/messages?q=${encodeURIComponent(p.name)}`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ id: m.id, templateLabel: 'Thank you + feedback', status: 'QUEUED', recipient: { kind: 'patient', name: p.name } });
    const byStatus = await mgr.get('/api/manager/messages?status=QUEUED&template=visit_thanks&limit=5');
    expect(byStatus.body.items.every((x: { status: string; template: string }) => x.status === 'QUEUED' && x.template === 'visit_thanks')).toBe(true);

    const detail = await mgr.get(`/api/manager/messages/${m.id}`);
    expect(detail.body.text).toContain(p.name);
    const hidden = await mgr.get(`/api/manager/messages/${secret.id}`);
    expect(hidden.body).toMatchObject({ sensitive: true, text: null, payload: null });
    expect(JSON.stringify(hidden.body)).not.toContain('SECRET123');

    expect((await mgr.post(`/api/manager/messages/${m.id}/cancel`, { reason: 'Ghalat number' })).status).toBe(200);
    expect((await mgr.post(`/api/manager/messages/${m.id}/cancel`, { reason: 'again' })).status).toBe(409);
    expect((await mgr.get(`/api/manager/messages/${m.id}`)).body.history.map((h: { action: string }) => h.action)).toContain('MESSAGE_CANCELLED');

    const summary = await mgr.get('/api/manager/messages/summary');
    expect(summary.body.config).toMatchObject({ provider: 'console', mock: true });
    expect(summary.body.config.templates.map((t: { key: string }) => t.key)).toContain('procedure_reminder');
    expect(JSON.stringify(summary.body)).not.toContain(SECRET);

    for (const role of ['RECEPTIONIST', 'MD', 'DOCTOR'] as const) expect((await call((await agentFor(role)).agent).get('/api/manager/messages')).status).toBe(403);
  });
});

// ───────────── Procedure-day release ─────────────

describe('§19 / §23 — procedure-day task release with missing-assignment alert', () => {
  it('releases each session once at the release time; alerts when the room has no Assistant on duty; resolves when assigned', async () => {
    const day = addDaysStr(clinicDateStr(new Date()), 40 + Math.floor(Math.random() * 300));
    const start = atClinicMinute(day, 15 * 60);
    const withDuty = await plannedSessions([start], { roomId: rooms[0]!.id });
    const noDuty = await plannedSessions([addMinutes(start, 60)], { roomId: rooms[2]!.id });
    const asst = await makeUser('ASSISTANT');
    await prisma.roomAssignment.create({ data: { assistantId: asst.id, roomId: rooms[0]!.id, date: dateOnly(day), assignedById: managerId } });

    await runProcedureDayRelease(atClinicMinute(day, 7 * 60 + 59));
    expect(await prisma.procedureTask.count({ where: { planItemId: withDuty.sessions[0]!.item.id } })).toBe(0);

    const at = atClinicMinute(day, 8 * 60 + 1);
    await Promise.all([runProcedureDayRelease(at), runProcedureDayRelease(at)]);
    await runProcedureDayRelease(addMinutes(at, 1));
    const t1 = await prisma.procedureTask.findUniqueOrThrow({ where: { planItemId: withDuty.sessions[0]!.item.id } });
    expect(t1).toMatchObject({ assistantId: null, status: 'PENDING', currentStep: 'ACCEPT', roomId: rooms[0]!.id, appointmentId: withDuty.sessions[0]!.appt.id });
    expect(t1.releasedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { recipientId: asst.id, type: 'PROCEDURE_PLANNED_TODAY', recordId: t1.id } })).toBe(1);
    expect(await prisma.workflowTask.count({ where: { type: 'MANAGER_ASSIGNMENT_MISSING', planItemId: withDuty.sessions[0]!.item.id } })).toBe(0);

    const t2 = await prisma.procedureTask.findUniqueOrThrow({ where: { planItemId: noDuty.sessions[0]!.item.id } });
    const missing = await prisma.workflowTask.findFirstOrThrow({ where: { type: 'MANAGER_ASSIGNMENT_MISSING', planItemId: noDuty.sessions[0]!.item.id } });
    expect(missing.status).toBe('PENDING');
    expect(await prisma.notification.count({ where: { recipientId: managerId, type: 'ASSIGNMENT_MISSING', recordId: t2.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: receptionId, type: 'ASSIGNMENT_MISSING', recordId: t2.id } })).toBe(1);

    // Manager puts an Assistant on P03 → resolved on the next pass
    await prisma.roomAssignment.create({ data: { assistantId: (await makeUser('ASSISTANT')).id, roomId: rooms[2]!.id, date: dateOnly(day), assignedById: managerId } });
    await runProcedureDayRelease(addMinutes(at, 2));
    expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: missing.id } })).status).toBe('COMPLETED');

    // Session cancelled after release → task leaves the queues; rescheduled → the same row is released again
    await prisma.appointment.update({ where: { id: withDuty.sessions[0]!.appt.id }, data: { status: 'CANCELLED', treatmentPlanItemId: null } });
    await runProcedureDayRelease(addMinutes(at, 3));
    expect((await prisma.procedureTask.findUniqueOrThrow({ where: { id: t1.id } })).status).toBe('CANCELLED');
    const day2 = addDaysStr(day, 1);
    const s = withDuty.sessions[0]!;
    await prisma.appointment.create({ data: { patientId: s.appt.patientId, doctorId: s.appt.doctorId, type: 'PROCEDURE', startAt: atClinicMinute(day2, 15 * 60), endAt: atClinicMinute(day2, 16 * 60), status: 'CONFIRMED', source: 'DOCTOR_PLAN', treatmentPlanItemId: s.item.id, roomId: rooms[0]!.id, createdById: managerId } });
    await runProcedureDayRelease(atClinicMinute(day2, 8 * 60 + 5));
    const again = await prisma.procedureTask.findUniqueOrThrow({ where: { planItemId: s.item.id } });
    expect(again).toMatchObject({ id: t1.id, status: 'PENDING', assistantId: null });
  });

  it("today's released session shows to Reception / Manager / duty Assistant; Reception's assignment completes the same task", async () => {
    await setSetting('procedure.taskReleaseTime', '00:00');
    try {
      const now = new Date();
      await prisma.roomReservation.updateMany({ where: { status: { in: ['ACTIVE', 'AWAITING_CLEAN'] }, room: { kind: 'PROCEDURE' } }, data: { status: 'RELEASED', releasedAt: now } });
      const { sessions, patient: pt } = await plannedSessions([addMinutes(now, 5)], { roomId: rooms[1]!.id });
      const s = sessions[0]!;
      await prisma.roomAssignment.updateMany({ where: { roomId: rooms[1]!.id, date: dateOnly(clinicDateStr(now)), unassignedAt: null }, data: { unassignedAt: now } });
      const a = await agentFor('ASSISTANT');
      const aApi = call(a.agent);
      await prisma.roomAssignment.create({ data: { assistantId: a.user.id, roomId: rooms[1]!.id, date: dateOnly(clinicDateStr(now)), assignedById: managerId } });
      await runProcedureDayRelease(now);
      const released = await prisma.procedureTask.findUniqueOrThrow({ where: { planItemId: s.item.id } });

      const rec = await reception.get('/api/reception/procedures/planned-today');
      expect(rec.body.items.find((x: { id: string }) => x.id === released.id)).toMatchObject({ patient: { name: pt.name }, roomCode: rooms[1]!.code, dutyAssistantId: a.user.id, assignmentMissing: false });
      expect((await mgr.get('/api/manager/procedures/planned-today')).body.items.some((x: { id: string }) => x.id === released.id)).toBe(true);
      expect((await aApi.get('/api/assistant/procedures/planned')).body.items.map((x: { id: string }) => x.id)).toContain(released.id);
      const other = call((await agentFor('ASSISTANT')).agent);
      expect((await other.get('/api/assistant/procedures/planned')).body.items.map((x: { id: string }) => x.id)).not.toContain(released.id);
      expect((await reception.get('/api/reception/procedures/active')).body.items.some((x: { id: string }) => x.id === released.id)).toBe(false);
      expect((await aApi.get('/api/assistant/procedures')).body.items).toHaveLength(0); // not "busy" before assignment

      // Patient arrives → Reception assigns: the released row is completed, not duplicated
      await prisma.appointment.update({ where: { id: s.appt.id }, data: { status: 'CHECKED_IN', checkedInAt: now } });
      expect((await aApi.post('/api/attendance/check-in')).status).toBeLessThan(300);
      const pending = await reception.get('/api/reception/procedures/pending');
      expect(pending.body.items.some((x: { planItemId: string }) => x.planItemId === s.item.id)).toBe(true);
      const res = await reception.post('/api/reception/procedures/assign', { planItemId: s.item.id, assistantId: a.user.id, roomId: rooms[1]!.id }, newKey());
      expect(res.status).toBe(201);
      expect(res.body.task.id).toBe(released.id);
      expect(await prisma.procedureTask.count({ where: { planItemId: s.item.id } })).toBe(1);
      expect((await prisma.procedureTask.findUniqueOrThrow({ where: { id: released.id } })).assistantId).toBe(a.user.id);
      expect((await reception.get('/api/reception/procedures/planned-today')).body.items.some((x: { id: string }) => x.id === released.id)).toBe(false);
      expect((await aApi.get('/api/assistant/procedures')).body.items.map((x: { id: string }) => x.id)).toContain(released.id);
      expect((await call((await agentFor('OFFICE_BOY')).agent).get('/api/reception/procedures/planned-today')).status).toBe(403);
    } finally {
      await restoreSettings();
    }
  });
});

describe('§20 matrix — leave and MD demand notices carry the facts', () => {
  it('leave notices include date / time, reason and coverage; MD demand notice lists items, estimate and the Manager', async () => {
    const md = (await agentFor('MD')).user;
    const start = atClinicMinute(addDaysStr(clinicDateStr(new Date()), 5), 10 * 60);
    const leave = await mgr.post('/api/requests/leave', { kind: 'LEAVE', startAt: start, endAt: addMinutes(start, 8 * 60), reason: 'Family event (test)', coveragePlan: 'Senior receptionist covers' });
    expect(leave.status).toBe(201);
    const n = await prisma.notification.findFirstOrThrow({ where: { recipientId: md.id, recordId: leave.body.id } });
    expect(n.body).toContain('Family event (test)');
    expect(n.body).toContain('Coverage: Senior receptionist covers');
    expect(n.body).toMatch(/10:00 am/i);

    const ob = call((await agentFor('OFFICE_BOY')).agent);
    const item = await prisma.stockItem.create({ data: { name: `Matrix gel ${uid()}`, category: 'consumable', baseUnit: 'tube', minQty: 1 } });
    const c = await ob.post('/api/stock/demands', { lines: [{ itemId: item.id, quantity: 30 }], reason: 'Laser week' }, newKey());
    const d = await mgr.get(`/api/inventory/demands/${c.body.id}`);
    await mgr.put(`/api/inventory/demands/${c.body.id}/estimates`, { lines: [{ lineId: d.body.lines[0].id, estUnitCostPaisa: 100_000 }] });
    expect((await mgr.post(`/api/inventory/demands/${c.body.id}/decision`, { action: 'FORWARD', reason: 'Bulk' })).body.status).toBe('PENDING_MD');
    const mdNote = await prisma.notification.findFirstOrThrow({ where: { recipientId: md.id, type: 'STOCK_DEMAND_MD', recordId: c.body.id } });
    expect(mdNote.body).toContain(`${item.name} × 30 tube`);
    expect(mdNote.body).toContain('estimate Rs 30000');
    expect(mdNote.body).toContain('Laser week');
    expect(mdNote.body).toMatch(/Manager: /);
  });
});
