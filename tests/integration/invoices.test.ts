import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { daySummary } from '../../src/modules/cash/service';
import { addDaysStr, clinicDateStr } from '../../src/lib/time';
import { onHand } from '../../src/services/stock';
import { advanceBalance } from '../../src/services/invoicePayments';
import { agentFor, call, lastAudit, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

/** D-084 — invoice module API: money rules, advances, cancellation, Cash Closing, permissions. */

const CASH = 'pm_cash';
type Api = ReturnType<typeof call>;
let rec: Api, mgr: Api, md: Api, doc: Api, office: Api;
let recUserId: string;

const today = () => clinicDateStr(new Date());
const cashDay = () => daySummary(today());
const receipt = (p: { amountPaisa: number; extraToAdvance?: boolean; paymentModeId?: string }) => ({ paymentModeId: CASH, ...p });

beforeAll(async () => {
  const r = await agentFor('RECEPTIONIST');
  rec = call(r.agent);
  recUserId = r.user.id;
  mgr = call((await agentFor('MANAGER')).agent);
  md = call((await agentFor('MD')).agent);
  doc = call((await agentFor('DOCTOR')).agent);
  office = call((await agentFor('OFFICE_BOY')).agent);
});

async function newPatient() {
  return prisma.patient.create({ data: { name: `Inv Patient ${uid()}`, phone: uniquePhone(), createdById: recUserId } });
}

/** A direct invoice for Rs 10,000 unless lines say otherwise. */
async function direct(extra: object = {}, patientId?: string) {
  const res = await rec.post('/api/invoices', { patientId: patientId ?? (await newPatient()).id, lines: [{ description: 'Consultation', unitPricePaisa: 1_000_000 }], ...extra }, newKey());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('creating a direct invoice', () => {
  it('computes every total on the server, ignoring any total a client sends', async () => {
    const inv = await direct({ lines: [{ description: 'Laser', unitPricePaisa: 700_000 }, { description: 'Injection', unitPricePaisa: 300_000, quantity: 2 }], discountPaisa: 100_000, totalPaisa: 1, balancePaisa: 1, payment: receipt({ amountPaisa: 400_000 }) });
    expect(inv).toMatchObject({ kind: 'DIRECT', status: 'OPEN', subtotalPaisa: 1_300_000, discountPaisa: 100_000, taxPaisa: 0, taxRateBp: null, totalPaisa: 1_200_000, paidPaisa: 400_000, balancePaisa: 800_000 });
    expect(inv.date).toBe(today());
    expect(inv.number).toMatch(/^VH-INV-\d{4}-\d{4,}$/);
    expect(inv.payments).toHaveLength(1);
    expect(inv.payments[0]).toMatchObject({ amountPaisa: 400_000, method: 'CASH', modeName: 'Cash', paymentModeId: CASH });
    expect(inv.payments[0].cashierName).toBeTruthy();
    expect(inv.createdByName).toBeTruthy();
    expect(await lastAudit('INVOICE_CREATED', inv.id)).not.toBeNull();
  });

  it('closes itself once fully paid, and a retry does not bill or charge twice', async () => {
    const p = await newPatient();
    const key = newKey();
    const body = { patientId: p.id, lines: [{ description: 'Consultation', unitPricePaisa: 200_000 }], payment: receipt({ amountPaisa: 200_000 }) };
    const first = await rec.post('/api/invoices', body, key);
    const again = await rec.post('/api/invoices', body, key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'CLOSED', balancePaisa: 0 });
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.invoice.count({ where: { patientId: p.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { invoiceId: first.body.id } })).toBe(1);
  });

  it('refuses a future date, a discount above the subtotal and an unknown Doctor', async () => {
    const p = await newPatient();
    const lines = [{ description: 'X', unitPricePaisa: 100 }];
    expect((await rec.post('/api/invoices', { patientId: p.id, lines, date: addDaysStr(today(), 1) }, newKey())).status).toBe(422);
    expect((await rec.post('/api/invoices', { patientId: p.id, lines, discountPaisa: 101 }, newKey())).status).toBe(422);
    expect((await rec.post('/api/invoices', { patientId: p.id, lines, doctorId: recUserId }, newKey())).status).toBe(422);
    expect(await prisma.invoice.count({ where: { patientId: p.id } })).toBe(0);
  });

  it('allows a past date, stores the Doctor, and uses a service from the list with a changed price', async () => {
    const doctor = await makeUser('DOCTOR');
    const service = await prisma.service.create({ data: { name: `Svc ${uid()}`, type: 'PROCEDURE', defaultPricePaisa: 500_000n } });
    const date = addDaysStr(today(), -3);
    const inv = await direct({ date, doctorId: doctor.id, lines: [{ serviceId: service.id, unitPricePaisa: 450_000 }] });
    expect(inv.date).toBe(date);
    expect(inv.doctor.id).toBe(doctor.id);
    expect(inv.lines[0]).toMatchObject({ description: service.name, serviceId: service.id, unitPricePaisa: 450_000 });
  });

  it('warns when the patient has a visit open today, and goes ahead only once that is confirmed', async () => {
    const p = await newPatient();
    const doctor = await makeUser('DOCTOR');
    const now = new Date();
    await prisma.appointment.create({ data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: now, endAt: new Date(now.getTime() + 1_200_000), status: 'WAITING', source: 'RECEPTION', createdById: recUserId } });
    const body = { patientId: p.id, lines: [{ description: 'X', unitPricePaisa: 100 }] };
    const warned = await rec.post('/api/invoices', body, newKey());
    expect(warned.status).toBe(409);
    expect(warned.body.error.code).toBe('OPEN_VISIT');
    expect((await rec.get(`/api/invoices/patients/${p.id}/context`)).body.openVisitsToday).toHaveLength(1);
    expect((await rec.post('/api/invoices', { ...body, confirmOpenVisit: true }, newKey())).status).toBe(201);
  });

  it('applies tax only when it is on in Settings, and the desk can leave it off', async () => {
    expect((await md.put('/api/invoices/settings', { taxEnabled: true, taxBasisPoints: 1600 })).status).toBe(200);
    try {
      const taxed = await direct({ discountPaisa: 100_000 });
      expect(taxed).toMatchObject({ subtotalPaisa: 1_000_000, discountPaisa: 100_000, taxPaisa: 124_138, taxRateBp: 1600, totalPaisa: 900_000, balancePaisa: 900_000 });
      expect(await direct({ applyTax: false })).toMatchObject({ taxPaisa: 0, taxRateBp: null, totalPaisa: 1_000_000 });
    } finally {
      await md.put('/api/invoices/settings', { taxEnabled: false, taxBasisPoints: 0 });
    }
  });

  it('numbers follow the format in Settings, are unique, and the old format still works', async () => {
    const tag = `T${uid().slice(-5)}`.toUpperCase();
    expect((await md.put('/api/invoices/settings', { numberFormat: `${tag}/{YY}/{SEQ}` })).status).toBe(200);
    try {
      const a = await direct();
      const b = await direct();
      expect(a.number).toMatch(new RegExp(`^${tag}/\\d{2}/\\d{4,}$`));
      expect(b.number).not.toBe(a.number);
    } finally {
      await md.put('/api/invoices/settings', { numberFormat: '{PREFIX}-{YYYY}-{SEQ}' });
    }
    expect((await md.put('/api/invoices/settings', { numberFormat: 'NO-SEQUENCE' })).status).toBe(422);
    expect((await direct()).number).toMatch(/^VH-INV-/);
  });
});

describe('overpayment and advances', () => {
  it('refuses paying more than the total, and writes nothing', async () => {
    const p = await newPatient();
    const res = await rec.post('/api/invoices', { patientId: p.id, lines: [{ description: 'X', unitPricePaisa: 100_000 }], payment: receipt({ amountPaisa: 150_000 }) }, newKey());
    expect(res.status).toBe(422);
    expect(res.body.error.details.extraPaisa).toBe(50_000);
    expect(await prisma.invoice.count({ where: { patientId: p.id } })).toBe(0);
    expect(await advanceBalance(prisma, p.id)).toBe(0n);
  });

  it('saves a confirmed extra as the patient\'s advance, with cash counted once', async () => {
    const p = await newPatient();
    const before = await cashDay();
    const inv = await direct({ lines: [{ description: 'X', unitPricePaisa: 100_000 }], payment: receipt({ amountPaisa: 150_000, extraToAdvance: true }) }, p.id);
    expect(inv).toMatchObject({ paidPaisa: 100_000, balancePaisa: 0, status: 'CLOSED', advanceBalancePaisa: 50_000 });
    const after = await cashDay();
    expect(after.collections.cashPaisa - before.collections.cashPaisa).toBe(150_000n);
    expect(after.collections.totalPaisa - before.collections.totalPaisa).toBe(150_000n);
    expect(after.cash.expectedPaisa - before.cash.expectedPaisa).toBe(150_000n);
    expect(after.advances.receivedPaisa - before.advances.receivedPaisa).toBe(50_000n);
  });

  it('counts an advance as cash when received, and not again when used on an invoice', async () => {
    const p = await newPatient();
    const s0 = await cashDay();
    const adv = await rec.post('/api/invoices/advances', { patientId: p.id, amountPaisa: 300_000, paymentModeId: CASH, note: 'Before treatment' }, newKey());
    expect(adv.status, JSON.stringify(adv.body)).toBe(201);
    expect(adv.body.balancePaisa).toBe(300_000);
    expect(adv.body.entry.receiptNo).toMatch(/^VH-ADV-/);
    const s1 = await cashDay();
    expect(s1.collections.totalPaisa - s0.collections.totalPaisa).toBe(300_000n);
    expect(s1.cash.expectedPaisa - s0.cash.expectedPaisa).toBe(300_000n);

    const inv = await direct({ lines: [{ description: 'X', unitPricePaisa: 500_000 }], useAdvancePaisa: 200_000 }, p.id);
    expect(inv).toMatchObject({ paidPaisa: 200_000, balancePaisa: 300_000, advanceBalancePaisa: 100_000 });
    expect(inv.payments[0]).toMatchObject({ method: 'ADVANCE', amountPaisa: 200_000 });
    const s2 = await cashDay();
    expect(s2.collections.totalPaisa).toBe(s1.collections.totalPaisa);
    expect(s2.cash.expectedPaisa).toBe(s1.cash.expectedPaisa);
    expect(s2.advances.appliedPaisa - s1.advances.appliedPaisa).toBe(200_000n);

    // the rest of the advance, on the same invoice later
    const later = await rec.post(`/api/invoices/${inv.id}/apply-advance`, { amountPaisa: 100_000 }, newKey());
    expect(later.body).toMatchObject({ paidPaisa: 300_000, balancePaisa: 200_000, advanceBalancePaisa: 0 });
  });

  it('refuses to spend more advance than the patient has, or more than the invoice owes', async () => {
    const p = await newPatient();
    await rec.post('/api/invoices/advances', { patientId: p.id, amountPaisa: 100_000, paymentModeId: CASH }, newKey());
    const inv = await direct({ lines: [{ description: 'X', unitPricePaisa: 500_000 }] }, p.id);
    expect((await rec.post(`/api/invoices/${inv.id}/apply-advance`, { amountPaisa: 100_001 }, newKey())).status).toBe(422);
    const small = await direct({ lines: [{ description: 'Y', unitPricePaisa: 50_000 }] }, p.id);
    expect((await rec.post(`/api/invoices/${small.id}/apply-advance`, { amountPaisa: 60_000 }, newKey())).status).toBe(422);
    expect(await advanceBalance(prisma, p.id)).toBe(100_000n);
  });

  it('two desks spending the same advance at once cannot overdraw it', async () => {
    const p = await newPatient();
    await rec.post('/api/invoices/advances', { patientId: p.id, amountPaisa: 100_000, paymentModeId: CASH }, newKey());
    const a = await direct({ lines: [{ description: 'A', unitPricePaisa: 100_000 }] }, p.id);
    const b = await direct({ lines: [{ description: 'B', unitPricePaisa: 100_000 }] }, p.id);
    const [x, y] = await Promise.all([rec.post(`/api/invoices/${a.id}/apply-advance`, { amountPaisa: 100_000 }, newKey()), rec.post(`/api/invoices/${b.id}/apply-advance`, { amountPaisa: 100_000 }, newKey())]);
    expect([x.status, y.status].sort()).toEqual([201, 422]);
    expect(await advanceBalance(prisma, p.id)).toBe(0n);
  });

  it('a retried advance is recorded once', async () => {
    const p = await newPatient();
    const key = newKey();
    const body = { patientId: p.id, amountPaisa: 100_000, paymentModeId: CASH };
    await rec.post('/api/invoices/advances', body, key);
    await rec.post('/api/invoices/advances', body, key);
    expect(await advanceBalance(prisma, p.id)).toBe(100_000n);
  });

  it('Manager refunds an advance (cash leaves the drawer today); Reception cannot', async () => {
    const p = await newPatient();
    await rec.post('/api/invoices/advances', { patientId: p.id, amountPaisa: 100_000, paymentModeId: CASH }, newKey());
    const body = { amountPaisa: 40_000, paymentModeId: CASH, reason: 'Patient asked for it back' };
    expect((await rec.post(`/api/invoices/advances/patient/${p.id}/refund`, body, newKey())).status).toBe(403);
    const before = await cashDay();
    const r = await mgr.post(`/api/invoices/advances/patient/${p.id}/refund`, body, newKey());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.balancePaisa).toBe(60_000);
    const after = await cashDay();
    expect(after.cash.expectedPaisa - before.cash.expectedPaisa).toBe(-40_000n);
    expect(after.collections.totalPaisa - before.collections.totalPaisa).toBe(-40_000n);
    expect((await mgr.post(`/api/invoices/advances/patient/${p.id}/refund`, { ...body, amountPaisa: 60_001 }, newKey())).status).toBe(422);
  });

  it('lists a patient\'s advance history with who recorded it', async () => {
    const p = await newPatient();
    await rec.post('/api/invoices/advances', { patientId: p.id, amountPaisa: 100_000, paymentModeId: CASH }, newKey());
    const res = await rec.get(`/api/invoices/advances?patientId=${p.id}`);
    expect(res.body.balancePaisa).toBe(100_000);
    expect(res.body.items[0]).toMatchObject({ type: 'RECEIPT', amountPaisa: 100_000, method: 'CASH' });
    expect(res.body.items[0].actorName).toBeTruthy();
  });
});

describe('later payments', () => {
  it('each is saved separately with its mode and who received it', async () => {
    const inv = await direct();
    await rec.post(`/api/invoices/${inv.id}/payments`, receipt({ amountPaisa: 300_000 }), newKey());
    const bank = await prisma.bankAccount.create({ data: { name: 'Inv test', bankName: 'Test', accountNo: uid() } });
    const res = await mgr.post(`/api/invoices/${inv.id}/payments`, { amountPaisa: 700_000, paymentModeId: 'pm_online', bankAccountId: bank.id, reference: 'TRX-1' }, newKey());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ paidPaisa: 1_000_000, balancePaisa: 0, status: 'CLOSED' });
    expect(res.body.payments.map((p: { modeName: string; method: string }) => [p.modeName, p.method])).toEqual([['Cash', 'CASH'], ['Online Transfer', 'BANK_ONLINE']]);
    expect(new Set(res.body.payments.map((p: { cashierId: string }) => p.cashierId)).size).toBe(2);
    expect((await prisma.ledgerEntry.findFirstOrThrow({ where: { refId: res.body.payments[1].id } })).account).toBe('BANK');
  });

  it('keeps the bank account and reference rules, through a mode the MD added', async () => {
    const add = await md.post('/api/invoices/payment-modes', { name: `Easypaisa ${uid()}`, method: 'BANK_ONLINE' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const inv = await direct();
    expect((await rec.post(`/api/invoices/${inv.id}/payments`, { amountPaisa: 100, paymentModeId: add.body.id }, newKey())).status).toBe(422);
    await md.patch(`/api/invoices/payment-modes/${add.body.id}`, { active: false });
    expect((await rec.post(`/api/invoices/${inv.id}/payments`, { amountPaisa: 100, paymentModeId: add.body.id }, newKey())).status).toBe(422);
  });

  it('refuses a payment when nothing is owed, and on a cancelled invoice', async () => {
    const paid = await direct({ payment: receipt({ amountPaisa: 1_000_000 }) });
    const none = await rec.post(`/api/invoices/${paid.id}/payments`, receipt({ amountPaisa: 100 }), newKey());
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NOTHING_DUE');
    const open = await direct();
    await mgr.post(`/api/invoices/${open.id}/cancel`, { reason: 'Wrong patient' });
    const res = await rec.post(`/api/invoices/${open.id}/payments`, receipt({ amountPaisa: 100 }), newKey());
    expect(res.body.error.code).toBe('INVOICE_CANCELLED');
  });
});

describe('cancelling an invoice', () => {
  it('needs a reason, stores who and when, keeps the row, and leaves it marked in the list', async () => {
    const inv = await direct();
    expect((await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: '' })).status).toBe(422);
    const res = await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Wrong patient' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'VOID', cancelled: true, cancelReason: 'Wrong patient', cancelMoney: 'NONE', balancePaisa: 0, totalPaisa: 1_000_000, cancelBlock: 'ALREADY_CANCELLED' });
    expect(res.body.cancelledByName).toBeTruthy();
    expect(res.body.cancelledAt).toBeTruthy();
    const audit = await lastAudit('INVOICE_CANCELLED', inv.id);
    expect(audit?.reason).toBe('Wrong patient');
    expect((audit?.before as { status: string }).status).toBe('OPEN');
    const list = await rec.get(`/api/invoices?q=${inv.number}`);
    expect(list.body.items[0]).toMatchObject({ id: inv.id, cancelled: true, cancelReason: 'Wrong patient' });
    expect((await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Again please' })).body.error.code).toBe('INVOICE_CANCELLED');
  });

  it('invoices can never be deleted: there is no route, and the database refuses', async () => {
    const inv = await direct();
    expect((await md.delete(`/api/invoices/${inv.id}`)).status).toBe(404);
    await expect(prisma.$executeRaw`DELETE FROM invoices WHERE id = ${inv.id}`).rejects.toThrow(/cannot be deleted/);
  });

  it('REFUND takes the money back out today, by the same method, and the original receipt stays', async () => {
    const inv = await direct({ payment: receipt({ amountPaisa: 400_000 }) });
    const before = await cashDay();
    expect((await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Patient left' })).status).toBe(422); // must choose
    const res = await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Patient left', money: 'REFUND' });
    expect(res.body).toMatchObject({ status: 'VOID', paidPaisa: 0, balancePaisa: 0, cancelMoney: 'REFUNDED' });
    expect(res.body.payments.map((p: { amountPaisa: number; method: string }) => [p.amountPaisa, p.method])).toEqual([[400_000, 'CASH'], [-400_000, 'CASH']]);
    const after = await cashDay();
    expect(after.collections.cashPaisa - before.collections.cashPaisa).toBe(-400_000n);
    expect(after.cash.expectedPaisa - before.cash.expectedPaisa).toBe(-400_000n);
  });

  it('MOVE_TO_ADVANCE keeps the money in the drawer and holds it for the patient', async () => {
    const p = await newPatient();
    const inv = await direct({ payment: receipt({ amountPaisa: 400_000 }) }, p.id);
    const before = await cashDay();
    const res = await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Moved to another plan', money: 'MOVE_TO_ADVANCE' });
    expect(res.body).toMatchObject({ status: 'VOID', paidPaisa: 0, cancelMoney: 'MOVED_TO_ADVANCE', advanceBalancePaisa: 400_000 });
    const after = await cashDay();
    expect(after.collections.totalPaisa).toBe(before.collections.totalPaisa);
    expect(after.cash.expectedPaisa).toBe(before.cash.expectedPaisa);
    const held = await prisma.ledgerEntry.findMany({ where: { account: 'PATIENT_ADVANCE', memo: { contains: inv.number } } });
    expect(held.map((l) => l.amountPaisa)).toEqual([400_000n]);
  });

  it('money that came from an advance always goes back to the advance, even on a refund', async () => {
    const p = await newPatient();
    await rec.post('/api/invoices/advances', { patientId: p.id, amountPaisa: 100_000, paymentModeId: CASH }, newKey());
    const inv = await direct({ useAdvancePaisa: 100_000, payment: receipt({ amountPaisa: 200_000 }) }, p.id);
    const before = await cashDay();
    const res = await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Billing mistake', money: 'REFUND' });
    expect(res.body).toMatchObject({ paidPaisa: 0, cancelMoney: 'REFUNDED', advanceBalancePaisa: 100_000 });
    const after = await cashDay();
    expect(after.cash.expectedPaisa - before.cash.expectedPaisa).toBe(-200_000n);
  });

  it('does not change a day already closed: the reversal lands on today', async () => {
    const inv = await direct({ payment: receipt({ amountPaisa: 100_000 }) });
    const paymentId = inv.payments[0].id;
    await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Correction', money: 'REFUND' });
    const original = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(original.amountPaisa).toBe(100_000n); // never edited
    expect(await prisma.payment.count({ where: { reversesPaymentId: paymentId } })).toBe(1);
  });

  it('a counter sale can only be refunded, and its pharmacy stock comes back', async () => {
    const stock = await rec.post('/api/reception/stock', { kind: 'PHARMACY', name: `Cream ${uid()}`, quantity: 5, pricePaisa: 50_000 }, newKey());
    expect((await mgr.post(`/api/reception/stock-intakes/${stock.body.intakeId}/verify`)).status).toBe(200);
    const itemId = stock.body.itemId as string;
    const sale = await rec.post('/api/reception/counter-sales', { lines: [{ itemId, quantity: 2, unitPricePaisa: 50_000, discount: { type: 'NONE' } }], payments: [{ method: 'CASH', amountPaisa: 100_000 }] }, newKey());
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(await onHand(prisma, itemId)).toBe(3);
    expect((await mgr.post(`/api/invoices/${sale.body.id}/cancel`, { reason: 'Returned', money: 'MOVE_TO_ADVANCE' })).status).toBe(422);
    const res = await mgr.post(`/api/invoices/${sale.body.id}/cancel`, { reason: 'Returned', money: 'REFUND' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await onHand(prisma, itemId)).toBe(5);
  });

  it('is blocked while the visit is active, and allowed after it ends', async () => {
    const p = await newPatient();
    const doctor = await makeUser('DOCTOR');
    const now = new Date();
    const a = await prisma.appointment.create({ data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: now, endAt: new Date(now.getTime() + 1_200_000), status: 'RECEPTION', source: 'RECEPTION', createdById: recUserId } });
    const inv = await prisma.invoice.create({ data: { number: `T-${uid()}`, patientId: p.id, appointmentId: a.id, invoiceDate: now, totalPaisa: 100n, balancePaisa: 100n, createdById: recUserId } });
    const res = await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Mistake here' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VISIT_ACTIVE');
    expect((await rec.get(`/api/invoices/${inv.id}`)).body.cancelBlock).toBe('VISIT_ACTIVE');
    await prisma.appointment.update({ where: { id: a.id }, data: { status: 'DONE' } });
    expect((await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Mistake here' })).status).toBe(200);
  });

  it('a cancelled invoice leaves the outstanding balances', async () => {
    const inv = await direct();
    await mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'No longer owed' });
    const out = await mgr.get('/api/cash/outstanding');
    expect(out.status).toBe(200);
    expect(out.body.items.map((i: { invoiceId: string }) => i.invoiceId)).not.toContain(inv.id);
  });
});

describe('the list', () => {
  it('filters, searches, pages, and shows services as lines with N/A for no tax', async () => {
    const doctor = await makeUser('DOCTOR');
    const p = await newPatient();
    const a = await direct({ doctorId: doctor.id, lines: [{ description: 'First', unitPricePaisa: 100 }, { description: 'Second', unitPricePaisa: 100 }] }, p.id);
    await direct({ doctorId: doctor.id, date: addDaysStr(today(), -40) }, p.id);
    const res = await rec.get(`/api/invoices?doctorId=${doctor.id}`);
    expect(res.body.total).toBe(1); // last 30 days by default
    expect(res.body.from).toBe(addDaysStr(today(), -29));
    expect(res.body.items[0]).toMatchObject({ id: a.id, services: ['First', 'Second'], taxPaisa: null, patient: { id: p.id, name: p.name } });

    const ranged = await rec.get(`/api/invoices?doctorId=${doctor.id}&from=${addDaysStr(today(), -60)}&to=${today()}`);
    expect(ranged.body.total).toBe(2);
    expect((await rec.get(`/api/invoices?doctorId=${doctor.id}&from=${addDaysStr(today(), -60)}&to=${today()}&page=2&pageSize=10`)).body.items).toHaveLength(0);
    expect((await rec.get('/api/invoices?pageSize=7')).status).toBe(422);
    expect((await rec.get(`/api/invoices?from=${today()}&to=${addDaysStr(today(), -1)}`)).status).toBe(422);

    // a search with no dates finds old invoices too
    expect((await rec.get(`/api/invoices?q=${encodeURIComponent(p.name)}`)).body.total).toBe(2);
    expect((await rec.get(`/api/invoices?q=${p.phone.slice(-7)}`)).body.total).toBe(2);
    expect((await rec.get(`/api/invoices?q=${a.number}`)).body.items[0].id).toBe(a.id);
  });

  it('shows visit invoices and counter sales alongside direct ones, with no patient link on a walk-in sale', async () => {
    const stock = await rec.post('/api/reception/stock', { kind: 'PHARMACY', name: `Gel ${uid()}`, quantity: 5, pricePaisa: 50_000 }, newKey());
    await mgr.post(`/api/reception/stock-intakes/${stock.body.intakeId}/verify`);
    const buyer = `Buyer ${uid()}`;
    const sale = await rec.post('/api/reception/counter-sales', { buyerName: buyer, lines: [{ itemId: stock.body.itemId, quantity: 1, unitPricePaisa: 50_000, discount: { type: 'NONE' } }], payments: [{ method: 'CASH', amountPaisa: 50_000 }] }, newKey());
    const res = await rec.get(`/api/invoices?q=${encodeURIComponent(buyer)}`);
    expect(res.body.items[0]).toMatchObject({ id: sale.body.id, kind: 'COUNTER', patient: null, buyerName: buyer });
  });

  it('counts today and this week, leaving out cancelled invoices', async () => {
    const before = (await rec.get('/api/invoices')).body.cards;
    const keep = await direct();
    const gone = await direct();
    await mgr.post(`/api/invoices/${gone.id}/cancel`, { reason: 'Duplicate bill' });
    const after = (await rec.get('/api/invoices')).body.cards;
    expect(after.totalInvoices - before.totalInvoices).toBe(1);
    expect(after.todayInvoices - before.todayInvoices).toBe(1);
    expect(after.weekInvoices - before.weekInvoices).toBe(1);
    expect(keep.id).toBeTruthy();
  });
});

describe('roles: enforced on the server', () => {
  it('Reception works invoices but gets no rupee totals, no cancel, no export, no settings, no history', async () => {
    const inv = await direct();
    const list = await rec.get('/api/invoices');
    expect(list.status).toBe(200);
    expect(list.body.cards).toBeDefined();
    expect(list.body.totals).toBeUndefined();
    expect((await rec.get(`/api/invoices/${inv.id}/print`)).status).toBe(200);
    expect((await rec.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Not allowed' })).status).toBe(403);
    for (const path of ['export.xlsx', 'export.pdf', 'export-all.csv', 'export-all.xlsx', 'settings', 'payment-modes', 'categories', 'audit-log', `${inv.id}/history`]) {
      expect((await rec.get(`/api/invoices/${path}`)).status, path).toBe(403);
    }
    expect((await rec.put('/api/invoices/settings', { taxEnabled: true })).status).toBe(403);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('OPEN');
  });

  it('a refused attempt is audited', async () => {
    const inv = await direct();
    await rec.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Not allowed' });
    const denied = await prisma.auditEvent.findFirst({ where: { action: 'AUTHZ_DENIED', recordId: { contains: 'cancel' } }, orderBy: { createdAt: 'desc' } });
    expect(denied).not.toBeNull();
  });

  it('Manager sees totals, exports and cancels, but has no settings, full export or history', async () => {
    const inv = await direct();
    const list = await mgr.get('/api/invoices');
    expect(list.body.totals.totalPaisa).toBeGreaterThan(0);
    expect(list.body.totals.discountPaisa).toBeDefined();
    expect((await mgr.get('/api/invoices/export.xlsx')).status).toBe(200);
    for (const path of ['export-all.csv', 'settings', 'payment-modes', 'categories', 'audit-log', `${inv.id}/history`]) {
      expect((await mgr.get(`/api/invoices/${path}`)).status, path).toBe(403);
    }
    expect((await mgr.put('/api/invoices/settings', { taxEnabled: true })).status).toBe(403);
    expect((await mgr.post('/api/invoices/payment-modes', { name: 'Nope', method: 'CASH' })).status).toBe(403);
  });

  it('invoice settings are MD only, including through the general Settings route', async () => {
    const before = await prisma.setting.findUnique({ where: { key: 'invoice.numberPrefix' } });
    const manager = await mgr.put('/api/settings/invoice.numberPrefix', { value: 'HACK' });
    expect(manager.status).toBe(403);
    const dev = call((await agentFor('DEVELOPER')).agent);
    expect((await dev.put('/api/settings/clinic.name', { value: 'HACK' })).status).toBe(403);
    expect((await prisma.setting.findUnique({ where: { key: 'invoice.numberPrefix' } }))?.value).toEqual(before?.value);
    const keys = (await mgr.get('/api/settings')).body.items.map((i: { key: string }) => i.key);
    expect(keys).not.toContain('invoice.numberPrefix');
    expect(keys).not.toContain('clinic.name');
    expect((await mgr.put('/api/settings/scheduling.slotStepMin', { value: 10 })).status).toBe(200); // others still work
    expect((await md.get('/api/settings')).body.items.map((i: { key: string }) => i.key)).toContain('invoice.numberPrefix');
  });

  it('MD has everything: settings, modes, categories, full export and history', async () => {
    const inv = await direct();
    for (const path of ['settings', 'payment-modes', 'categories', 'audit-log', 'export-all.csv', 'export-all.xlsx', `${inv.id}/history`]) {
      expect((await md.get(`/api/invoices/${path}`)).status, path).toBe(200);
    }
    const history = await md.get(`/api/invoices/${inv.id}/history`);
    expect(history.body.items[0]).toMatchObject({ action: 'INVOICE_CREATED' });
    expect(history.body.items[0].actorName).toBeTruthy();
    expect(history.body.items[0].after.totalPaisa).toBe(1_000_000);
  });

  it('other roles get nothing, and Office Boy no patient data', async () => {
    const inv = await direct();
    for (const api of [doc, office]) {
      expect((await api.get('/api/invoices')).status).toBe(403);
      expect((await api.get(`/api/invoices/${inv.id}`)).status).toBe(403);
      expect((await api.get('/api/invoices/patients?q=test')).status).toBe(403);
      expect((await api.post('/api/invoices', { patientId: 'x', lines: [] }, newKey())).status).toBe(403);
    }
  });

  it('a disabled account cannot reach invoices, even with a live session', async () => {
    const a = await agentFor('RECEPTIONIST');
    const api = call(a.agent);
    expect((await api.get('/api/invoices')).status).toBe(200);
    await prisma.user.update({ where: { id: a.user.id }, data: { active: false } });
    expect((await api.get('/api/invoices')).status).toBe(401);
  });
});

describe('exports', () => {
  const asFile = (r: { body: unknown }) => r.body as Buffer;
  const binary = (res: { text?: string; body: unknown }, cb: (err: Error | null, data: Buffer) => void) => {
    const chunks: Buffer[] = [];
    (res as unknown as NodeJS.ReadableStream).on('data', (c: Buffer) => chunks.push(c));
    (res as unknown as NodeJS.ReadableStream).on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('Excel contains only the filtered rows, and the export is audited', async () => {
    const p = await newPatient();
    const a = await direct({ discountPaisa: 100_000 }, p.id);
    await direct({ date: addDaysStr(today(), -5) }, p.id);
    const res = await (mgr.get(`/api/invoices/export.xlsx?q=${encodeURIComponent(p.name)}&from=${today()}&to=${today()}`) as unknown as { buffer: (b: boolean) => { parse: (f: typeof binary) => Promise<{ status: number; headers: Record<string, string>; body: unknown }> } }).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(asFile(res) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Invoices')!;
    expect(ws.rowCount).toBe(2);
    const headers = (ws.getRow(1).values as string[]).slice(1);
    const cell = (name: string) => ws.getRow(2).getCell(headers.indexOf(name) + 1).value;
    expect(cell('ID')).toBe(a.number);
    expect(cell('Patient')).toBe(p.name);
    expect(cell('Discount')).toBe(1000);
    expect(cell('Tax')).toBe('N/A');
    expect(cell('Total')).toBe(9000);
    const logged = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'INVOICES_EXPORTED' }, orderBy: { createdAt: 'desc' } });
    expect(logged.after).toMatchObject({ kind: 'xlsx', scope: 'filtered', rows: 1 });
  });

  it('PDF is a real PDF', async () => {
    const p = await newPatient();
    await direct({}, p.id);
    const res = await (mgr.get(`/api/invoices/export.pdf?q=${encodeURIComponent(p.name)}`) as unknown as { buffer: (b: boolean) => { parse: (f: typeof binary) => Promise<{ status: number; body: unknown }> } }).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(asFile(res).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('MD downloads every invoice as CSV, including cancelled and old ones', async () => {
    const old = await direct({ date: '2020-01-15' });
    const gone = await direct();
    await mgr.post(`/api/invoices/${gone.id}/cancel`, { reason: 'Wrong, bill' });
    const res = await md.get('/api/invoices/export-all.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain(old.number);
    expect(res.text).toContain(gone.number);
    expect(res.text).toContain('"Wrong, bill"');
  });
});

describe('payment modes and categories', () => {
  it('MD adds, renames and turns off a mode; what it settles as cannot change; only active ones reach the form', async () => {
    const name = `Mode ${uid()}`;
    const add = await md.post('/api/invoices/payment-modes', { name, method: 'CARD' });
    expect(add.status).toBe(201);
    expect((await md.post('/api/invoices/payment-modes', { name, method: 'CARD' })).status).toBe(409);
    expect((await md.post('/api/invoices/payment-modes', { name: 'Sneaky', method: 'ADVANCE' })).status).toBe(422);
    const renamed = await md.patch(`/api/invoices/payment-modes/${add.body.id}`, { name: `${name} v2`, method: 'CASH' });
    expect(renamed.body).toMatchObject({ name: `${name} v2`, method: 'CARD' });
    expect((await rec.get('/api/invoices/options')).body.paymentModes.map((m: { id: string }) => m.id)).toContain(add.body.id);
    await md.patch(`/api/invoices/payment-modes/${add.body.id}`, { active: false });
    expect((await rec.get('/api/invoices/options')).body.paymentModes.map((m: { id: string }) => m.id)).not.toContain(add.body.id);
    expect(await lastAudit('PAYMENT_MODE_CHANGED', add.body.id)).not.toBeNull();
  });

  it('a category groups services, a rename reaches them, and Reception adding a service keeps them in step', async () => {
    const name = `Cat ${uid()}`;
    const cat = await md.post('/api/invoices/categories', { name });
    expect(cat.status).toBe(201);
    const svcName = `Svc ${uid()}`;
    const added = await rec.post('/api/reception/services', { name: svcName, category: name.toLowerCase() });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const svc = await prisma.service.findUniqueOrThrow({ where: { id: added.body.id } });
    expect(svc.invoiceCategoryId).toBe(cat.body.id); // matched ignoring case

    const renamed = `${name} New`;
    await md.patch(`/api/invoices/categories/${cat.body.id}`, { name: renamed });
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).category).toBe(renamed);

    const options = (await rec.get('/api/invoices/options')).body;
    expect(options.categories.map((c: { id: string }) => c.id)).toContain(cat.body.id);
    expect(options.services.find((s: { id: string }) => s.id === svc.id).invoiceCategoryId).toBe(cat.body.id);

    await md.put(`/api/invoices/services/${svc.id}/category`, { categoryId: 'ic_injection' });
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).category).toBe('Injection');
  });

  it('a service with a new typed category creates it; with none, its type decides', async () => {
    const typed = `New Cat ${uid()}`;
    const a = await rec.post('/api/reception/services', { name: `Svc ${uid()}`, category: typed });
    const svcA = await prisma.service.findUniqueOrThrow({ where: { id: a.body.id }, include: { invoiceCategory: true } });
    expect(svcA.invoiceCategory?.name).toBe(typed);
    const b = await rec.post('/api/reception/services', { name: `Svc ${uid()}` });
    expect((await prisma.service.findUniqueOrThrow({ where: { id: b.body.id } })).invoiceCategoryId).toBe('ic_procedure');
  });
});

describe('invoice settings', () => {
  it('a small logo is stored and reaches the printout; other file types and a huge image are refused', async () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    expect((await md.put('/api/invoices/settings', { logoDataUrl: logo, clinicName: 'Vertex Test Clinic' })).status).toBe(200);
    try {
      const inv = await direct();
      expect((await rec.get(`/api/invoices/${inv.id}/print`)).body.clinic).toEqual({ name: 'Vertex Test Clinic', logoDataUrl: logo });
      expect((await md.put('/api/invoices/settings', { logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status).toBe(422);
      expect((await md.put('/api/invoices/settings', { logoDataUrl: 'javascript:alert(1)' })).status).toBe(422);
      expect((await md.put('/api/invoices/settings', { logoDataUrl: `data:image/png;base64,${'A'.repeat(300_001)}` })).status).toBe(422);
    } finally {
      await md.put('/api/invoices/settings', { logoDataUrl: null, clinicName: 'The Vertex Health' });
    }
  });
});

describe('two desks at the same moment', () => {
  const paymentsTotal = async (invoiceId: string) => (await prisma.payment.aggregate({ where: { invoiceId }, _sum: { amountPaisa: true } }))._sum.amountPaisa;

  it('the invoice API cannot take more than the balance, and receipts match the invoice', async () => {
    const inv = await direct({ lines: [{ description: 'X', unitPricePaisa: 100_000 }] });
    const res = await Promise.all([1, 2, 3].map(() => rec.post(`/api/invoices/${inv.id}/payments`, receipt({ amountPaisa: 100_000 }), newKey())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await paymentsTotal(inv.id)).toBe(100_000n);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ paidPaisa: 100_000n, balancePaisa: 0n });
  });

  it('the existing visit payment route cannot either', async () => {
    const p = await newPatient();
    const doctor = await makeUser('DOCTOR');
    const now = new Date();
    const a = await prisma.appointment.create({ data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: now, endAt: new Date(now.getTime() + 1_200_000), status: 'RECEPTION', source: 'RECEPTION', createdById: recUserId } });
    const inv = await prisma.invoice.create({ data: { number: `T-${uid()}`, patientId: p.id, appointmentId: a.id, invoiceDate: now, totalPaisa: 100_000n, balancePaisa: 100_000n, createdById: recUserId } });
    const res = await Promise.all([1, 2, 3].map(() => rec.post(`/api/reception/invoices/${inv.id}/payments`, { amountPaisa: 100_000, method: 'CASH' }, newKey())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await paymentsTotal(inv.id)).toBe(100_000n);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ paidPaisa: 100_000n, balancePaisa: 0n });
    const ledger = await prisma.ledgerEntry.aggregate({ where: { memo: { contains: inv.number }, account: 'CASH_IN_HAND' }, _sum: { amountPaisa: true } });
    expect(ledger._sum.amountPaisa).toBe(100_000n);
  });

  it('a counter sale cannot sell the last unit twice', async () => {
    const stock = await rec.post('/api/reception/stock', { kind: 'PHARMACY', name: `Last ${uid()}`, quantity: 1, pricePaisa: 1000 }, newKey());
    await mgr.post(`/api/reception/stock-intakes/${stock.body.intakeId}/verify`);
    const res = await Promise.all([1, 2, 3].map(() => rec.post('/api/reception/counter-sales', { lines: [{ itemId: stock.body.itemId, quantity: 1, unitPricePaisa: 1000, discount: { type: 'NONE' } }], payments: [{ method: 'CASH', amountPaisa: 1000 }] }, newKey())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await onHand(prisma, stock.body.itemId)).toBe(0);
  });

  it('cancelling twice at once undoes the money only once', async () => {
    const inv = await direct({ payment: receipt({ amountPaisa: 100_000 }) });
    const res = await Promise.all([1, 2].map(() => mgr.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Double click', money: 'REFUND' })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await paymentsTotal(inv.id)).toBe(0n);
  });
});
