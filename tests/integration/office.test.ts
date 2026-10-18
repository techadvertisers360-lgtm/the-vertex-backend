import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { addDaysStr, atClinicMinute, clinicDate, clinicDateStr, dateOnly, local } from '../../src/lib/time';
import { ensureDueRounds, runOfficeRounds } from '../../src/modules/office/service';
import { FINAL_SEQ } from '../../src/modules/office/schedule';
import { getSetting } from '../../src/services/settings';
import { agentFor, call, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

let managerId: string;
let areas: string[];
beforeAll(async () => {
  managerId = (await makeUser('MANAGER')).id;
  areas = await getSetting('officeBoy.areas');
});

async function officeBoy() {
  const { user, agent } = await agentFor('OFFICE_BOY');
  return { user, api: call(agent) };
}

const allClean = () => areas.map((name) => ({ name, clean: true }));

describe('§13 / §25 — Office Boy rounds: first check at check-in, 2-hour reminders, no duplicates', () => {
  it('creates rounds exactly once as they fall due, and none after check-out', async () => {
    const ob = await makeUser('OFFICE_BOY');
    // a fixed past clinic day so the timetable is deterministic
    const D = addDaysStr(clinicDateStr(new Date()), -30 - Math.floor(Math.random() * 300));
    const at = (h: number, m = 0) => atClinicMinute(D, h * 60 + m);
    const att = await prisma.attendance.create({ data: { userId: ob.id, date: dateOnly(D), checkInAt: at(10, 15) } });

    await ensureDueRounds(att, at(10, 16));
    await ensureDueRounds(att, at(12, 14));
    expect(await prisma.officeRound.findMany({ where: { attendanceId: att.id } })).toHaveLength(1);
    expect((await prisma.officeRound.findFirstOrThrow({ where: { attendanceId: att.id } })).kind).toBe('FIRST_CHECK');

    await ensureDueRounds(att, at(12, 16));
    await Promise.all([runOfficeRounds(at(12, 20)), ensureDueRounds(att, at(12, 20)), ensureDueRounds(att, at(12, 21))]); // overlapping ticks / refresh
    const rows = await prisma.officeRound.findMany({ where: { attendanceId: att.id }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([
      [1, 'FIRST_CHECK'],
      [2, 'ROUND'],
    ]);
    expect(await prisma.notification.count({ where: { recipientId: ob.id, type: 'OFFICE_ROUND_DUE' } })).toBe(2);

    await ensureDueRounds(att, at(21, 41));
    const all = await prisma.officeRound.findMany({ where: { attendanceId: att.id }, orderBy: { seq: 'asc' } });
    expect(all.map((r) => r.kind)).toEqual(['FIRST_CHECK', 'ROUND', 'ROUND', 'ROUND', 'ROUND', 'ROUND', 'FINAL']);
    expect(all.at(-1)!.seq).toBe(FINAL_SEQ);

    // after check-out nothing more is created
    const ob2 = await makeUser('OFFICE_BOY');
    const att2 = await prisma.attendance.create({ data: { userId: ob2.id, date: dateOnly(D), checkInAt: at(10), checkOutAt: at(11) } });
    expect(await ensureDueRounds(att2, at(21, 45))).toBe(0);
    expect(await prisma.officeRound.count({ where: { attendanceId: att2.id } })).toBe(0);
  });

  it('check-in starts the first clinic check; the dashboard has areas and no patient data', async () => {
    const { user, api } = await officeBoy();
    // a patient exists in the clinic today — nothing about them may reach the Office Boy
    const marker = `Hidden Patient ${uid()}`;
    await prisma.patient.create({ data: { name: marker, phone: normalizePhone(uniquePhone())!, createdById: managerId } });
    expect((await api.post('/api/attendance/check-in')).status).toBe(201);
    const t = await api.get('/api/office/today');
    expect(t.status).toBe(200);
    // After the 21:40 final-report time (clinic clock) the final report is due too; otherwise only the first check.
    const afterFinal = local(new Date()).hour * 60 + local(new Date()).minute >= 21 * 60 + 40;
    expect(t.body.rounds.map((r: { kind: string }) => r.kind)).toEqual(afterFinal ? ['FIRST_CHECK', 'FINAL'] : ['FIRST_CHECK']);
    expect(t.body.rounds[0]).toMatchObject({ kind: 'FIRST_CHECK', seq: 1, submittedAt: null });
    expect(t.body.areas).toEqual(areas);
    // refreshing does not duplicate
    await api.get('/api/office/today');
    expect(await prisma.officeRound.count({ where: { officeBoyId: user.id } })).toBe(afterFinal ? 2 : 1);
    expect(JSON.stringify(t.body)).not.toContain(marker);
    expect(await prisma.notification.count({ where: { recipientId: user.id, type: 'STAFF_CHECK_IN' } })).toBe(0);
    expect(await prisma.notification.count({ where: { recordType: 'Attendance', type: 'STAFF_CHECK_IN', recipientId: managerId, createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBeGreaterThan(0);
  });
});

describe('§13 — round reports: per-area result, issues to Manager, immutable', () => {
  it('validates, notifies on issues, and refuses a second submit or another Office Boy', async () => {
    const { user, api } = await officeBoy();
    await api.post('/api/attendance/check-in');
    const round = await prisma.officeRound.findFirstOrThrow({ where: { officeBoyId: user.id, kind: 'FIRST_CHECK' } });
    const url = `/api/office/rounds/${round.id}`;

    expect((await api.post(url, { areas: allClean().slice(1), stockOk: true })).status).toBe(422);
    const dirty = allClean().map((a, i) => (i === 0 ? { ...a, clean: false } : a));
    expect((await api.post(url, { areas: dirty, stockOk: true })).status).toBe(422);
    expect((await api.post(url, { areas: allClean(), stockOk: false })).status).toBe(422);

    const other = await officeBoy();
    expect((await other.api.post(url, { areas: allClean(), stockOk: true })).status).toBe(403);

    const photo = await prisma.attachment.create({ data: { fileKey: `dev_${uid()}`, route: 'roomChecklistPhoto', fileName: 'wet-floor.jpg', mime: 'image/jpeg', size: 900, isPrivate: true, uploadedById: user.id, recordType: 'OfficeRound', recordId: round.id } });
    const ok = await api.post(url, { areas: dirty.map((a, i) => (i === 0 ? { ...a, note: 'Floor geela, mop chahiye' } : a)), stockOk: false, stockNotes: 'Tissue khatam', attachmentIds: [photo.id] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'COMPLETED', cleanlinessOk: false, stockOk: false });
    const n = await prisma.notification.findFirstOrThrow({ where: { recordId: round.id, type: 'OFFICE_ROUND_ISSUE', recipientId: managerId } });
    expect(n.body).toContain('Floor geela');
    expect(n.body).toContain('Tissue khatam');
    expect((await api.post(url, { areas: allClean(), stockOk: true })).body.error.code).toBe('ROUND_SUBMITTED');
    // the round report cannot be deleted at the DB level
    await expect(prisma.officeRound.delete({ where: { id: round.id } })).rejects.toThrow();
  });

  it('a clean round does not alert the Manager', async () => {
    const { user, api } = await officeBoy();
    await api.post('/api/attendance/check-in');
    const round = await prisma.officeRound.findFirstOrThrow({ where: { officeBoyId: user.id } });
    expect((await api.post(`/api/office/rounds/${round.id}`, { areas: allClean(), stockOk: true })).status).toBe(200);
    expect(await prisma.notification.count({ where: { recordId: round.id, type: 'OFFICE_ROUND_ISSUE' } })).toBe(0);
  });
});

describe('§13 / §25 — 9:40 PM final report gates check-out', () => {
  it('check-out is blocked until the final report; final needs the demands review; early leave opens it early', async () => {
    const { user, api } = await officeBoy();
    await api.post('/api/attendance/check-in');
    const blocked = await api.post('/api/attendance/check-out');
    expect(blocked.status).toBe(423);
    expect(blocked.body.error.code).toBe('FINAL_REPORT_PENDING');
    expect(blocked.body.error.message).toContain('final report');

    // Manager-approved early leave today opens the final report now
    const now = new Date();
    await prisma.leaveRequest.create({ data: { requesterId: user.id, requesterRole: 'OFFICE_BOY', kind: 'EARLY_LEAVE', startAt: now, endAt: new Date(now.getTime() + 3600_000), reason: 'Family', approverRole: 'MANAGER', status: 'APPROVED', decidedById: managerId, decidedAt: now } });
    const t = await api.get('/api/office/today');
    const final = t.body.rounds.find((r: { kind: string }) => r.kind === 'FINAL');
    expect(final).toBeTruthy();

    const url = `/api/office/rounds/${final.id}`;
    expect((await api.post(url, { areas: allClean(), stockOk: true })).status).toBe(422); // demands review missing
    expect((await api.post(url, { areas: allClean(), stockOk: true, demandsReviewed: true })).status).toBe(200);
    expect((await api.post('/api/attendance/check-out')).status).toBe(200);
    // the unsubmitted first check is closed as missed, history kept
    const first = await prisma.officeRound.findFirstOrThrow({ where: { officeBoyId: user.id, kind: 'FIRST_CHECK' } });
    expect(first.status).toBe('CANCELLED');
    // nothing new after check-out
    const att = await prisma.attendance.findFirstOrThrow({ where: { userId: user.id, date: clinicDate(new Date()) } });
    expect(await ensureDueRounds(att, new Date(Date.now() + 6 * 3600_000))).toBe(0);
  });
});

describe('§12–13 — stock demands from Office Boy / Assistant; no costs', () => {
  it('creates a demand for the Manager queue and shows only names, units and status', async () => {
    const { user, api } = await officeBoy();
    const item = await prisma.stockItem.create({ data: { name: `Mop refill ${uid()}`, category: 'cleaning', baseUnit: 'piece', minQty: 2 } });
    const batch = await prisma.stockBatch.create({ data: { itemId: item.id, lotNo: 'L1', unitCostPaisa: 77_777n } });
    await prisma.stockTransaction.create({ data: { itemId: item.id, batchId: batch.id, type: 'PURCHASE', quantity: 3, unitCostPaisa: 77_777n, actorId: managerId } });

    const list = await api.get('/api/stock/items');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/"[^"]*cost[^"]*":|77777/i);
    expect(list.body.items.find((i: { id: string }) => i.id === item.id).usableQty).toBe(3);

    expect((await api.post('/api/stock/demands', { lines: [], reason: 'x' }, newKey())).status).toBe(422);
    const res = await api.post('/api/stock/demands', { lines: [{ itemId: item.id, quantity: 10 }], reason: 'Round mein refill kam mila' }, newKey());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_MANAGER');
    const d = await prisma.stockDemand.findUniqueOrThrow({ where: { id: res.body.id }, include: { lines: true } });
    expect(d).toMatchObject({ requestedById: user.id, requesterRole: 'OFFICE_BOY', demandNumber: null });
    expect(d.lines).toHaveLength(1);
    expect(await prisma.notification.count({ where: { recordId: d.id, type: 'STOCK_DEMAND', recipientId: managerId } })).toBe(1);

    const mine = await api.get('/api/stock/demands/mine');
    expect(mine.body.items[0]).toMatchObject({ id: d.id, status: 'PENDING_MANAGER' });
    expect(JSON.stringify(mine.body)).not.toMatch(/"[^"]*(cost|paisa|total)[^"]*":/i);

    const asst = await agentFor('ASSISTANT');
    expect((await call(asst.agent).post('/api/stock/demands', { lines: [{ itemId: item.id, quantity: 1 }], reason: 'Room P01 closing' }, newKey())).status).toBe(201);
    const rec = await agentFor('RECEPTIONIST');
    expect((await call(rec.agent).post('/api/stock/demands', { lines: [{ itemId: item.id, quantity: 1 }], reason: 'nope' }, newKey())).status).toBe(403);
  });
});

describe('§4 / §22 — Office Boy gets zero patient data', () => {
  it('is refused on every patient, clinical and procedure endpoint and file', async () => {
    const { api } = await officeBoy();
    for (const path of ['/api/reception/search?q=0300', '/api/reception/patients/x', '/api/reception/tracker', '/api/doctor/queue', '/api/assistant/procedures', '/api/reception/procedures/pending', '/api/reception/upcoming', '/api/lead/leads', '/api/manager/office-rounds']) {
      expect((await api.get(path)).status, path).toBe(403);
    }
    const rx = await prisma.attachment.create({ data: { fileKey: `dev_${uid()}`, route: 'prescriptionPhoto', fileName: 'rx.jpg', mime: 'image/jpeg', size: 900, isPrivate: true, uploadedById: managerId, recordType: 'Invoice', recordId: uid() } });
    expect((await api.get(`/api/files/${rx.id}/url`)).status).toBe(403);
  });
});
