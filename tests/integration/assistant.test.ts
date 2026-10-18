import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { addMinutes, clinicDate } from '../../src/lib/time';
import { runCleanAlerts, runConsentAlerts } from '../../src/jobs/procedureSla';
import { runAutoSendToReception } from '../../src/modules/procedures/service';
import { agentFor, call, doctorWithHours, ensureRooms, lastAudit, loginAs, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

type Api = ReturnType<typeof call>;
let reception: Api;
let receptionId: string;
let manager: Api;
let managerId: string;
let rooms: { id: string; code: string }[];

beforeAll(async () => {
  await ensureRooms();
  const r = await agentFor('RECEPTIONIST');
  reception = call(r.agent);
  receptionId = r.user.id;
  const m = await agentFor('MANAGER');
  manager = call(m.agent);
  managerId = m.user.id;
  rooms = await prisma.room.findMany({ where: { kind: 'PROCEDURE' }, orderBy: { sortOrder: 'asc' }, select: { id: true, code: true } });
});

// Live procedure rooms left over by earlier tests / runs would block P01–P03.
beforeEach(async () => {
  const now = new Date();
  await prisma.roomReservation.updateMany({ where: { procedureTaskId: { not: null }, status: { in: ['ACTIVE', 'AWAITING_CLEAN'] } }, data: { status: 'RELEASED', releasedAt: now } });
  await prisma.roomReservation.updateMany({ where: { status: 'ACTIVE', room: { kind: 'PROCEDURE' }, endAt: { gt: now }, startAt: { lt: addMinutes(now, 240) } }, data: { status: 'CANCELLED' } });
});

/** An Assistant who has checked in today. */
async function onDutyAssistant() {
  const { user, agent } = await agentFor('ASSISTANT');
  const api = call(agent);
  expect((await api.post('/api/attendance/check-in')).status).toBeLessThan(300);
  return { user, api };
}

/** Today's visit at Reception with one same-day procedure on the Doctor's plan and an open invoice. */
async function sameDayAtReception(opts: { advance?: number } = {}) {
  const doctor = await doctorWithHours();
  const d = call(await loginAs(doctor.email!));
  const p = await prisma.patient.create({ data: { name: `Proc Patient ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: receptionId, whatsappConsent: false } });
  const now = new Date();
  const visit = await prisma.appointment.create({
    data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: now, endAt: addMinutes(now, 20), status: 'WAITING', source: 'RECEPTION', createdById: receptionId, checkedInAt: now },
  });
  expect((await d.post(`/api/doctor/appointments/${visit.id}/accept`)).status).toBe(200);
  const plan = await d.put(`/api/doctor/appointments/${visit.id}/plan`, {
    consultationReason: 'Laser hair reduction today',
    consultationFeePaisa: 0,
    consultationFeeWaived: true,
    items: [{ procedureName: 'Laser session', sameDay: true, pricePaisa: 500_000 }],
    advanceRequestedPaisa: opts.advance ?? 500_000,
  });
  expect(plan.status).toBe(200);
  expect((await d.post(`/api/doctor/appointments/${visit.id}/send-to-reception`)).status).toBe(200);
  const inv = await reception.post(`/api/reception/appointments/${visit.id}/invoice`);
  expect(inv.status).toBe(201);
  const planItemId = plan.body.version.items[0].id as string;
  return { doctor, patient: p, visit, invoiceId: inv.body.id as string, planItemId };
}

const pay = (invoiceId: string, amountPaisa: number) => reception.post(`/api/reception/invoices/${invoiceId}/payments`, { amountPaisa, method: 'CASH' }, newKey());

async function upload(taskId: string, route: 'consentForm' | 'beforePhoto' | 'afterPhoto' | 'itemsUsedEvidence' | 'roomCleanPhoto', uploaderId: string) {
  return prisma.attachment.create({ data: { fileKey: `dev_${uid()}`, route, fileName: `${route}.jpg`, mime: 'image/jpeg', size: 1000, isPrivate: true, uploadedById: uploaderId, recordType: 'ProcedureTask', recordId: taskId } });
}

async function stockItem(qty: number) {
  const item = await prisma.stockItem.create({ data: { name: `Gel ${uid()}`, category: 'consumable', baseUnit: 'ml', minQty: 5 } });
  const batch = await prisma.stockBatch.create({ data: { itemId: item.id, lotNo: 'L1', unitCostPaisa: 9_999n } });
  await prisma.stockTransaction.create({ data: { itemId: item.id, batchId: batch.id, type: 'PURCHASE', quantity: qty, actorId: managerId } });
  return item;
}

/** Assigns the same-day procedure and returns the task + the Assistant's API. */
async function assigned() {
  const s = await sameDayAtReception();
  expect((await pay(s.invoiceId, 500_000)).status).toBe(201);
  const a = await onDutyAssistant();
  const res = await reception.post('/api/reception/procedures/assign', { planItemId: s.planItemId, assistantId: a.user.id, roomId: rooms[0]!.id }, newKey());
  expect(res.status).toBe(201);
  return { ...s, assistant: a, taskId: res.body.task.id as string, roomId: rooms[0]!.id };
}

describe('§9 — Reception assigns a free Assistant + procedure room for same-day work', () => {
  it('needs the advance paid, a checked-in free Assistant and a free procedure room', async () => {
    const s = await sameDayAtReception();
    const a = await onDutyAssistant();
    const pending = await reception.get('/api/reception/procedures/pending');
    expect(pending.body.items.find((x: { planItemId: string }) => x.planItemId === s.planItemId)).toMatchObject({ kind: 'same_day', paymentOk: false });

    const body = { planItemId: s.planItemId, assistantId: a.user.id, roomId: rooms[0]!.id };
    const unpaid = await reception.post('/api/reception/procedures/assign', body, newKey());
    expect(unpaid.status).toBe(423);
    expect(unpaid.body.error.code).toBe('PAYMENT_REQUIRED');

    await pay(s.invoiceId, 500_000);
    const off = await makeUser('ASSISTANT');
    expect((await reception.post('/api/reception/procedures/assign', { ...body, assistantId: off.id }, newKey())).body.error.code).toBe('ASSISTANT_NOT_ON_DUTY');
    const consult = await prisma.room.findFirstOrThrow({ where: { kind: 'CONSULT' } });
    expect((await reception.post('/api/reception/procedures/assign', { ...body, roomId: consult.id }, newKey())).status).toBe(422);

    const opts = await reception.get(`/api/reception/procedures/options?planItemId=${s.planItemId}`);
    expect(opts.body.assistants.find((x: { id: string }) => x.id === a.user.id)).toMatchObject({ available: true });
    expect(opts.body.assistants.find((x: { id: string }) => x.id === off.id)).toMatchObject({ available: false });

    const key = newKey();
    const ok = await reception.post('/api/reception/procedures/assign', body, key);
    expect(ok.status).toBe(201);
    // same key replays, a second attempt is a no-op on the same task
    expect((await reception.post('/api/reception/procedures/assign', body, key)).body.task.id).toBe(ok.body.task.id);
    expect(await prisma.procedureTask.count({ where: { planItemId: s.planItemId } })).toBe(1);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: s.visit.id } })).status).toBe('PROCEDURE');
    expect(await prisma.notification.count({ where: { recipientId: a.user.id, type: 'PROCEDURE_ASSIGNED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: s.doctor.id, type: 'PROCEDURE_ASSIGNED' } })).toBe(1);
    expect((await reception.get('/api/reception/procedures/pending')).body.items.some((x: { planItemId: string }) => x.planItemId === s.planItemId)).toBe(false);

    // the room and the Assistant are now taken
    const s2 = await sameDayAtReception();
    await pay(s2.invoiceId, 500_000);
    const b = await onDutyAssistant();
    expect((await reception.post('/api/reception/procedures/assign', { planItemId: s2.planItemId, assistantId: b.user.id, roomId: rooms[0]!.id }, newKey())).body.error.code).toBe('ROOM_BUSY');
    expect((await reception.post('/api/reception/procedures/assign', { planItemId: s2.planItemId, assistantId: a.user.id, roomId: rooms[1]!.id }, newKey())).body.error.code).toBe('ASSISTANT_BUSY');
    expect((await reception.post('/api/reception/procedures/assign', { planItemId: s2.planItemId, assistantId: b.user.id, roomId: rooms[1]!.id }, newKey())).status).toBe(201);
  });
});

describe('§25 #15 — consent gate and 8-minute alert', () => {
  it('start is refused without consent; Manager is alerted once after 8 minutes', async () => {
    const t = await assigned();
    const api = t.assistant.api;
    // another Assistant cannot see or act on it
    const other = await onDutyAssistant();
    expect((await other.api.get(`/api/assistant/procedures/${t.taskId}`)).status).toBe(403);
    expect((await other.api.post(`/api/assistant/procedures/${t.taskId}/accept`)).status).toBe(403);

    expect((await api.post(`/api/assistant/procedures/${t.taskId}/accept`)).body.currentStep).toBe('CONSENT');
    const early = await api.post(`/api/assistant/procedures/${t.taskId}/start`);
    expect(early.status).toBe(423);
    expect(early.body.error.code).toBe('CONSENT_REQUIRED');

    const task = await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } });
    await runConsentAlerts(addMinutes(task.assignedAt!, 7));
    expect((await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } })).consentAlertAt).toBeNull();
    await runConsentAlerts(addMinutes(task.assignedAt!, 9));
    await runConsentAlerts(addMinutes(task.assignedAt!, 12));
    expect((await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } })).consentAlertAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { recordId: t.taskId, type: 'SLA_CONSENT', recipientId: managerId } })).toBe(1);

    // an upload for a different task does not count as consent
    const foreign = await upload(uid(), 'consentForm', t.assistant.user.id);
    expect((await api.post(`/api/assistant/procedures/${t.taskId}/consent`, { attachmentId: foreign.id })).status).toBe(422);
    const consent = await upload(t.taskId, 'consentForm', t.assistant.user.id);
    expect((await api.post(`/api/assistant/procedures/${t.taskId}/consent`, { attachmentId: consent.id })).body.currentStep).toBe('BEFORE_PHOTO');
    expect((await api.post(`/api/assistant/procedures/${t.taskId}/before-photo`, {})).status).toBe(422);
    expect((await api.post(`/api/assistant/procedures/${t.taskId}/before-photo`, { skipReason: 'Patient ne photo se inkar kiya' })).body.currentStep).toBe('START');
    expect((await api.post(`/api/assistant/procedures/${t.taskId}/start`)).body.currentStep).toBe('FINISH');
    expect((await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } })).beforePhotoSkipReason).toBe('Patient ne photo se inkar kiya');
  });
});

describe('§25 #16–17 + D-034 — items deducted once; Send to Reception; room blocked until clean; 7-minute clean alert', () => {
  it('runs the whole step sequence', async () => {
    const t = await assigned();
    const api = t.assistant.api;
    const uid1 = t.assistant.user.id;
    const step = (path: string, body?: object, key?: string) => api.post(`/api/assistant/procedures/${t.taskId}/${path}`, body, key);
    await step('accept');
    await step('consent', { attachmentId: (await upload(t.taskId, 'consentForm', uid1)).id });
    await step('before-photo', { attachmentId: (await upload(t.taskId, 'beforePhoto', uid1)).id });
    // finishing before starting is the wrong step
    expect((await step('finish')).body.error.code).toBe('WRONG_STEP');
    await step('start');
    expect((await step('finish')).body.currentStep).toBe('AFTER_PHOTO');
    expect((await prisma.roomReservation.findFirstOrThrow({ where: { procedureTaskId: t.taskId } })).status).toBe('AWAITING_CLEAN');
    await step('after-photo', { attachmentId: (await upload(t.taskId, 'afterPhoto', uid1)).id });

    // stock view for Assistants never shows cost
    const gel = await stockItem(20);
    const stock = await api.get('/api/assistant/stock-items');
    expect(JSON.stringify(stock.body)).not.toMatch(/"[^"]*cost[^"]*":|9999/i);
    expect(stock.body.items.find((i: { id: string }) => i.id === gel.id).usableQty).toBe(20);

    const evidence = await upload(t.taskId, 'itemsUsedEvidence', uid1);
    expect((await step('items', { lines: [{ itemId: gel.id, quantity: 25 }], evidenceAttachmentIds: [evidence.id] }, newKey())).status).toBe(422);
    expect((await step('items', { lines: [{ itemId: gel.id, quantity: 6 }], evidenceAttachmentIds: [] }, newKey())).status).toBe(422);
    const items = { lines: [{ itemId: gel.id, quantity: 6 }], evidenceAttachmentIds: [evidence.id] };
    const key = newKey();
    expect((await step('items', items, key)).body.currentStep).toBe('SEND_TO_RECEPTION');
    await step('items', items, key); // replay
    expect((await step('items', items, newKey())).body.error.code).toBe('WRONG_STEP'); // double submit
    const used = await prisma.stockTransaction.aggregate({ where: { itemId: gel.id, type: 'USAGE' }, _sum: { quantity: true } });
    expect(used._sum.quantity).toBe(-6);

    // clean is not possible before the patient is sent to Reception
    expect((await step('clean', { attachmentId: (await upload(t.taskId, 'roomCleanPhoto', uid1)).id })).body.error.code).toBe('WRONG_STEP');

    // invoice cannot close while the patient is still in the procedure stage (check unchanged)
    await prisma.attachment.create({ data: { fileKey: `dev_${uid()}`, route: 'prescriptionPhoto', fileName: 'rx.jpg', mime: 'image/jpeg', size: 1000, isPrivate: true, uploadedById: receptionId, recordType: 'Invoice', recordId: t.invoiceId } });
    const early = await reception.post(`/api/reception/invoices/${t.invoiceId}/close`);
    expect(early.status).toBe(423);
    expect(early.body.error.code).toBe('PROCEDURE_IN_PROGRESS');

    // "Send to Reception": patient back at Reception at once, Reception told (live), tracker updated, audited
    const since = new Date(Date.now() - 1000);
    const sent = await step('send-to-reception');
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ currentStep: 'ROOM_CLEAN', sentToReceptionAuto: false, status: 'IN_PROGRESS' });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: t.visit.id } })).status).toBe('RECEPTION');
    expect((await prisma.treatmentPlanItem.findUniqueOrThrow({ where: { id: t.planItemId } })).status).toBe('DONE');
    const note = await prisma.notification.findFirstOrThrow({ where: { recordId: t.visit.id, type: 'PATIENT_RETURNING', recipientId: receptionId } });
    expect(note.subject).toBe(`Patient ${t.patient.name} Reception aa raha hai — ${rooms[0]!.code}, ${t.assistant.user.displayName}`);
    const pushes = await prisma.realtimeEvent.findMany({ where: { createdAt: { gte: since }, event: { in: ['tracker:changed', 'notification:new'] } } });
    expect(pushes.some((e) => e.event === 'tracker:changed' && e.room === 'role:RECEPTIONIST' && (e.payload as { appointmentId?: string }).appointmentId === t.visit.id)).toBe(true);
    expect(pushes.some((e) => e.event === 'notification:new' && e.room === `user:${receptionId}`)).toBe(true);
    expect((await lastAudit('PATIENT_SENT_TO_RECEPTION', t.taskId))?.after).toMatchObject({ auto: false, mode: 'button' });
    expect((await step('send-to-reception')).body.error.code).toBe('WRONG_STEP');

    // room is still blocked until the clean photo, for everyone
    expect((await prisma.roomReservation.findFirstOrThrow({ where: { procedureTaskId: t.taskId } })).status).toBe('AWAITING_CLEAN');
    const s2 = await sameDayAtReception();
    await pay(s2.invoiceId, 500_000);
    const b = await onDutyAssistant();
    expect((await reception.post('/api/reception/procedures/assign', { planItemId: s2.planItemId, assistantId: b.user.id, roomId: t.roomId }, newKey())).body.error.code).toBe('ROOM_BUSY');
    // the Assistant is still busy (cleaning) and cannot take another procedure
    expect((await reception.post('/api/reception/procedures/assign', { planItemId: s2.planItemId, assistantId: t.assistant.user.id, roomId: rooms[1]!.id }, newKey())).body.error.code).toBe('ASSISTANT_BUSY');

    // 7-minute room-clean alert still applies after the patient has left
    const ended = (await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } })).endedAt!;
    await runCleanAlerts(addMinutes(ended, 6));
    expect((await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } })).cleanAlertAt).toBeNull();
    await runCleanAlerts(addMinutes(ended, 8));
    await runCleanAlerts(addMinutes(ended, 9));
    expect(await prisma.notification.count({ where: { recordId: t.taskId, type: 'SLA_ROOM_CLEAN', recipientId: managerId } })).toBe(1);

    // the patient does not wait for cleaning: Reception can close the invoice now
    expect((await reception.post(`/api/reception/invoices/${t.invoiceId}/close`)).status).toBe(200);

    expect((await step('clean', { attachmentId: (await upload(t.taskId, 'roomCleanPhoto', uid1)).id })).body.currentStep).toBe('DONE');
    const done = await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } });
    expect(done.status).toBe('COMPLETED');
    expect((await prisma.roomReservation.findFirstOrThrow({ where: { procedureTaskId: t.taskId } })).status).toBe('RELEASED');
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: t.visit.id } })).status).toBe('DONE');
    expect(await prisma.notification.count({ where: { recordId: t.visit.id, type: 'PATIENT_RETURNING', recipientId: receptionId } })).toBe(1);
    // room is free again
    expect((await reception.post('/api/reception/procedures/assign', { planItemId: s2.planItemId, assistantId: b.user.id, roomId: t.roomId }, newKey())).status).toBe(201);
    // closed task is read-only
    expect((await step('emergency', { reason: 'late' })).body.error.code).toBe('TASK_CLOSED');
  });
});

describe('§25 #17 — rooms 1–4 per Assistant; checklists; check-out blocked until closing', () => {
  it('enforces the room rules end to end', async () => {
    const a = await onDutyAssistant();
    const all = await prisma.room.findMany({ orderBy: { sortOrder: 'asc' } });
    // free today's assignments of these rooms from earlier tests
    await prisma.roomAssignment.updateMany({ where: { date: clinicDate(new Date()), unassignedAt: null, assistantId: { not: a.user.id } }, data: { unassignedAt: new Date() } });
    expect((await manager.post('/api/manager/room-assignments', { assistantId: a.user.id, roomIds: all.slice(0, 5).map((r) => r.id) })).status).toBe(422);
    const set = await manager.post('/api/manager/room-assignments', { assistantId: a.user.id, roomIds: [all[0]!.id, all[3]!.id] });
    expect(set.status).toBe(200);
    const other = await makeUser('ASSISTANT');
    expect((await manager.post('/api/manager/room-assignments', { assistantId: other.id, roomIds: [all[0]!.id] })).body.error.code).toBe('ROOM_ALREADY_ASSIGNED');
    // Assistants cannot assign rooms
    expect((await a.api.post('/api/manager/room-assignments', { assistantId: a.user.id, roomIds: [all[1]!.id] })).status).toBe(403);

    const mine = (await a.api.get('/api/assistant/rooms')).body.items as { id: string; room: { code: string } }[];
    expect(mine).toHaveLength(2);
    const checklist = { kind: 'OPENING', machineOk: true, roomNeat: true, disinfected: true, stockOk: true };
    expect((await a.api.post(`/api/assistant/rooms/${mine[0]!.id}/checklist`, checklist)).body.error.code).toBe('ROOM_NOT_ACCEPTED');
    for (const m of mine) await a.api.post(`/api/assistant/rooms/${m.id}/accept`);
    expect((await a.api.post(`/api/assistant/rooms/${mine[0]!.id}/checklist`, { ...checklist, kind: 'CLOSING' })).body.error.code).toBe('OPENING_MISSING');
    expect((await a.api.post(`/api/assistant/rooms/${mine[0]!.id}/checklist`, checklist)).status).toBe(201);
    expect((await a.api.post(`/api/assistant/rooms/${mine[0]!.id}/checklist`, checklist)).body.error.code).toBe('CHECKLIST_SUBMITTED');
    expect((await a.api.post(`/api/assistant/rooms/${mine[1]!.id}/checklist`, { ...checklist, machineOk: false })).status).toBe(422);
    expect((await a.api.post(`/api/assistant/rooms/${mine[1]!.id}/checklist`, { ...checklist, machineOk: false, machineIssue: 'Laser cooling fan noisy' })).status).toBe(201);
    expect(await prisma.notification.count({ where: { recipientId: managerId, type: 'ROOM_ISSUE' } })).toBeGreaterThanOrEqual(1);
    expect(await prisma.workflowTask.count({ where: { type: 'MANAGER_ROOM_VERIFICATION', roomId: { in: [all[0]!.id, all[3]!.id] }, createdAt: { gte: addMinutes(new Date(), -1) } } })).toBeGreaterThanOrEqual(2);
    // reports are immutable at the DB level
    const report = await prisma.roomChecklistReport.findFirstOrThrow({ where: { assignmentId: mine[0]!.id } });
    await expect(prisma.roomChecklistReport.update({ where: { id: report.id }, data: { roomNeat: false } })).rejects.toThrow();

    const blocked = await a.api.post('/api/attendance/check-out');
    expect(blocked.status).toBe(423);
    expect(blocked.body.error.code).toBe('ROOM_CLOSING_PENDING');
    expect(blocked.body.error.message).toContain('Pehle room closing complete karein');
    for (const m of mine) expect((await a.api.post(`/api/assistant/rooms/${m.id}/checklist`, { ...checklist, kind: 'CLOSING' })).status).toBe(201);
    expect((await a.api.post('/api/attendance/check-out')).status).toBe(200);
  });
});

describe('§25 #18 — emergency replacement inherits the task state; both actors audited', () => {
  it('a new Assistant resumes at the same step with consent kept', async () => {
    const t = await assigned();
    const api = t.assistant.api;
    await api.post(`/api/assistant/procedures/${t.taskId}/accept`);
    await api.post(`/api/assistant/procedures/${t.taskId}/consent`, { attachmentId: (await upload(t.taskId, 'consentForm', t.assistant.user.id)).id });
    expect((await api.post(`/api/assistant/procedures/${t.taskId}/emergency`, { reason: 'Family emergency' })).body.status).toBe('BLOCKED');
    expect(await prisma.notification.count({ where: { recordId: t.taskId, type: 'ASSISTANT_EMERGENCY', recipientId: managerId } })).toBe(1);

    // the blocked Assistant cannot check out with the task open
    expect((await api.post('/api/attendance/check-out')).body.error.code).toBe('PROCEDURE_OPEN');

    const b = await onDutyAssistant();
    expect((await reception.post(`/api/manager/procedures/${t.taskId}/replace`, { assistantId: b.user.id, reason: 'Emergency cover' })).status).toBe(403);
    const rep = await manager.post(`/api/manager/procedures/${t.taskId}/replace`, { assistantId: b.user.id, reason: 'Emergency cover' });
    expect(rep.status).toBe(200);
    expect(rep.body).toMatchObject({ assistantId: b.user.id, currentStep: 'BEFORE_PHOTO', status: 'IN_PROGRESS' });
    expect(rep.body.consentAttachmentId).toBeTruthy();
    const ev = await lastAudit('ASSISTANT_REPLACED', t.taskId);
    expect(ev?.actorId).toBe(managerId);
    expect(ev?.before).toMatchObject({ assistantId: t.assistant.user.id });
    expect(ev?.after).toMatchObject({ assistantId: b.user.id, resumedAtStep: 'BEFORE_PHOTO' });
    const history = await prisma.procedureTaskAssignment.findMany({ where: { procedureTaskId: t.taskId }, orderBy: { startedAt: 'asc' } });
    expect(history.map((h) => h.assistantId)).toEqual([t.assistant.user.id, b.user.id]);
    expect(history[0]!.endedAt).not.toBeNull();

    // old Assistant is locked out, new one continues
    expect((await api.post(`/api/assistant/procedures/${t.taskId}/before-photo`, { skipReason: 'x declined' })).status).toBe(403);
    expect((await b.api.post(`/api/assistant/procedures/${t.taskId}/before-photo`, { skipReason: 'Patient declined photo' })).body.currentStep).toBe('START');
    expect((await api.post('/api/attendance/check-out')).status).toBe(200);
  });
});

describe('D-034 — auto-send to Reception after the configured minutes', () => {
  it('sends the patient automatically, marks it auto-sent, and keeps the room blocked', async () => {
    const t = await assigned();
    const api = t.assistant.api;
    const uid1 = t.assistant.user.id;
    const step = (path: string, body?: object, key?: string) => api.post(`/api/assistant/procedures/${t.taskId}/${path}`, body, key);
    await step('accept');
    await step('consent', { attachmentId: (await upload(t.taskId, 'consentForm', uid1)).id });
    await step('before-photo', { skipReason: 'Patient declined photo' });
    await step('start');
    await step('finish');
    await step('after-photo', { skipReason: 'Patient declined photo' });
    expect((await step('items', { lines: [], evidenceAttachmentIds: [], noItems: true }, newKey())).body.currentStep).toBe('SEND_TO_RECEPTION');
    const detail = await api.get(`/api/assistant/procedures/${t.taskId}`);
    const itemsAt = (await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } })).itemsUsedAt!;
    expect(new Date(detail.body.autoSendAt).getTime()).toBe(addMinutes(itemsAt, 2).getTime());

    await runAutoSendToReception(addMinutes(itemsAt, 1));
    expect((await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } })).sentToReceptionAt).toBeNull();
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: t.visit.id } })).status).toBe('PROCEDURE');

    await runAutoSendToReception(addMinutes(itemsAt, 3));
    await runAutoSendToReception(addMinutes(itemsAt, 4)); // second tick does nothing
    const after = await prisma.procedureTask.findUniqueOrThrow({ where: { id: t.taskId } });
    expect(after).toMatchObject({ currentStep: 'ROOM_CLEAN', sentToReceptionAuto: true, status: 'IN_PROGRESS' });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: t.visit.id } })).status).toBe('RECEPTION');
    const ev = await lastAudit('PATIENT_SENT_TO_RECEPTION', t.taskId);
    expect(ev?.actorId).toBeNull();
    expect(ev?.after).toMatchObject({ auto: true, mode: 'auto-sent' });
    expect(await prisma.auditEvent.count({ where: { action: 'PATIENT_SENT_TO_RECEPTION', recordId: t.taskId } })).toBe(1);
    expect(await prisma.notification.count({ where: { recordId: t.visit.id, type: 'PATIENT_RETURNING', recipientId: receptionId } })).toBe(1);
    // the button is no longer available; the room waits for the clean photo
    expect((await step('send-to-reception')).body.error.code).toBe('WRONG_STEP');
    expect((await prisma.roomReservation.findFirstOrThrow({ where: { procedureTaskId: t.taskId } })).status).toBe('AWAITING_CLEAN');
    expect((await step('clean', { attachmentId: (await upload(t.taskId, 'roomCleanPhoto', uid1)).id })).body.currentStep).toBe('DONE');
    expect((await prisma.roomReservation.findFirstOrThrow({ where: { procedureTaskId: t.taskId } })).status).toBe('RELEASED');
  });
});
