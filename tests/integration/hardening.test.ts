import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { addDaysStr, addMonthsStr, clinicDateStr, dateOnly } from '../../src/lib/time';
import { systemActor } from '../../src/services/audit';
import { clearSettingsCache } from '../../src/services/settings';
import { deductUsage, onHand, usableBatches } from '../../src/services/stock';
import { agentFor, call, makeUser, prisma, uid } from './helpers';

/**
 * Phase 11 gap tests: spec §24 rows not already covered elsewhere, and §25 #21 / #25 details.
 * docs/ACCEPTANCE.md maps every §24 row and §25 checkbox to its test.
 */

let managerId: string;
let mgr: ReturnType<typeof call>;
beforeAll(async () => {
  const m = await agentFor('MANAGER');
  mgr = call(m.agent);
  managerId = m.user.id;
});

const saved = new Map<string, Prisma.JsonValue | undefined>();
async function setSetting(key: string, value: unknown) {
  if (!saved.has(key)) saved.set(key, (await prisma.setting.findUnique({ where: { key } }))?.value);
  await prisma.setting.upsert({ where: { key }, create: { key, value: value as Prisma.InputJsonValue, isPlaceholder: true, description: 'test' }, update: { value: value as Prisma.InputJsonValue } });
  clearSettingsCache();
}
afterAll(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) await prisma.setting.deleteMany({ where: { key } });
    else await prisma.setting.update({ where: { key }, data: { value: value as Prisma.InputJsonValue } });
  }
  clearSettingsCache();
});

async function stockItem(batches: { qty: number; expiry: string | null }[]) {
  const item = await prisma.stockItem.create({ data: { name: `Hardening item ${uid()}`, category: 'consumable', baseUnit: 'ml', minQty: 1 } });
  for (const [i, b] of batches.entries()) {
    const batch = await prisma.stockBatch.create({ data: { itemId: item.id, lotNo: `L${i}`, unitCostPaisa: 1000n, expiryDate: b.expiry ? dateOnly(b.expiry) : null } });
    await prisma.stockTransaction.create({ data: { itemId: item.id, batchId: batch.id, type: 'PURCHASE', quantity: b.qty, actorId: managerId } });
  }
  return item;
}

describe('§24 — "No leads / no appointment today": 200 with an empty list, never an error', () => {
  it('Lead member without sheets, a Doctor with no patients, Reception on an empty day', async () => {
    const lead = call((await agentFor('LEAD_MEMBER')).agent);
    const sheets = await lead.get('/api/lead/sheets');
    expect(sheets.status).toBe(200);
    expect(sheets.body.items).toEqual([]);
    const leads = await lead.get('/api/lead/leads');
    expect(leads.status).toBe(200);
    expect(leads.body.items).toEqual([]);

    const doc = call((await agentFor('DOCTOR')).agent);
    const queue = await doc.get('/api/doctor/queue');
    expect(queue.status).toBe(200);
    expect(JSON.stringify(queue.body)).not.toContain('"error"');

    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const farDay = addDaysStr(clinicDateStr(new Date()), 900);
    const tracker = await rec.get(`/api/reception/tracker?date=${farDay}`);
    expect(tracker.status).toBe(200);
    expect(tracker.body.items ?? tracker.body).toEqual([]);
  });
});

describe('§24 — insufficient stock is never silently decremented', () => {
  it('usage above usable stock is refused with the usable quantity; nothing is written', async () => {
    const item = await stockItem([{ qty: 3, expiry: null }]);
    const before = await onHand(prisma, item.id);
    await expect(prisma.$transaction((tx) => deductUsage(tx, { ...systemActor, id: managerId }, `task-${uid()}`, { itemId: item.id, quantity: 5 }))).rejects.toThrow(/sirf 3 ml usable stock/);
    expect(await onHand(prisma, item.id)).toBe(before);
    await expect(prisma.$transaction((tx) => deductUsage(tx, { ...systemActor, id: managerId }, `task-${uid()}`, { itemId: item.id, quantity: 0 }))).rejects.toThrow();
  });
});

describe('§25 #21 — expiry: expired never usable; near-expiry follows the configured policy', () => {
  it('stock.nearExpiryUsable decides whether a batch inside the 2-month window can be used', async () => {
    const today = clinicDateStr(new Date());
    const item = await stockItem([
      { qty: 4, expiry: addDaysStr(today, -1) }, // expired
      { qty: 5, expiry: addDaysStr(addMonthsStr(today, 1), 0) }, // near expiry (inside 2 months)
      { qty: 6, expiry: addMonthsStr(today, 6) }, // fine
    ]);
    await setSetting('stock.nearExpiryUsable', true);
    expect((await usableBatches(prisma, item.id)).map((b) => b.balance)).toEqual([5, 6]); // FEFO order, expired excluded
    await setSetting('stock.nearExpiryUsable', false);
    expect((await usableBatches(prisma, item.id)).map((b) => b.balance)).toEqual([6]);
    expect(await onHand(prisma, item.id)).toBe(15); // nothing is deleted; on-hand still counts every batch
  });
});

describe('§25 #25 — completed tasks leave the pending queue but stay in history', () => {
  it('a completed Manager task disappears from "open", appears under "done" and in the audit search', async () => {
    const doctor = await makeUser('DOCTOR');
    const patient = await prisma.patient.create({ data: { name: `History ${uid()}`, phone: `92300${String(Date.now()).slice(-7)}`, createdById: doctor.id } });
    const task = await prisma.workflowTask.create({
      data: { type: 'MANAGER_STOCK_CHECK', title: `Stock check: Laser — ${patient.name}`, patientId: patient.id, assignedRole: 'MANAGER', idempotencyKey: `hardening:${uid()}`, payload: { procedure: 'Laser' } },
    });
    const open = await mgr.get('/api/manager/stock-checks?scope=open');
    expect(open.body.items.some((t: { id: string }) => t.id === task.id)).toBe(true);
    expect((await mgr.post(`/api/manager/stock-checks/${task.id}/complete`, { note: 'checked' })).status).toBe(200);
    expect((await mgr.get('/api/manager/stock-checks?scope=open')).body.items.some((t: { id: string }) => t.id === task.id)).toBe(false);
    const done = await mgr.get('/api/manager/stock-checks?scope=done');
    expect(done.body.items.find((t: { id: string }) => t.id === task.id)).toMatchObject({ status: 'COMPLETED', completedBy: expect.any(String) });
    expect(await prisma.workflowTask.count({ where: { id: task.id } })).toBe(1); // never hard-deleted
    const audit = await mgr.get(`/api/manager/audit?recordType=WorkflowTask&recordId=${task.id}`);
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain('STOCK_CHECK_DONE');
  });
});
