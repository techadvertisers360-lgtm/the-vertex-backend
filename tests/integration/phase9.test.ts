import { beforeAll, describe, expect, it } from 'vitest';
import { addDaysStr, clinicDateStr } from '../../src/lib/time';
import { agentFor, call, makeLead, makeUser, prisma, TEST_PASSWORD, uid, loginAs } from './helpers';

type Api = ReturnType<typeof call>;
let hamza: Api;
let hamzaId: string;
let muaz: Api;
let mdApi: Api;
let mdId: string;
let mgr: Api;
let managerId: string;

beforeAll(async () => {
  const h = await agentFor('MARKETING_DIRECTOR');
  hamza = call(h.agent);
  hamzaId = h.user.id;
  muaz = call((await agentFor('MARKETING_LEAD')).agent);
  const m = await agentFor('MD');
  mdApi = call(m.agent);
  mdId = m.user.id;
  const g = await agentFor('MANAGER');
  mgr = call(g.agent);
  managerId = g.user.id;
});

const today = () => clinicDateStr(new Date());

describe('§2 / §16 — Lead Team members: only Hamza Zafar or Usama Sufain', () => {
  it('Hamza and the MD add / disable members; others cannot', async () => {
    const add = await hamza.post('/api/lead-admin/members', { displayName: `New Member ${uid()}`, phone: `0300${String(Date.now()).slice(-7)}`, password: TEST_PASSWORD });
    expect(add.status).toBe(201);
    expect(add.body.memberCode).toMatch(/^LM-\d{3,}$/);
    expect(add.body.role).toBe('LEAD_MEMBER');
    expect((await mdApi.post('/api/lead-admin/members', { displayName: `MD Member ${uid()}`, email: `${uid()}@test.local`, password: TEST_PASSWORD })).status).toBe(201);
    for (const api of [mgr, muaz]) expect((await api.post('/api/lead-admin/members', { displayName: 'X', email: `${uid()}@test.local`, password: TEST_PASSWORD })).status).toBe(403);
    // Hamza manages Lead members only
    expect((await hamza.post('/api/users', { displayName: 'Rec', role: 'RECEPTIONIST', email: `${uid()}@test.local`, password: TEST_PASSWORD })).status).toBe(403);
    const list = await hamza.get('/api/users');
    expect(list.body.items.every((u: { role: string }) => u.role === 'LEAD_MEMBER')).toBe(true);

    // disabling ends access
    const member = await loginAs(add.body.memberCode);
    expect((await call(member).get('/api/lead/sheets')).status).toBe(200);
    expect((await hamza.patch(`/api/lead-admin/members/${add.body.id}`, { active: false })).body.active).toBe(false);
    expect((await call(member).get('/api/lead/sheets')).status).toBe(401);
    // a member record can't be used to edit a non-member
    const doc = await makeUser('DOCTOR');
    expect((await hamza.patch(`/api/lead-admin/members/${doc.id}`, { active: false })).status).toBe(404);
  });
});

describe('§16 — Meta sheets: link, assign, reassign (one member at a time)', () => {
  it('assignment scopes the member; reassignment moves workable leads, bookings keep attribution', async () => {
    const a = await agentFor('LEAD_MEMBER');
    const b = await agentFor('LEAD_MEMBER');
    const ext = `META-${uid()}`;
    const s = await hamza.post('/api/lead-admin/sheets', { externalId: ext, title: 'Laser Oct', campaign: 'Laser Hair Oct' });
    expect(s.status).toBe(201);
    expect((await hamza.post('/api/lead-admin/sheets', { externalId: ext, title: 'dupe', campaign: 'x' })).status).toBe(409);
    expect((await muaz.post('/api/lead-admin/sheets', { externalId: `X-${uid()}`, title: 't', campaign: 'c' })).status).toBe(403);

    expect((await hamza.post(`/api/lead-admin/sheets/${s.body.id}/assign`, { memberId: a.user.id })).status).toBe(200);
    expect((await call(a.agent).get('/api/lead/sheets')).body.items.some((x: { id: string }) => x.id === s.body.id)).toBe(true);
    const open = await makeLead(s.body.id, a.user.id);
    const booked = await makeLead(s.body.id, a.user.id);
    await prisma.lead.update({ where: { id: booked.id }, data: { status: 'BOOKED' } });

    const re = await hamza.post(`/api/lead-admin/sheets/${s.body.id}/assign`, { memberId: b.user.id });
    expect(re.body.moved).toBe(1);
    expect((await call(a.agent).get(`/api/lead/sheets/${s.body.id}`)).status).toBe(403);
    expect((await call(b.agent).get('/api/lead/sheets')).body.items.some((x: { id: string }) => x.id === s.body.id)).toBe(true);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: open.id } })).assignedMemberId).toBe(b.user.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: booked.id } })).assignedMemberId).toBe(a.user.id);
    const sheet = (await hamza.get('/api/lead-admin/sheets')).body.items.find((x: { id: string }) => x.id === s.body.id);
    expect(sheet.member.id).toBe(b.user.id);
    expect(sheet.history).toHaveLength(2);
    expect(await prisma.notification.count({ where: { recipientId: b.user.id, type: 'SHEET_ASSIGNED' } })).toBe(1);
  });
});

describe('§16 — Hamza Zafar is never Dr Hamza Rasool: no clinical access', () => {
  it('refuses every clinical / patient endpoint', async () => {
    for (const path of ['/api/doctor/queue', '/api/reception/search?q=0300', '/api/reception/tracker', '/api/assistant/procedures', '/api/manager/audit', '/api/inventory/stock', '/api/cash/report?from=2026-01-01&to=2026-01-02']) {
      expect((await hamza.get(path)).status, path).toBe(403);
    }
    const hz = await prisma.user.findUniqueOrThrow({ where: { id: hamzaId } });
    expect(hz.role).toBe('MARKETING_DIRECTOR');
    expect(await prisma.doctorProfile.count({ where: { userId: hamzaId } })).toBe(0);
  });
});

describe('§17 — creatives & offers', () => {
  it('Muaz publishes; active for Lead / Reception / Manager; expired and withdrawn leave the active list but stay in history', async () => {
    const muazUser = await prisma.user.findFirstOrThrow({ where: { role: 'MARKETING_LEAD', active: true }, orderBy: { createdAt: 'desc' } });
    const pending = async (by: string) =>
      prisma.attachment.create({ data: { fileKey: `dev_${uid()}`, route: 'adCreative', fileName: 'poster.png', mime: 'image/png', size: 900, isPrivate: false, uploadedById: by, recordType: 'Pending', recordId: by } });
    const now = Date.now();
    const att = await pending(muazUser.id);
    const live = await muaz.post('/api/offers', { title: `Laser 30% ${uid()}`, serviceName: 'Laser Hair', validFrom: new Date(now - 3600_000).toISOString(), validTo: new Date(now + 7 * 86_400_000).toISOString(), attachmentId: att.id });
    expect(live.status).toBe(201);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).recordType).toBe('Offer');
    const lead = await agentFor('LEAD_MEMBER');
    const rec = await agentFor('RECEPTIONIST');
    for (const api of [call(lead.agent), call(rec.agent), mgr]) expect((await api.get('/api/offers/active')).body.items.some((o: { id: string }) => o.id === live.body.id)).toBe(true);
    expect((await call(lead.agent).post('/api/offers', { title: 'x', validFrom: new Date().toISOString(), validTo: new Date(now + 86_400_000).toISOString(), attachmentId: att.id })).status).toBe(403);

    const old = await prisma.offer.create({ data: { title: `Old ${uid()}`, validFrom: new Date(now - 10 * 86_400_000), validTo: new Date(now - 86_400_000), createdById: muazUser.id } });
    expect((await mgr.get('/api/offers/active')).body.items.some((o: { id: string }) => o.id === old.id)).toBe(false);
    expect((await muaz.get('/api/offers')).body.items.find((o: { id: string }) => o.id === old.id).state).toBe('EXPIRED');

    expect((await muaz.post(`/api/offers/${live.body.id}/withdraw`, { reason: 'Budget khatam' })).status).toBe(200);
    expect((await mgr.get('/api/offers/active')).body.items.some((o: { id: string }) => o.id === live.body.id)).toBe(false);
    expect((await hamza.get('/api/offers')).body.items.find((o: { id: string }) => o.id === live.body.id).state).toBe('WITHDRAWN');
  });

  it('Muaz annotates a performance view and it reaches Hamza', async () => {
    const n = await muaz.post('/api/lead-reports/notes', { from: addDaysStr(today(), -7), to: today(), note: 'LM bookings gir gayi, follow-ups late' });
    expect(n.status).toBe(201);
    expect(await prisma.notification.count({ where: { recordId: n.body.id, type: 'PERFORMANCE_NOTE', recipientId: hamzaId } })).toBe(1);
    expect((await hamza.get('/api/lead-reports/notes')).body.items.some((x: { id: string }) => x.id === n.body.id)).toBe(true);
  });
});

describe('§15 — MD dashboard highlights, approval center, history', () => {
  it('shows urgent items only; Manager leave approve / return with reason; history', async () => {
    const it1 = await prisma.stockItem.create({ data: { name: `MD item ${uid()}`, category: 'c', baseUnit: 'piece', minQty: 0 } });
    const demand = await prisma.stockDemand.create({ data: { requestedById: managerId, requesterRole: 'MANAGER', reason: 'Laser tips bulk', status: 'PENDING_MD', estimatedTotalPaisa: 3_500_000n, forwardedToMdAt: new Date(), lines: { create: [{ itemId: it1.id, quantity: 10, estUnitCostPaisa: 350_000n }] } } });
    const start = new Date(Date.now() + 2 * 86_400_000);
    const leave = await mgr.post('/api/requests/leave', { kind: 'EARLY_LEAVE', startAt: start.toISOString(), endAt: new Date(start.getTime() + 3 * 3600_000).toISOString(), reason: 'Bank kaam', coveragePlan: 'Reception senior' });
    expect(leave.status).toBe(201);

    const dash = await mdApi.get('/api/md/dashboard');
    expect(dash.status).toBe(200);
    const keys = dash.body.highlights.map((h: { key: string }) => h.key);
    expect(keys).toContain(`demand:${demand.id}`);
    expect(keys).toContain(`leave:${leave.body.id}`);
    expect(dash.body.cards.approvals.total).toBeGreaterThanOrEqual(2);

    expect((await mdApi.post(`/api/requests/leave/${leave.body.id}/decision`, { status: 'RETURNED_FOR_CORRECTION' })).status).toBe(422);
    expect((await mdApi.post(`/api/requests/leave/${leave.body.id}/decision`, { status: 'RETURNED_FOR_CORRECTION', reason: 'Coverage naam likhein' })).status).toBe(200);
    await mgr.put(`/api/requests/leave/${leave.body.id}`, { kind: 'EARLY_LEAVE', startAt: start.toISOString(), endAt: new Date(start.getTime() + 3 * 3600_000).toISOString(), reason: 'Bank kaam', coveragePlan: 'Fatima (Reception) cover karegi' });
    expect((await mdApi.post(`/api/requests/leave/${leave.body.id}/decision`, { status: 'APPROVED' })).status).toBe(200);
    expect(await prisma.notification.count({ where: { recipientId: managerId, recordId: leave.body.id } })).toBeGreaterThanOrEqual(2);

    expect((await mdApi.post(`/api/inventory/demands/${demand.id}/md-decision`, { action: 'APPROVE' })).status).toBe(200);
    const hist = await mdApi.get(`/api/md/history?recordType=StockDemand&recordId=${demand.id}`);
    expect(hist.body.items.map((h: { action: string }) => h.action)).toContain('DEMAND_APPROVED');
    expect((await mgr.get('/api/md/dashboard')).status).toBe(403);
  });

  it("MD's own leave needs no approval and only informs the Manager and Hamza", async () => {
    const start = new Date(Date.now() + 5 * 86_400_000);
    const r = await mdApi.post('/api/requests/leave', { kind: 'LEAVE', startAt: start.toISOString(), endAt: new Date(start.getTime() + 86_400_000).toISOString(), reason: 'Travel' });
    expect(r.body.status).toBe('APPROVED');
    expect(await prisma.notification.count({ where: { recordId: r.body.id, recipientId: hamzaId } })).toBe(1);
  });
});

describe('§15 / §16 — complaints: delegate to Manager, escalate to Hamza; no MD spam for routine completions', () => {
  it('routes complaints and keeps routine work out of MD notifications', async () => {
    const staff = await agentFor('ASSISTANT');
    const c = await call(staff.agent).post('/api/requests/complaints', { subject: `AC kharab ${uid()}`, detail: 'Procedure room garam', recipient: 'MD' });
    expect(c.status).toBe(201);
    expect((await mdApi.get('/api/requests/complaints?box=inbox')).body.items.some((x: { id: string }) => x.id === c.body.id)).toBe(true);
    expect((await mgr.post(`/api/requests/complaints/${c.body.id}/delegate`, { note: 'Manager khud dekh le' })).status).toBe(403);
    expect((await mdApi.post(`/api/requests/complaints/${c.body.id}/delegate`, { note: 'AC technician bulayein, kal tak' })).status).toBe(200);
    const after = await prisma.complaint.findUniqueOrThrow({ where: { id: c.body.id }, include: { recipients: true } });
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.recipients.map((r) => r.userId)).toContain(managerId);

    const op = await call(staff.agent).post('/api/requests/complaints', { subject: `Lead calls ${uid()}`, detail: 'Lead team wrong info de rahi', recipient: 'MANAGER' });
    expect((await mgr.post(`/api/requests/complaints/${op.body.id}/escalate`, { reason: 'Lead Team issue', to: 'HAMZA' })).status).toBe(200);
    expect((await prisma.complaint.findUniqueOrThrow({ where: { id: op.body.id }, include: { recipients: true } })).recipients.map((r) => r.userId)).toContain(hamzaId);
    expect((await hamza.get('/api/requests/complaints?box=inbox')).body.items.some((x: { id: string }) => x.id === op.body.id)).toBe(true);

    // routine completion: Manager verifies a clean room report → no MD notification, but it is in the MD report
    const before = await prisma.notification.count({ where: { recipientId: mdId } });
    const a = await agentFor('ASSISTANT');
    const room = await prisma.room.findFirstOrThrow({ where: { code: 'C03' } });
    const ra = await prisma.roomAssignment.create({ data: { assistantId: a.user.id, roomId: room.id, date: new Date(`${today()}T00:00:00Z`), assignedById: managerId, acceptedAt: new Date() } });
    const rep = await call(a.agent).post(`/api/assistant/rooms/${ra.id}/checklist`, { kind: 'OPENING', machineOk: true, roomNeat: true, disinfected: true, stockOk: true });
    expect((await mgr.post(`/api/manager/reports/RoomChecklistReport/${rep.body.id}/verify`, { status: 'VERIFIED' })).status).toBe(200);
    expect(await prisma.notification.count({ where: { recipientId: mdId } })).toBe(before);
    const done = await mdApi.get(`/api/md/reports/completed?from=${today()}&to=${today()}`);
    expect(done.body.summary.find((s: { action: string }) => s.action === 'REPORT_VERIFIED').count).toBeGreaterThan(0);
    const drill = await mdApi.get(`/api/md/reports/completed?from=${today()}&to=${today()}&action=REPORT_VERIFIED`);
    expect(drill.body.items.some((i: { recordId: string }) => i.recordId === rep.body.id)).toBe(true);
  });
});

describe('§15 — MD reports with drill-down', () => {
  it('staff, purchases, stock and cash are readable by the MD only', async () => {
    const r = await mdApi.get(`/api/md/reports/staff?from=${addDaysStr(today(), -7)}&to=${today()}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect((await mdApi.get(`/api/md/reports/purchases?from=${addDaysStr(today(), -30)}&to=${today()}`)).status).toBe(200);
    expect((await mdApi.get('/api/inventory/stock')).status).toBe(200);
    expect((await mdApi.get(`/api/cash/report?from=${today()}&to=${today()}`)).status).toBe(200);
    expect((await mdApi.post('/api/cash/closings', { date: '2001-01-01', countedCashPaisa: 0 })).status).toBe(403); // read-only
    for (const api of [mgr, hamza, muaz]) expect((await api.get(`/api/md/reports/staff?from=${today()}&to=${today()}`)).status).toBe(403);
  });
});

describe('D-021 / D-038 — Hamza and Muaz: own leave → MD; complaints via the normal picker', () => {
  it('routes leave to the MD and refuses Hamza as his own recipient', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    const body = { kind: 'LEAVE', startAt: start.toISOString(), endAt: new Date(start.getTime() + 86_400_000).toISOString(), reason: 'Family event' };
    const h = await hamza.post('/api/requests/leave', body);
    const m = await muaz.post('/api/requests/leave', body);
    expect(h.status).toBe(201);
    expect(m.status).toBe(201);
    for (const id of [h.body.id, m.body.id]) expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id } })).approverRole).toBe('MD');
    expect((await mdApi.get('/api/requests/leave?box=inbox')).body.items.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([h.body.id, m.body.id]));
    expect((await mgr.post(`/api/requests/leave/${h.body.id}/decision`, { status: 'APPROVED' })).status).toBe(403);

    expect((await hamza.post('/api/requests/complaints', { subject: 'Self', detail: 'test detail', recipient: 'HAMZA' })).status).toBe(422);
    const toMd = await hamza.post('/api/requests/complaints', { subject: `Budget ${uid()}`, detail: 'Ad budget late', recipient: 'MD' });
    expect(toMd.status).toBe(201);
    expect((await prisma.complaint.findUniqueOrThrow({ where: { id: toMd.body.id }, include: { recipients: true } })).recipients.map((r) => r.userId)).toContain(mdId);
    const toHamza = await muaz.post('/api/requests/complaints', { subject: `Creative ${uid()}`, detail: 'Approval late', recipient: 'HAMZA' });
    expect(toHamza.status).toBe(201);
    expect((await prisma.complaint.findUniqueOrThrow({ where: { id: toHamza.body.id }, include: { recipients: true } })).recipients.map((r) => r.userId)).toContain(hamzaId);
    expect((await muaz.get('/api/requests/complaints?box=mine')).body.items.some((x: { id: string }) => x.id === toHamza.body.id)).toBe(true);
  });
});
