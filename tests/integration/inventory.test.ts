import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { addDaysStr, addMonthsStr, clinicDateStr, dateOnly } from '../../src/lib/time';
import { runStockAlerts } from '../../src/modules/inventory/stock';
import { onHand, usableBatches } from '../../src/services/stock';
import { agentFor, call, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

type Api = ReturnType<typeof call>;
let mgr: Api;
let managerId: string;
let md: Api;
let mdId: string;
let ob: Api;
let asst: Api;
let bankId: string;

beforeAll(async () => {
  const m = await agentFor('MANAGER');
  mgr = call(m.agent);
  managerId = m.user.id;
  const d = await agentFor('MD');
  md = call(d.agent);
  mdId = d.user.id;
  ob = call((await agentFor('OFFICE_BOY')).agent);
  asst = call((await agentFor('ASSISTANT')).agent);
  bankId = (await prisma.bankAccount.findFirst({ where: { active: true } }))?.id ?? (await prisma.bankAccount.create({ data: { name: 'Test bank', bankName: 'Test', accountNo: '0000' } })).id;
});

async function item(minQty = 2) {
  return prisma.stockItem.create({ data: { name: `Inv item ${uid()}`, category: 'consumable', baseUnit: 'piece', minQty } });
}
async function vendor() {
  return prisma.vendor.create({ data: { name: `Vendor ${uid()}` } });
}
/** Demand by an Assistant for `qty` of `itemId` (Office Boys write items by name, D-066), priced by the Manager at `unitRs`. */
async function demand(itemId: string, qty: number, unitRs: number, by: Api = asst) {
  const c = await by.post('/api/stock/demands', { lines: [{ itemId, quantity: qty }], reason: 'Test demand' }, newKey());
  expect(c.status).toBe(201);
  const d = await mgr.get(`/api/inventory/demands/${c.body.id}`);
  const est = await mgr.put(`/api/inventory/demands/${c.body.id}/estimates`, { lines: [{ lineId: d.body.lines[0].id, estUnitCostPaisa: unitRs * 100 }] });
  expect(est.status).toBe(200);
  return { id: c.body.id as string, lineId: d.body.lines[0].id as string };
}
const receive = (demandId: string, vendorId: string, lines: object[]) => mgr.post('/api/inventory/receipts', { demandId, vendorId, vendorInvoiceNo: `INV-${uid()}`, lines }, newKey());

describe('§4 lock 6 — stock demand approval limit and unique demand numbers', () => {
  it('Manager approves up to Rs 20,000 inclusive; above goes to MD; no purchase before approval', async () => {
    const it1 = await item();
    const v = await vendor();
    const exact = await demand(it1.id, 10, 2000); // Rs 20,000 exactly
    const pending = await demand(it1.id, 1, 100);
    expect((await receive(pending.id, v.id, [{ demandLineId: pending.lineId, quantity: 1, unitCostPaisa: 10000, lotNo: 'X' }])).body.error.code).toBe('DEMAND_NOT_APPROVED');

    const ok = await mgr.post(`/api/inventory/demands/${exact.id}/decision`, { action: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.demandNumber).toMatch(/^DM-\d{4}-\d{4,}$/);

    const big = await demand(it1.id, 10, 2001); // Rs 20,010
    expect((await mgr.post(`/api/inventory/demands/${big.id}/decision`, { action: 'APPROVE' })).body.error.code).toBe('MD_APPROVAL_REQUIRED');
    expect((await mgr.post(`/api/inventory/demands/${big.id}/decision`, { action: 'FORWARD', reason: 'Bulk order' })).body.status).toBe('PENDING_MD');
    expect(await prisma.notification.count({ where: { recordId: big.id, type: 'STOCK_DEMAND_MD', recipientId: mdId } })).toBe(1);
    expect((await receive(big.id, v.id, [{ demandLineId: big.lineId, quantity: 1, unitCostPaisa: 200100, lotNo: 'Y' }])).body.error.code).toBe('MD_APPROVAL_REQUIRED');
    expect((await mgr.post(`/api/inventory/demands/${big.id}/md-decision`, { action: 'APPROVE' })).status).toBe(403);
    const mdOk = await md.post(`/api/inventory/demands/${big.id}/md-decision`, { action: 'APPROVE' });
    expect(mdOk.body).toMatchObject({ status: 'APPROVED' });
    expect(mdOk.body.demandNumber).not.toBe(ok.body.demandNumber);
    expect((await prisma.stockDemand.findUniqueOrThrow({ where: { id: big.id } })).approverRole).toBe('MD');

    // reject and return need reasons
    const r = await demand(it1.id, 1, 50);
    expect((await mgr.post(`/api/inventory/demands/${r.id}/decision`, { action: 'REJECT' })).status).toBe(422);
    expect((await mgr.post(`/api/inventory/demands/${r.id}/decision`, { action: 'REJECT', reason: 'Not needed' })).body.status).toBe('REJECTED');
  });

  it("the Manager's own demand cannot be self-approved — it goes to the MD", async () => {
    const it1 = await item();
    const own = await demand(it1.id, 2, 100, mgr);
    expect((await mgr.post(`/api/inventory/demands/${own.id}/decision`, { action: 'APPROVE' })).status).toBe(403);
    await mgr.post(`/api/inventory/demands/${own.id}/decision`, { action: 'FORWARD' });
    expect((await md.post(`/api/inventory/demands/${own.id}/md-decision`, { action: 'RETURN' })).status).toBe(422);
    expect((await md.post(`/api/inventory/demands/${own.id}/md-decision`, { action: 'RETURN', reason: 'Quantity kam karein' })).body.status).toBe('RETURNED_FOR_CORRECTION');
    expect((await mgr.get('/api/inventory/demands?scope=review')).body.items.some((d: { id: string }) => d.id === own.id)).toBe(true);
  });
});

describe('§18 — partial, multi-vendor receipts; batches; payable ledger', () => {
  it('receives from two vendors, updates stock, demand, batches and payables', async () => {
    const it1 = await item(1);
    const [a, b] = [await vendor(), await vendor()];
    const d = await demand(it1.id, 10, 1000);
    await mgr.post(`/api/inventory/demands/${d.id}/decision`, { action: 'APPROVE' });
    const exp = addMonthsStr(clinicDateStr(new Date()), 8);

    const r1 = await receive(d.id, a.id, [{ demandLineId: d.lineId, quantity: 4, unitCostPaisa: 95000, lotNo: 'LA1', expiryDate: exp }]);
    expect(r1.status).toBe(201);
    expect((await prisma.stockDemand.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('PARTIALLY_RECEIVED');
    expect((await receive(d.id, b.id, [{ demandLineId: d.lineId, quantity: 7, unitCostPaisa: 100000, lotNo: 'LB1' }])).status).toBe(422); // more than remaining
    expect((await receive(d.id, b.id, [{ demandLineId: d.lineId, quantity: 6, unitCostPaisa: 100000, lotNo: 'LB1', expiryDate: clinicDateStr(new Date()) }])).status).toBe(422); // expired goods
    const r2 = await receive(d.id, b.id, [{ demandLineId: d.lineId, quantity: 6, unitCostPaisa: 100000, lotNo: 'LB1', expiryDate: addMonthsStr(clinicDateStr(new Date()), 12) }]);
    expect(r2.status).toBe(201);
    expect((await prisma.stockDemand.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('RECEIVED');
    expect(await onHand(prisma, it1.id)).toBe(10);
    expect(await prisma.stockBatch.count({ where: { itemId: it1.id } })).toBe(2);
    const vendors = (await mgr.get('/api/inventory/vendors')).body.items;
    expect(vendors.find((x: { id: string }) => x.id === a.id).balancePaisa).toBe(380_000);
    expect(vendors.find((x: { id: string }) => x.id === b.id).balancePaisa).toBe(600_000);
    // idempotent replay returns the same receipt
    const key = newKey();
    const d2 = await demand(it1.id, 2, 100);
    await mgr.post(`/api/inventory/demands/${d2.id}/decision`, { action: 'APPROVE' });
    const body = { demandId: d2.id, vendorId: a.id, lines: [{ demandLineId: d2.lineId, quantity: 1, unitCostPaisa: 10000, lotNo: 'LA2' }] };
    const x1 = await mgr.post('/api/inventory/receipts', body, key);
    const x2 = await mgr.post('/api/inventory/receipts', body, key);
    expect(x2.body.receipt.id).toBe(x1.body.receipt.id);
    // a Manager-approved demand cannot be bought past the Manager limit
    expect((await receive(d2.id, a.id, [{ demandLineId: d2.lineId, quantity: 1, unitCostPaisa: 2_000_000, lotNo: 'LA3' }])).body.error.code).toBe('MD_APPROVAL_REQUIRED');
  });

  it('supplier returns reduce stock and payable; payments reduce payable and cash or bank', async () => {
    const it1 = await item(0);
    const v = await vendor();
    const d = await demand(it1.id, 5, 1000);
    await mgr.post(`/api/inventory/demands/${d.id}/decision`, { action: 'APPROVE' });
    await receive(d.id, v.id, [{ demandLineId: d.lineId, quantity: 5, unitCostPaisa: 100000, lotNo: 'R1' }]); // Rs 5,000 owed
    const batch = await prisma.stockBatch.findFirstOrThrow({ where: { itemId: it1.id } });
    expect((await mgr.post('/api/inventory/returns', { batchId: batch.id, quantity: 6, reason: 'Damaged box' })).status).toBe(422);
    expect((await mgr.post('/api/inventory/returns', { batchId: batch.id, quantity: 2, reason: 'Damaged box' })).status).toBe(201);
    expect(await onHand(prisma, it1.id)).toBe(3);

    const pay = (body: object, key = newKey()) => mgr.post(`/api/inventory/vendors/${v.id}/payments`, body, key);
    expect((await pay({ amountPaisa: 100_000, method: 'BANK_ONLINE', bankAccountId: bankId })).status).toBe(422); // reference required
    const k = newKey();
    const cash = await pay({ amountPaisa: 100_000, method: 'CASH' }, k);
    expect(cash.status).toBe(201);
    expect((await pay({ amountPaisa: 100_000, method: 'CASH' }, k)).body.payment.id).toBe(cash.body.payment.id);
    expect((await pay({ amountPaisa: 150_000, method: 'CHEQUE', bankAccountId: bankId, reference: 'CHQ-1001' })).status).toBe(201);
    expect(await prisma.ledgerEntry.count({ where: { account: 'CASH_IN_HAND', refId: cash.body.payment.id, amountPaisa: -100_000n } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { account: 'BANK', bankAccountId: bankId, vendorId: v.id, amountPaisa: -150_000n } })).toBe(1);
    const ledger = await mgr.get(`/api/inventory/vendors/${v.id}/ledger`);
    expect(ledger.body.balancePaisa).toBe(50_000);
    expect(ledger.body.entries.map((e: { kind: string }) => e.kind)).toEqual(['GoodsReceipt', 'SupplierReturn', 'SupplierPayment', 'SupplierPayment']);
    expect(ledger.body.entries.at(-1).balancePaisa).toBe(50_000);

    // D-050: paying more than owed is an advance; the note says what it was for
    const adv = await pay({ amountPaisa: 80_000, method: 'CASH', note: 'Advance — next order' });
    expect(adv.status).toBe(201);
    expect(adv.body.payment.note).toBe('Advance — next order');
    const after = await mgr.get(`/api/inventory/vendors/${v.id}/ledger`);
    expect(after.body.balancePaisa).toBe(-30_000);
    expect(after.body.entries.at(-1).payment.note).toBe('Advance — next order');
    const listed = (await mgr.get('/api/inventory/vendors')).body.items.find((x: { id: string }) => x.id === v.id);
    expect(listed).toMatchObject({ paidPaisa: 330_000, balancePaisa: -30_000 });
  });
});

describe('§18 — FEFO; expired and quarantined batches are never usable', () => {
  it('skips quarantined and expired lots', async () => {
    const it1 = await item(0);
    const today = clinicDateStr(new Date());
    const mk = async (lot: string, exp: string | null, qty: number) => {
      const b = await prisma.stockBatch.create({ data: { itemId: it1.id, lotNo: lot, expiryDate: exp ? dateOnly(exp) : null, unitCostPaisa: 100n } });
      await prisma.stockTransaction.create({ data: { itemId: it1.id, batchId: b.id, type: 'PURCHASE', quantity: qty, actorId: managerId } });
      return b;
    };
    const expired = await mk('OLD', addDaysStr(today, -1), 5);
    const soon = await mk('SOON', addMonthsStr(today, 4), 5);
    const later = await mk('LATER', addMonthsStr(today, 9), 5);
    expect((await usableBatches(prisma, it1.id)).map((b) => b.lotNo)).toEqual(['SOON', 'LATER']);
    expect((await mgr.post(`/api/inventory/batches/${soon.id}/status`, { status: 'QUARANTINED', reason: 'Seal toota hua' })).status).toBe(200);
    expect((await usableBatches(prisma, it1.id)).map((b) => b.lotNo)).toEqual(['LATER']);
    expect((await mgr.post(`/api/inventory/batches/${expired.id}/status`, { status: 'AVAILABLE', reason: 'try' })).body.error.code).toBe('BATCH_EXPIRED');
    const detail = await mgr.get(`/api/inventory/items/${it1.id}`);
    expect(detail.body.batches.find((b: { id: string }) => b.id === expired.id).expired).toBe(true);
    expect(detail.body.item.onHand).toBe(15);
    const ov = (await mgr.get('/api/inventory/stock')).body.items.find((i: { id: string }) => i.id === it1.id);
    expect(ov).toMatchObject({ onHand: 15, usable: 5, expired: 5, quarantined: 5 });
    void later;
  });
});

describe('§18 — damage write-off needs approval (approver ≠ reporter)', () => {
  it('Assistant report → Manager approves; Manager report → MD', async () => {
    const it1 = await item(0);
    const b = await prisma.stockBatch.create({ data: { itemId: it1.id, lotNo: 'D1', unitCostPaisa: 100n } });
    await prisma.stockTransaction.create({ data: { itemId: it1.id, batchId: b.id, type: 'PURCHASE', quantity: 10, actorId: managerId } });
    const asst = call((await agentFor('ASSISTANT')).agent);
    const rep = await asst.post('/api/inventory/damage', { itemId: it1.id, batchId: b.id, quantity: 3, reason: 'Bottle gir kar toot gayi' });
    expect(rep.status).toBe(201);
    expect(await onHand(prisma, it1.id)).toBe(10); // nothing until approved
    expect((await md.post(`/api/inventory/damage/${rep.body.id}/decision`, { approve: true })).status).toBe(403); // Manager's queue
    expect((await mgr.post(`/api/inventory/damage/${rep.body.id}/decision`, { approve: true })).status).toBe(200);
    expect(await onHand(prisma, it1.id)).toBe(7);
    expect((await mgr.post(`/api/inventory/damage/${rep.body.id}/decision`, { approve: true })).body.error.code).toBe('ALREADY_DECIDED');

    const own = await mgr.post('/api/inventory/damage', { itemId: it1.id, quantity: 2, reason: 'Store mein seelan' });
    expect((await prisma.damageReport.findUniqueOrThrow({ where: { id: own.body.id } })).approverRole).toBe('MD');
    expect((await mgr.post(`/api/inventory/damage/${own.body.id}/decision`, { approve: true })).status).toBe(403);
    expect((await md.post(`/api/inventory/damage/${own.body.id}/decision`, { approve: false })).status).toBe(422);
    expect((await md.post(`/api/inventory/damage/${own.body.id}/decision`, { approve: true })).status).toBe(200);
    expect(await onHand(prisma, it1.id)).toBe(5);
  });
});

describe('§18 / §20 — low-stock and expiry alerts, never duplicated', () => {
  it('low stock alerts once per episode; expiry exactly two months ahead, once per batch', async () => {
    const it1 = await item(5);
    const b = await prisma.stockBatch.create({ data: { itemId: it1.id, lotNo: 'A1', unitCostPaisa: 100n, expiryDate: dateOnly(addMonthsStr(clinicDateStr(new Date()), 6)) } });
    await prisma.stockTransaction.create({ data: { itemId: it1.id, batchId: b.id, type: 'PURCHASE', quantity: 8, actorId: managerId } });
    const lows = () => prisma.notification.count({ where: { recordId: it1.id, type: 'LOW_STOCK', recipientId: managerId } });
    await runStockAlerts();
    expect(await lows()).toBe(0);
    await prisma.stockTransaction.create({ data: { itemId: it1.id, batchId: b.id, type: 'ADJUSTMENT', quantity: -4, actorId: managerId } }); // 4 ≤ 5
    await runStockAlerts();
    await runStockAlerts();
    expect(await lows()).toBe(1);
    await prisma.stockTransaction.create({ data: { itemId: it1.id, batchId: b.id, type: 'ADJUSTMENT', quantity: 5, actorId: managerId } }); // back to 9
    await runStockAlerts();
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: it1.id } })).lowStockAlertedAt).toBeNull();
    await prisma.stockTransaction.create({ data: { itemId: it1.id, batchId: b.id, type: 'ADJUSTMENT', quantity: -6, actorId: managerId } }); // 3
    await runStockAlerts();
    expect(await lows()).toBe(2);

    const today = clinicDateStr(new Date());
    const it2 = await item(0);
    const exactly = await prisma.stockBatch.create({ data: { itemId: it2.id, lotNo: 'E2', unitCostPaisa: 1n, expiryDate: dateOnly(addMonthsStr(today, 2)) } });
    const dayAfter = await prisma.stockBatch.create({ data: { itemId: it2.id, lotNo: 'E3', unitCostPaisa: 1n, expiryDate: dateOnly(addDaysStr(addMonthsStr(today, 2), 1)) } });
    for (const x of [exactly, dayAfter]) await prisma.stockTransaction.create({ data: { itemId: it2.id, batchId: x.id, type: 'PURCHASE', quantity: 3, actorId: managerId } });
    await runStockAlerts();
    await runStockAlerts();
    expect(await prisma.notification.count({ where: { recordId: it2.id, type: 'EXPIRY_ALERT', recipientId: managerId } })).toBe(1);
    expect((await prisma.stockBatch.findUniqueOrThrow({ where: { id: exactly.id } })).expiryAlertedAt).not.toBeNull();
    expect((await prisma.stockBatch.findUniqueOrThrow({ where: { id: dayAfter.id } })).expiryAlertedAt).toBeNull();
    // past expiry → EXPIRED status
    const gone = await prisma.stockBatch.create({ data: { itemId: it2.id, lotNo: 'E0', unitCostPaisa: 1n, expiryDate: dateOnly(addDaysStr(today, -2)) } });
    await runStockAlerts();
    expect((await prisma.stockBatch.findUniqueOrThrow({ where: { id: gone.id } })).status).toBe('EXPIRED');
  }, 60_000); // scans every stock item; the shared test DB grows over runs
});

describe('§14 — daily cash closing and cash reports with outstanding installments', () => {
  it('closes a day once with variance note, and reports outstanding balances', async () => {
    // an isolated past clinic day so other tests' money never mixes in
    const D = addDaysStr('2015-01-01', Math.floor(Math.random() * 3000));
    const at = new Date(`${D}T07:00:00Z`); // 12:00 clinic time
    const rec = await makeUser('RECEPTIONIST');
    const p = await prisma.patient.create({ data: { name: `Cash Patient ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: rec.id } });
    const doctor = await makeUser('DOCTOR');
    const appt = await prisma.appointment.create({ data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: at, endAt: new Date(at.getTime() + 1200_000), status: 'DONE', source: 'RECEPTION', createdById: rec.id } });
    const plan = await prisma.treatmentPlan.create({ data: { patientId: p.id, doctorId: doctor.id, appointmentId: appt.id, currentVersionNo: 1 } });
    const ver = await prisma.treatmentPlanVersion.create({
      data: { planId: plan.id, versionNo: 1, consultationReason: 'x', consultationFeePaisa: 0n, itemsSubtotalPaisa: 1_000_000n, itemsDiscountPaisa: 0n, totalDiscountPaisa: 0n, grandTotalPaisa: 1_000_000n, advanceRequestedPaisa: 400_000n, balancePaisa: 600_000n, installmentCount: 2, createdById: doctor.id },
    });
    await prisma.installment.createMany({ data: [{ versionId: ver.id, seq: 1, dueDate: dateOnly(addDaysStr(clinicDateStr(new Date()), -3)), amountPaisa: 300_000n }, { versionId: ver.id, seq: 2, dueDate: dateOnly(addDaysStr(clinicDateStr(new Date()), 20)), amountPaisa: 300_000n }] });
    const inv = await prisma.invoice.create({ data: { number: `T-${uid()}`, patientId: p.id, appointmentId: appt.id, planVersionId: ver.id, status: 'CLOSED', subtotalPaisa: 1_050_000n, discountPaisa: 50_000n, totalPaisa: 1_000_000n, paidPaisa: 400_000n, balancePaisa: 600_000n, createdById: rec.id, createdAt: at } });
    const pay = async (amount: bigint, method: 'CASH' | 'CARD') => {
      const pmt = await prisma.payment.create({ data: { receiptNo: `R-${uid()}`, invoiceId: inv.id, amountPaisa: amount, method, cashierId: rec.id, idempotencyKey: uid(), receivedAt: at } });
      await prisma.ledgerEntry.create({ data: { account: method === 'CASH' ? 'CASH_IN_HAND' : 'BANK', bankAccountId: method === 'CASH' ? null : bankId, amountPaisa: amount, refType: 'Payment', refId: pmt.id, actorId: rec.id, createdAt: at } });
    };
    await pay(300_000n, 'CASH');
    await pay(100_000n, 'CARD');
    await prisma.ledgerEntry.create({ data: { account: 'CASH_IN_HAND', amountPaisa: -50_000n, refType: 'SupplierPayment', refId: uid(), actorId: managerId, createdAt: at } });

    const day = await mgr.get(`/api/cash/day?date=${D}`);
    expect(day.body.collections).toMatchObject({ totalPaisa: 400_000, cashPaisa: 300_000, cardPaisa: 100_000 });
    expect(day.body.discountsPaisa).toBe(50_000);
    expect(day.body.cash).toEqual({ inPaisa: 300_000, outPaisa: 50_000, expectedPaisa: 250_000 });
    expect(day.body.perCashier[0]).toMatchObject({ cashierId: rec.id, totalPaisa: 400_000 });

    expect((await mgr.post('/api/cash/closings', { date: D, countedCashPaisa: 249_000 })).status).toBe(422); // variance needs a note
    const c = await mgr.post('/api/cash/closings', { date: D, countedCashPaisa: 249_000, notes: 'Rs 10 short — change', cashierId: rec.id });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ expectedCashPaisa: 250_000, countedCashPaisa: 249_000, variancePaisa: -1_000, managerId });
    expect((await mgr.post('/api/cash/closings', { date: D, countedCashPaisa: 250_000 })).body.error.code).toBe('ALREADY_CLOSED');
    await expect(prisma.cashClosing.update({ where: { id: c.body.id }, data: { notes: 'edit' } })).rejects.toThrow();
    expect((await call((await agentFor('RECEPTIONIST')).agent).get(`/api/cash/day?date=${D}`)).status).toBe(403);

    const rep = await mgr.get(`/api/cash/report?from=${D}&to=${D}`);
    expect(rep.body.days[0].closing).toMatchObject({ variancePaisa: -1_000 });
    expect(rep.body.totals).toMatchObject({ collectedPaisa: 400_000, discountsPaisa: 50_000, variancePaisa: -1_000 });
    const mine = rep.body.outstanding.items.find((x: { invoiceId: string }) => x.invoiceId === inv.id);
    expect(mine).toMatchObject({ balancePaisa: 600_000, overduePaisa: 300_000, overdueCount: 1, patient: { name: p.name } });
    expect(mine.nextDue.outstandingPaisa).toBe(300_000);
    expect(mine.installments.map((i: { state: string }) => i.state)).toEqual(['OVERDUE', 'UPCOMING']);
  });
});

describe('§4 — costs and inventory screens are Manager / MD only', () => {
  it('other roles are refused', async () => {
    const asst = call((await agentFor('ASSISTANT')).agent);
    for (const path of ['/api/inventory/stock', '/api/inventory/vendors', '/api/inventory/demands', '/api/cash/report?from=2026-01-01&to=2026-01-02']) {
      expect((await asst.get(path)).status, path).toBe(403);
    }
    expect((await ob.get('/api/inventory/vendors')).status).toBe(403);
  });
});
