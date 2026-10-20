import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { pharmacyAmounts } from '../../src/modules/reception/pharmacy';
import { onHand } from '../../src/services/stock';
import { agentFor, call, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

/** D-048 — Reception "Stock & batches" (procedure / pharmacy) and pharmacy lines on the invoice. */

let r: { user: { id: string }; api: ReturnType<typeof call> };
let mgr: ReturnType<typeof call>;

beforeAll(async () => {
  const a = await agentFor('RECEPTIONIST');
  r = { user: a.user, api: call(a.agent) };
  mgr = call((await agentFor('MANAGER')).agent);
});

const pname = (p: string) => `${p} ${uid()}`;

async function addProduct(kind: 'PROCEDURE' | 'PHARMACY', name: string, quantity: number, pricePaisa: number, extra: Record<string, unknown> = {}) {
  const res = await r.api.post('/api/reception/stock', { kind, name, quantity, pricePaisa, ...extra }, newKey());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  // the Manager verifies Reception's stock-in (D-052)
  expect((await mgr.post(`/api/reception/stock-intakes/${res.body.intakeId}/verify`)).status).toBe(200);
  return res.body as { itemId: string; intakeId: string };
}

/** A visit at Reception with an open invoice. */
async function openInvoice(withPrescription = true) {
  const doctor = await makeUser('DOCTOR');
  const p = await prisma.patient.create({ data: { name: 'Pharmacy Patient', phone: normalizePhone(uniquePhone())!, createdById: r.user.id } });
  const now = new Date();
  const a = await prisma.appointment.create({ data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: now, endAt: new Date(now.getTime() + 1_200_000), status: 'RECEPTION', source: 'RECEPTION', createdById: r.user.id } });
  const inv = (await r.api.post(`/api/reception/appointments/${a.id}/invoice`)).body as { id: string };
  if (withPrescription) await r.api.post('/api/files/dev-upload', { route: 'prescriptionPhoto', recordType: 'Invoice', recordId: inv.id, fileName: 'rx.jpg', mime: 'image/jpeg', size: 1000 });
  return inv.id;
}

describe('D-048 — Reception Stock & batches: two categories, add with name / qty / price', () => {
  it('adds procedure and pharmacy products; adding the same name again adds stock; categories stay separate', async () => {
    const gloves = pname('Gloves');
    const panadol = pname('Panadol');
    const g = await addProduct('PROCEDURE', gloves, 100, 1500, { unit: 'piece' });
    await addProduct('PROCEDURE', gloves, 50, 1600);
    await addProduct('PHARMACY', panadol, 20, 5000, { expiryDate: '2030-01-31' });
    await addProduct('PHARMACY', panadol, 10, 5500); // new selling price

    const proc = (await r.api.get('/api/reception/stock?kind=PROCEDURE')).body.items.find((i: { name: string }) => i.name === gloves);
    expect(proc).toMatchObject({ onHand: 150, usable: 150, pricePaisa: 1600 });
    const ph = (await r.api.get('/api/reception/stock?kind=PHARMACY')).body.items.find((i: { name: string }) => i.name === panadol);
    expect(ph).toMatchObject({ onHand: 30, pricePaisa: 5500, nextExpiry: '2030-01-31' });
    expect((await r.api.get('/api/reception/stock?kind=PHARMACY')).body.items.some((i: { name: string }) => i.name === gloves)).toBe(false);

    // same name in the other category is refused
    expect((await r.api.post('/api/reception/stock', { kind: 'PHARMACY', name: gloves, quantity: 1, pricePaisa: 1 }, newKey())).status).toBe(409);
    // ledger-derived, stock-in rows, audited, retry-safe
    const key = newKey();
    const once = await r.api.post('/api/reception/stock', { kind: 'PROCEDURE', name: gloves, quantity: 5, pricePaisa: 1600 }, key);
    const twice = await r.api.post('/api/reception/stock', { kind: 'PROCEDURE', name: gloves, quantity: 5, pricePaisa: 1600 }, key);
    expect(twice.body.intakeId).toBe(once.body.intakeId);
    await mgr.post(`/api/reception/stock-intakes/${once.body.intakeId}/verify`);
    expect(await onHand(prisma, g.itemId)).toBe(155);
    expect(await prisma.stockTransaction.count({ where: { itemId: g.itemId, type: 'STOCK_IN' } })).toBe(3);
    // procedure products only in the Assistant's usage list
    const asst = call((await agentFor('ASSISTANT')).agent);
    const usage = await asst.get('/api/assistant/stock');
    if (usage.status === 200) expect(JSON.stringify(usage.body)).not.toContain(panadol);
  });

  it('only Reception (and not Doctor / Assistant / Lead) can open Stock & batches', async () => {
    for (const role of ['DOCTOR', 'ASSISTANT', 'LEAD_MEMBER', 'OFFICE_BOY'] as const) {
      expect((await call((await agentFor(role)).agent).get('/api/reception/stock?kind=PHARMACY')).status).toBe(403);
    }
  });
});

describe('D-048 — pharmacy on the invoice after the prescription photo', () => {
  it('amounts: percent and fixed discounts in whole paisa', () => {
    expect(pharmacyAmounts(5000n, 3, { type: 'NONE' })).toMatchObject({ gross: 15000n, discount: 0n, net: 15000n });
    expect(pharmacyAmounts(5000n, 3, { type: 'PERCENT', percent: 10 })).toMatchObject({ discount: 1500n, net: 13500n, percentBp: 1000 });
    expect(pharmacyAmounts(3333n, 1, { type: 'PERCENT', percent: 12.5 })).toMatchObject({ discount: 417n }); // rounded
    expect(pharmacyAmounts(5000n, 2, { type: 'FIXED', amountPaisa: 2000 })).toMatchObject({ discount: 2000n, net: 8000n });
    expect(() => pharmacyAmounts(5000n, 1, { type: 'FIXED', amountPaisa: 6000 })).toThrow();
    expect(() => pharmacyAmounts(5000n, 1, { type: 'PERCENT', percent: 101 })).toThrow();
  });

  it('needs the prescription first; adds lines with discount, deducts stock, raises the balance; retry-safe', async () => {
    const name = pname('Sunblock');
    const { itemId } = await addProduct('PHARMACY', name, 10, 120000);
    const noRx = await openInvoice(false);
    const blocked = await r.api.post(`/api/reception/invoices/${noRx}/pharmacy`, { itemId, quantity: 1, unitPricePaisa: 120000, discount: { type: 'NONE' } }, newKey());
    expect(blocked.status).toBe(423);

    const invId = await openInvoice();
    const before = (await r.api.get(`/api/reception/invoices/${invId}`)).body;
    const opts = await r.api.get('/api/reception/pharmacy/products');
    expect(opts.body.items.find((i: { id: string }) => i.id === itemId)).toMatchObject({ usable: 10, salePricePaisa: 120000 });
    expect(JSON.stringify(opts.body)).not.toMatch(/unitCost/);

    const key = newKey();
    const add = await r.api.post(`/api/reception/invoices/${invId}/pharmacy`, { itemId, quantity: 2, unitPricePaisa: 120000, discount: { type: 'PERCENT', percent: 10 } }, key);
    expect(add.status).toBe(201);
    expect(add.body.line).toMatchObject({ description: `Pharmacy: ${name}`, quantity: 2, discountPaisa: 24000, lineTotalPaisa: 216000, discountPercentBp: 1000 });
    const again = await r.api.post(`/api/reception/invoices/${invId}/pharmacy`, { itemId, quantity: 2, unitPricePaisa: 120000, discount: { type: 'PERCENT', percent: 10 } }, key);
    expect(again.body.line.id).toBe(add.body.line.id); // retry returns the same line, nothing added twice
    await r.api.post(`/api/reception/invoices/${invId}/pharmacy`, { itemId, quantity: 1, unitPricePaisa: 110000, discount: { type: 'FIXED', amountPaisa: 10000 } }, newKey());

    const after = (await r.api.get(`/api/reception/invoices/${invId}`)).body;
    expect(after.totalPaisa - before.totalPaisa).toBe(216000 + 100000);
    expect(after.balancePaisa - before.balancePaisa).toBe(316000);
    expect(after.discountPaisa - before.discountPaisa).toBe(34000);
    expect(await onHand(prisma, itemId)).toBe(7);
    expect(await prisma.stockTransaction.count({ where: { itemId, type: 'SALE' } })).toBe(2);

    // not more than in stock
    const tooMany = await r.api.post(`/api/reception/invoices/${invId}/pharmacy`, { itemId, quantity: 50, unitPricePaisa: 120000, discount: { type: 'NONE' } }, newKey());
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.message).toContain('stock');
    // procedure products cannot be sold
    const proc = await addProduct('PROCEDURE', pname('Needle'), 10, 100);
    expect((await r.api.post(`/api/reception/invoices/${invId}/pharmacy`, { itemId: proc.itemId, quantity: 1, unitPricePaisa: 100, discount: { type: 'NONE' } }, newKey())).status).toBe(422);
  });

  it('a mistaken line is reversed (append-only): stock back, totals down, once; not after it is paid', async () => {
    const { itemId } = await addProduct('PHARMACY', pname('Serum'), 5, 300000);
    const invId = await openInvoice();
    const before = (await r.api.get(`/api/reception/invoices/${invId}`)).body;
    const line = (await r.api.post(`/api/reception/invoices/${invId}/pharmacy`, { itemId, quantity: 2, unitPricePaisa: 300000, discount: { type: 'NONE' } }, newKey())).body.line;
    const rev = await r.api.post(`/api/reception/invoices/${invId}/pharmacy/${line.id}/reverse`, { reason: 'Ghalat product' });
    expect(rev.status).toBe(200);
    expect(rev.body.reversal).toMatchObject({ quantity: -2, lineTotalPaisa: -600000, reversesLineId: line.id });
    const after = (await r.api.get(`/api/reception/invoices/${invId}`)).body;
    expect(after.totalPaisa).toBe(before.totalPaisa);
    expect(after.lines.find((l: { id: string }) => l.id === line.id).reversed).toBe(true);
    expect(await onHand(prisma, itemId)).toBe(5);
    expect((await r.api.post(`/api/reception/invoices/${invId}/pharmacy/${line.id}/reverse`, { reason: 'again' })).status).toBe(409);

    // paid → cannot reverse
    const l2 = (await r.api.post(`/api/reception/invoices/${invId}/pharmacy`, { itemId, quantity: 1, unitPricePaisa: 300000, discount: { type: 'NONE' } }, newKey())).body.line;
    const bal = (await r.api.get(`/api/reception/invoices/${invId}`)).body.balancePaisa;
    expect((await r.api.post(`/api/reception/invoices/${invId}/payments`, { amountPaisa: bal, method: 'CASH' }, newKey())).status).toBe(201);
    expect((await r.api.post(`/api/reception/invoices/${invId}/pharmacy/${l2.id}/reverse`, { reason: 'late' })).status).toBe(409);
  });
});

describe('D-052 — Reception adds stock, the Manager verifies it', () => {
  it('pending stock is neither usable nor sellable; verify brings it in; reject keeps it out and tells Reception', async () => {
    const name = pname('Toner');
    const add = await r.api.post('/api/reception/stock', { kind: 'PHARMACY', name, quantity: 12, pricePaisa: 90000 }, newKey());
    expect(add.body.status).toBe('PENDING');
    const row = () => r.api.get('/api/reception/stock?kind=PHARMACY').then((x) => x.body.items.find((i: { name: string }) => i.name === name));
    expect(await row()).toMatchObject({ onHand: 0, usable: 0, pendingQty: 12, pricePaisa: null });
    expect((await r.api.get('/api/reception/pharmacy/products')).body.items.find((i: { id: string }) => i.id === add.body.itemId)?.usable ?? 0).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'STOCK_INTAKE_PENDING', recordId: add.body.intakeId } })).toBeGreaterThan(0);

    // only the Manager decides; Reception cannot verify its own entry
    expect((await r.api.post(`/api/reception/stock-intakes/${add.body.intakeId}/verify`)).status).toBe(403);
    const pending = (await mgr.get('/api/reception/stock-intakes?scope=pending')).body.items.find((i: { id: string }) => i.id === add.body.intakeId);
    expect(pending).toMatchObject({ name, quantity: 12, pricePaisa: 90000, status: 'PENDING' });
    expect((await mgr.post(`/api/reception/stock-intakes/${add.body.intakeId}/verify`)).status).toBe(200);
    expect(await row()).toMatchObject({ onHand: 12, usable: 12, pendingQty: 0, pricePaisa: 90000 });
    expect((await mgr.post(`/api/reception/stock-intakes/${add.body.intakeId}/verify`)).status).toBe(409); // once

    const more = await r.api.post('/api/reception/stock', { kind: 'PHARMACY', name, quantity: 100, pricePaisa: 95000 }, newKey());
    expect((await mgr.post(`/api/reception/stock-intakes/${more.body.intakeId}/reject`, { reason: 'Bill par 10 likha hai, 100 nahi' })).status).toBe(200);
    expect(await row()).toMatchObject({ onHand: 12, pendingQty: 0, pricePaisa: 90000 }); // nothing changed
    const told = await prisma.notification.findFirstOrThrow({ where: { recipientId: r.user.id, type: 'STOCK_INTAKE_REJECTED', recordId: more.body.intakeId } });
    expect(told.body).toContain('10 likha');
    expect((await r.api.get('/api/reception/stock-intakes?scope=recent')).body.items.find((i: { id: string }) => i.id === more.body.intakeId)).toMatchObject({ status: 'REJECTED', reason: 'Bill par 10 likha hai, 100 nahi' });
    for (const role of ['DOCTOR', 'ASSISTANT'] as const) expect((await call((await agentFor(role)).agent).get('/api/reception/stock-intakes')).status).toBe(403);
  });
});
