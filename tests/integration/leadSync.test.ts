import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimSheet, runSheetSync, runSync } from '../../src/modules/leadSync/service';
import { SheetsApiError, setSheetsApi, startRowOf, type SheetsApi } from '../../src/services/googleSheets';
import { DEV_NOTIFIED_MSG } from '../../src/services/devIssues';
import { agentFor, call, makeLead, prisma, uid, uniquePhone } from './helpers';

/**
 * Phase 9b — Google Sheets lead sync with a mocked Sheets API (D-039).
 * The fake understands the two ranges the sync reads: `'Tab'!1:1` and `'Tab'!A<n>:ZZZ`.
 */
class FakeSheets implements SheetsApi {
  books = new Map<string, { title: string; tabs: Record<string, string[][]> }>();
  fail: SheetsApiError | null = null;
  calls = 0;

  async spreadsheet(id: string) {
    this.calls++;
    if (this.fail) throw this.fail;
    const b = this.books.get(id);
    if (!b) throw new SheetsApiError('NOT_FOUND', 'Google Sheet nahi mili — Sheet ID / link check karein.');
    return { title: b.title, tabs: Object.keys(b.tabs) };
  }

  async values(id: string, range: string) {
    this.calls++;
    if (this.fail) throw this.fail;
    const b = this.books.get(id);
    if (!b) throw new SheetsApiError('NOT_FOUND', 'Google Sheet nahi mili — Sheet ID / link check karein.');
    const m = range.match(/^'(.*)'!(.*)$/)!;
    const tab = m[1]!.replace(/''/g, "'");
    const rows = b.tabs[tab];
    if (!rows) throw new SheetsApiError('BAD_RANGE', 'Tab ka naam sheet mein nahi mila — tab name check karein.');
    if (m[2] === '1:1') return { range: `'${tab}'!A1:Z1`, values: rows.slice(0, 1) };
    const start = startRowOf(range)!;
    let values = rows.slice(start - 1);
    while (values.length && values[values.length - 1]!.every((c) => !c)) values = values.slice(0, -1); // Google trims trailing empty rows
    return { range: `'${tab}'!A${start}:Z${start + Math.max(values.length, 1) - 1}`, values };
  }
}

const fake = new FakeSheets();
const HEADER = ['id', 'created_time', 'full_name', 'phone_number', 'treatment'];
const MAP = { id: 'id', name: 'full_name', phone: 'phone_number', extra: ['treatment'] };
const sheetKey = () => `1${uid('gs').padEnd(30, 'x')}`;
const metaRow = (id: string, name: string, phone: string, treatment = 'Laser') => [id, '2026-10-18T10:00:00+0500', name, `p:${phone.replace(/^0/, '+92')}`, treatment];

type Api = ReturnType<typeof call>;
let hamza: Api;
let hamzaId: string;
let muazId: string;
let muaz: Api;
let mgr: Api;
let devId: string;
const devIssues = (where: Record<string, unknown> = {}) => prisma.auditEvent.findMany({ where: { action: 'DEV_ISSUE', ...where }, orderBy: { id: 'asc' } });
const devNotes = (recordId?: string) => prisma.notification.findMany({ where: { recipientId: devId, type: 'DEV_ISSUE', ...(recordId ? { recordId } : {}) } });

beforeAll(async () => {
  devId = (await agentFor('DEVELOPER')).user.id;
  setSheetsApi(fake);
  const h = await agentFor('MARKETING_DIRECTOR');
  hamza = call(h.agent);
  hamzaId = h.user.id;
  const m = await agentFor('MARKETING_LEAD');
  muaz = call(m.agent);
  muazId = m.user.id;
  mgr = call((await agentFor('MANAGER')).agent);
});
afterAll(() => setSheetsApi(null));

/** Link a Google tab through the admin API and assign it to a fresh member. */
async function linkedSheet(rows: string[][], map: Record<string, unknown> = MAP) {
  const gid = sheetKey();
  fake.books.set(gid, { title: `Meta Leads ${gid.slice(0, 6)}`, tabs: { 'Form Responses': rows } });
  const member = await agentFor('LEAD_MEMBER');
  const s = await hamza.post('/api/lead-admin/sheets', {
    externalId: `META-${uid()}`,
    title: 'Laser Oct',
    campaign: `Laser ${uid()}`,
    googleSheetId: `https://docs.google.com/spreadsheets/d/${gid}/edit#gid=0`,
    tabName: 'Form Responses',
    columnMap: map,
  });
  expect(s.status).toBe(201);
  expect(s.body.googleSheetId).toBe(gid);
  expect((await hamza.post(`/api/lead-admin/sheets/${s.body.id}/assign`, { memberId: member.user.id })).status).toBe(200);
  return { sheetId: s.body.id as string, gid, member, rows };
}

describe('D-039 — admin: link a Google Sheet, test connection, credentials never exposed', () => {
  it('Check needs only the link: finds the leads tab and columns, row count and a masked sample', async () => {
    const gid = sheetKey();
    const phone = uniquePhone();
    fake.books.set(gid, { title: 'Meta Leads Oct', tabs: { Notes: [['hello']], Leads: [HEADER, metaRow('l:1', 'Sana', phone), metaRow('l:2', 'Bad', '12')] } });
    const ok = await hamza.post('/api/lead-admin/sheets/test-connection', { googleSheetId: `https://docs.google.com/spreadsheets/d/${gid}/edit` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      ok: true,
      title: 'Meta Leads Oct',
      tabName: 'Leads',
      headers: HEADER,
      dataRows: 1,
      invalidRows: 1,
      idColumn: true,
      columnMap: { id: 'id', name: 'full_name', phone: 'phone_number', extra: ['created_time', 'treatment'], auto: true },
    });
    expect(ok.body.sample[0].phone).not.toContain(phone.slice(-7));

    for (const api of [mgr, muaz]) expect((await api.post('/api/lead-admin/sheets/test-connection', { googleSheetId: gid })).status).toBe(403);
    const cfg = await hamza.get('/api/lead-admin/sync-config');
    expect(cfg.status).toBe(200);
    expect(cfg.body).not.toHaveProperty('alertAfter');
    expect(JSON.stringify(cfg.body)).not.toMatch(/private_key|BEGIN PRIVATE/);
  });

  it('a sheet that cannot be read: staff see a neutral line, the developer gets who / what / why', async () => {
    const gid = sheetKey();
    fake.books.set(gid, { title: 'No Phone Sheet', tabs: { Sheet1: [['full_name', 'notes'], ['Ali', 'x']] } });
    const before = (await devIssues()).length;
    const r = await hamza.post('/api/lead-admin/sheets/test-connection', { googleSheetId: gid });
    expect(r.body).toEqual({ ok: false, error: DEV_NOTIFIED_MSG });
    expect(JSON.stringify(r.body)).not.toMatch(/phone|full_name|Sheet1/);
    const link = await hamza.post('/api/lead-admin/sheets', { googleSheetId: gid });
    expect(link.status).toBe(422);
    expect(link.body.error).toMatchObject({ code: 'SHEET_LINK_FAILED', message: DEV_NOTIFIED_MSG });

    const issues = (await devIssues()).slice(before);
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.actorId === hamzaId)).toBe(true);
    const after = issues[1]!.after as { area: string; tried: string; reason: string };
    expect(after.area).toBe('Lead sheet');
    expect(after.tried).toContain('Sheet link karna');
    expect(after.reason).toContain('phone ka column nahi mila');
    const note = (await devNotes()).find((n) => n.body?.includes('phone ka column nahi mila'));
    expect(note?.subject).toContain('Marketing Director');
    expect(await prisma.notification.count({ where: { recipientId: hamzaId, type: 'DEV_ISSUE' } })).toBe(0);

    const dev = call((await agentFor('DEVELOPER')).agent);
    const list = await dev.get('/api/developer/issues');
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ area: 'Lead sheet', who: { id: hamzaId, role: 'MARKETING_DIRECTOR' } });
    expect((await hamza.get('/api/developer/issues')).status).toBe(403);
  });

  it('links from the link alone: title, campaign and form id come from the sheet; new columns are picked up later', async () => {
    const gid = sheetKey();
    const header = ['id', 'created_time', 'campaign_name', 'form_id', 'full_name', 'phone_number', 'city'];
    const rows = [header, ['l:9001', '2026-10-19', 'Laser Nov', `F-${gid.slice(0, 8)}`, 'Mehwish', `p:+92${uniquePhone().slice(1)}`, 'Lahore']];
    fake.books.set(gid, { title: 'Laser Nov Leads', tabs: { 'Form 1': rows } });
    const s = await hamza.post('/api/lead-admin/sheets', { googleSheetId: `https://docs.google.com/spreadsheets/d/${gid}/edit#gid=0` });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ title: 'Laser Nov Leads', campaign: 'Laser Nov', externalId: `F-${gid.slice(0, 8)}`, tabName: 'Form 1', googleSheetId: gid });
    const member = await agentFor('LEAD_MEMBER');
    await hamza.post(`/api/lead-admin/sheets/${s.body.id}/assign`, { memberId: member.user.id });
    expect((await hamza.post(`/api/lead-admin/sheets/${s.body.id}/sync`, {})).body.imported).toBe(1);
    const first = await prisma.lead.findFirstOrThrow({ where: { sheetId: s.body.id } });
    expect(first.remarks).toBe('Sheet: created_time: 2026-10-19 · campaign_name: Laser Nov · city: Lahore');

    // Meta adds a question column: the next sync re-reads the header, nothing is lost
    header.push('which_treatment?');
    rows[1]!.push('Laser');
    rows.push(['l:9002', '2026-10-19', 'Laser Nov', 'F', 'Rabia', `p:+92${uniquePhone().slice(1)}`, 'Karachi', 'Botox']);
    expect((await hamza.post(`/api/lead-admin/sheets/${s.body.id}/sync`, {})).body.imported).toBe(1);
    const second = await prisma.lead.findFirstOrThrow({ where: { sheetId: s.body.id, name: 'Rabia' } });
    expect(second.remarks).toContain('which_treatment?: Botox');
    expect(((await prisma.metaSheet.findUniqueOrThrow({ where: { id: s.body.id } })).columnMap as { extra: string[] }).extra).toContain('which_treatment?');

    // a second sheet from the same form gets its own id
    const gid2 = sheetKey();
    fake.books.set(gid2, { title: 'Copy', tabs: { 'Form 1': rows.map((r) => [...r]) } });
    const s2 = await hamza.post('/api/lead-admin/sheets', { googleSheetId: gid2 });
    expect(s2.body.externalId).toBe(`F-${gid.slice(0, 8)}-2`);
  });

  it('the same Google tab cannot be linked twice; a bad link is rejected', async () => {
    const { gid } = await linkedSheet([HEADER]);
    const dupe = await hamza.post('/api/lead-admin/sheets', { externalId: `META-${uid()}`, title: 'Dupe tab', campaign: 'y', googleSheetId: gid, tabName: 'Form Responses', columnMap: MAP });
    expect(dupe.status).toBe(409);
    const bad = await hamza.post('/api/lead-admin/sheets', { externalId: `META-${uid()}`, title: 'Bad link', campaign: 'y', googleSheetId: 'hello', tabName: 'T', columnMap: MAP });
    expect(bad.status).toBe(422);
  });
});

describe('D-039 — import: only new rows, duplicates flagged, app-side status / remarks never overwritten', () => {
  it('Sync now imports valid rows for the member, logs the run and notifies the member live', async () => {
    const existingPhone = uniquePhone();
    const rows = [HEADER, metaRow('l:101', 'Ayesha', uniquePhone()), metaRow('l:102', 'Bilal', existingPhone, 'Botox'), ['', '', '', '', ''], metaRow('l:103', 'Wrong Phone', '12'), metaRow('l:104', 'Hira', uniquePhone())];
    const { sheetId, member } = await linkedSheet(rows);
    const other = await agentFor('LEAD_MEMBER');
    const otherSheet = await prisma.metaSheet.create({ data: { externalId: `X-${uid()}`, title: 'Other', campaign: 'Other', createdById: hamzaId } });
    const earlier = await makeLead(otherSheet.id, other.user.id, existingPhone, 'Earlier Bilal');

    const r = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'SUCCESS', imported: 3, skipped: 1, duplicatePhones: 1, error: null });

    const leads = await prisma.lead.findMany({ where: { sheetId }, orderBy: { sheetRowNumber: 'asc' } });
    expect(leads.map((l) => [l.name, l.externalRowId, l.sheetRowNumber, l.assignedMemberId])).toEqual([
      ['Ayesha', 'id:l:101', 2, member.user.id],
      ['Bilal', 'id:l:102', 3, member.user.id],
      ['Hira', 'id:l:104', 6, member.user.id],
    ]);
    expect(leads[1]!.duplicateOfId).toBe(earlier.id);
    expect(leads[1]!.remarks).toBe('Sheet: treatment: Botox');
    expect(leads.every((l) => l.status === 'NEW')).toBe(true);

    const run = await prisma.sheetSyncRun.findFirst({ where: { sheetId }, orderBy: { startedAt: 'desc' } });
    expect(run).toMatchObject({ status: 'SUCCESS', trigger: 'MANUAL', imported: 3, skipped: 1, actorId: hamzaId });
    expect(run!.details).toEqual([{ row: 5, reason: 'Phone ghalat: 12' }]);
    const note = await prisma.notification.findFirst({ where: { recipientId: member.user.id, type: 'NEW_LEADS', recordId: sheetId } });
    expect(note?.subject).toMatch(/^3 naya leads/);
    expect(await prisma.realtimeEvent.count({ where: { room: `user:${member.user.id}`, event: 'notification:new' } })).toBeGreaterThan(0);
    expect(await prisma.auditEvent.count({ where: { action: 'SHEET_SYNC', recordId: sheetId } })).toBe(1);

    // the member sees them; the sheet card shows last sync and no Google details leak to the member
    const mine = await call(member.agent).get('/api/lead/sheets');
    expect(JSON.stringify(mine.body)).not.toMatch(/googleSheetId|columnMap|Form Responses/);
    const card = (await hamza.get('/api/lead-admin/sheets')).body.items.find((s: { id: string }) => s.id === sheetId);
    expect(card).toMatchObject({ lastSyncStatus: 'SUCCESS', consecutiveFailures: 0, syncing: false });
    expect(card).not.toHaveProperty('lastSyncError');
    expect(card.lastSyncAt).toBeTruthy();
    expect(card).not.toHaveProperty('syncLeaseOwner');
    const log = await hamza.get(`/api/lead-admin/sheets/${sheetId}/sync-runs`);
    expect(log.body.items[0]).toMatchObject({ status: 'SUCCESS', imported: 3, actor: expect.any(String) });
    expect(log.body.items[0]).not.toHaveProperty('details');
    // the skipped row is reported to the developer
    const skip = await devIssues({ recordId: sheetId });
    expect((skip[0]!.after as { reason: string }).reason).toContain('Row 5: Phone ghalat: 12');
  });

  it('a later sync adds only new rows and never touches leads already worked in the app', async () => {
    const rows = [HEADER, metaRow('l:201', 'Zara', uniquePhone())];
    const { sheetId, member } = await linkedSheet(rows);
    await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    const zara = await prisma.lead.findFirstOrThrow({ where: { sheetId } });
    const log = await call(member.agent).post(`/api/lead/leads/${zara.id}/activities`, { channel: 'CALL', result: 'CONNECTED', status: 'NOT_INTERESTED', remarks: 'Price zyada (app remark)' });
    expect(log.status).toBeLessThan(300);
    const worked = await prisma.lead.findUniqueOrThrow({ where: { id: zara.id } });

    rows[1]![2] = 'Zara EDITED IN SHEET'; // sheet edits never flow back
    rows.push(metaRow('l:202', 'Nida', uniquePhone()));
    const r = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    expect(r.body).toMatchObject({ imported: 1, alreadyImported: 0 });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: zara.id } });
    expect([after.name, after.status, after.remarks, after.updatedAt.getTime()]).toEqual([worked.name, worked.status, worked.remarks, worked.updatedAt.getTime()]);
    expect(await prisma.lead.count({ where: { sheetId } })).toBe(2);

    // nothing new → nothing imported, no notification
    const again = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    expect(again.body.imported).toBe(0);
    expect(await prisma.notification.count({ where: { recipientId: member.user.id, type: 'NEW_LEADS', recordId: sheetId } })).toBe(2);
  });

  it('rows deleted above the cursor do not hide new rows (id-keyed overlap)', async () => {
    const rows = [HEADER, metaRow('l:301', 'A', uniquePhone()), metaRow('l:302', 'B', uniquePhone()), metaRow('l:303', 'C', uniquePhone())];
    const { sheetId } = await linkedSheet(rows);
    await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    rows.splice(1, 2); // someone deletes two rows; a new lead lands at row 3
    rows.push(metaRow('l:304', 'D', uniquePhone()));
    const r = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    expect(r.body.imported).toBe(1);
    expect((await prisma.lead.findMany({ where: { sheetId } })).map((l) => l.name).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('without an id column rows are keyed by row number and the cursor moves forward', async () => {
    const rows = [['Name', 'Phone'], ['Row Two', uniquePhone()]];
    const { sheetId } = await linkedSheet(rows, { name: 'name', phone: 'phone' });
    await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    rows.push(['Row Three', uniquePhone()]);
    expect((await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {})).body.imported).toBe(1);
    expect((await prisma.lead.findMany({ where: { sheetId }, orderBy: { sheetRowNumber: 'asc' } })).map((l) => l.externalRowId)).toEqual(['row:2', 'row:3']);
    expect((await prisma.metaSheet.findUniqueOrThrow({ where: { id: sheetId } })).syncCursorRow).toBe(3);
  });

  it('the lead id column cannot change after leads were imported', async () => {
    const { sheetId, gid } = await linkedSheet([HEADER, metaRow('l:401', 'Q', uniquePhone())]);
    await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    const r = await hamza.patch(`/api/lead-admin/sheets/${sheetId}`, { googleSheetId: gid, tabName: 'Form Responses', columnMap: { name: 'full_name', phone: 'phone_number' } });
    expect(r.status).toBe(422);
  });
});

describe('D-039 — no duplicates with two workers', () => {
  it('only one claimant gets the lease; Sync now while busy is refused', async () => {
    const { sheetId } = await linkedSheet([HEADER, metaRow('l:501', 'Lease', uniquePhone())]);
    const now = new Date();
    const claims = await Promise.all([claimSheet(sheetId, 'w-a', now, null), claimSheet(sheetId, 'w-b', now, null), claimSheet(sheetId, 'w-c', now, null)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const busy = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('SYNC_BUSY');
    await prisma.metaSheet.update({ where: { id: sheetId }, data: { syncLeaseUntil: null, syncLeaseOwner: null } });
  });

  it('even two runs at the same moment (lease bypassed) create each lead once', async () => {
    const rows = [HEADER, ...Array.from({ length: 25 }, (_, i) => metaRow(`l:6${i}`, `Race ${i}`, uniquePhone()))];
    const { sheetId } = await linkedSheet(rows);
    const results = await Promise.all([runSync(sheetId, { trigger: 'SCHEDULED', owner: 'w-1' }), runSync(sheetId, { trigger: 'SCHEDULED', owner: 'w-2' })]);
    expect(results.every((r) => r.status === 'SUCCESS')).toBe(true);
    expect(await prisma.lead.count({ where: { sheetId } })).toBe(25);
    const keys = (await prisma.lead.findMany({ where: { sheetId }, select: { externalRowId: true } })).map((l) => l.externalRowId);
    expect(new Set(keys).size).toBe(25);
  });

  it('the scheduled watcher syncs a due sheet once per interval', async () => {
    const rows = [HEADER, metaRow('l:701', 'Sched', uniquePhone())];
    const { sheetId } = await linkedSheet(rows);
    const t0 = new Date(Date.now() + 1000);
    await runSheetSync(t0, 'w-sched');
    expect(await prisma.lead.count({ where: { sheetId } })).toBe(1);
    rows.push(metaRow('l:702', 'Sched 2', uniquePhone()));
    await runSheetSync(new Date(t0.getTime() + 60_000), 'w-sched'); // 1 min later: not due (interval 3)
    expect(await prisma.lead.count({ where: { sheetId } })).toBe(1);
    await runSheetSync(new Date(t0.getTime() + 3 * 60_000 + 1000), 'w-sched');
    expect(await prisma.lead.count({ where: { sheetId } })).toBe(2);
    const runs = await prisma.sheetSyncRun.findMany({ where: { sheetId } });
    expect(runs.map((r) => r.trigger)).toEqual(['SCHEDULED', 'SCHEDULED']);
  });
});

describe('D-045 — failures go to the developer only; staff never see the reason', () => {
  it('Sync now failures: neutral message for Hamza, who / what / why for the developer; streak resets on success', async () => {
    const { sheetId } = await linkedSheet([HEADER, metaRow('l:801', 'Fail', uniquePhone())]);
    fake.fail = new SheetsApiError('FORBIDDEN', 'Sheet service account ke saath share nahi (test).');
    try {
      for (let i = 1; i <= 4; i++) {
        const r = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
        expect(r.body).toMatchObject({ status: 'FAILED', error: DEV_NOTIFIED_MSG });
      }
      const issues = await devIssues({ recordId: sheetId });
      expect(issues).toHaveLength(4); // every Sync now that fails — someone is waiting on it
      expect((issues[0]!.after as { reason: string }).reason).toBe('Sheet service account ke saath share nahi (test).');
      expect((issues[3]!.after as { reason: string }).reason).toContain('4 dafa lagatar fail');
      expect(issues[0]!.actorId).toBe(hamzaId);
      expect(await devNotes(sheetId)).toHaveLength(4);
      for (const id of [hamzaId, muazId]) expect(await prisma.notification.count({ where: { recipientId: id, type: { in: ['SHEET_SYNC_FAILING', 'DEV_ISSUE'] }, recordId: sheetId } })).toBe(0);

      const card = (await hamza.get('/api/lead-admin/sheets')).body.items.find((s: { id: string }) => s.id === sheetId);
      expect(card).toMatchObject({ lastSyncStatus: 'FAILED', consecutiveFailures: 4 });
      const staffViews = JSON.stringify([card, (await hamza.get(`/api/lead-admin/sheets/${sheetId}/sync-runs`)).body, (await muaz.get('/api/lead-reports/sync-status')).body]);
      expect(staffViews).not.toContain('share nahi');
      expect(await prisma.lead.count({ where: { sheetId } })).toBe(0);
    } finally {
      fake.fail = null;
    }
    const ok = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    expect(ok.body).toMatchObject({ status: 'SUCCESS', imported: 1 });
    expect((await prisma.metaSheet.findUniqueOrThrow({ where: { id: sheetId } })).consecutiveFailures).toBe(0);
    const runs = await prisma.sheetSyncRun.findMany({ where: { sheetId }, orderBy: { startedAt: 'asc' } });
    expect(runs.map((r) => r.status)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED', 'SUCCESS']);
    await expect(prisma.sheetSyncRun.update({ where: { id: runs[0]!.id }, data: { error: 'x' } })).rejects.toThrow();
  });

  it('automatic sync: the developer is told at the first failure and reminded at 3 in a row, not every 3 minutes', async () => {
    const { sheetId } = await linkedSheet([HEADER, metaRow('l:851', 'Auto Fail', uniquePhone())]);
    fake.fail = new SheetsApiError('NETWORK', 'Google se connection nahi hua (test).');
    try {
      for (let i = 0; i < 5; i++) {
        await prisma.metaSheet.update({ where: { id: sheetId }, data: { syncLeaseUntil: null, syncLeaseOwner: null } });
        await runSync(sheetId, { trigger: 'SCHEDULED', owner: `w-f${i}` });
      }
    } finally {
      fake.fail = null;
    }
    const issues = await devIssues({ recordId: sheetId });
    expect(issues.map((i) => (i.after as { context: { failures: number } }).context.failures)).toEqual([1, 3]);
    expect(issues.every((i) => i.actorId === null)).toBe(true);
    expect((await devNotes(sheetId)).map((n) => n.subject)).toEqual(expect.arrayContaining([expect.stringContaining('System (auto)')]));
  });

  it('Muaz sees read-only sync health (no Google details); members cannot', async () => {
    const { sheetId, member } = await linkedSheet([HEADER]);
    const st = await muaz.get('/api/lead-reports/sync-status');
    expect(st.status).toBe(200);
    const row = st.body.items.find((s: { id: string }) => s.id === sheetId);
    expect(row).toMatchObject({ member: member.user.displayName, consecutiveFailures: 0 });
    expect(JSON.stringify(st.body)).not.toMatch(/googleSheetId|columnMap|tabName/);
    expect((await call(member.agent).get('/api/lead-reports/sync-status')).status).toBe(403);
  });

  it('an unassigned sheet cannot be synced; only Hamza / Usama can press Sync now', async () => {
    const { sheetId } = await linkedSheet([HEADER]);
    expect((await mgr.post(`/api/lead-admin/sheets/${sheetId}/sync`, {})).status).toBe(403);
    expect((await muaz.post(`/api/lead-admin/sheets/${sheetId}/sync`, {})).status).toBe(403);
    await hamza.post(`/api/lead-admin/sheets/${sheetId}/unassign`, {});
    const r = await hamza.post(`/api/lead-admin/sheets/${sheetId}/sync`, {});
    expect(r.status).toBe(422);
  });
});
