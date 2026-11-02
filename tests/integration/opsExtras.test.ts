import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { clinicDateStr } from '../../src/lib/time';
import { agentFor, call, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

/** D-090 — the rest of the client's demo. Whatever would change live work stays off until it is set. */
let rec: ReturnType<typeof call>;
let mgr: ReturnType<typeof call>;
let md: ReturnType<typeof call>;
let recId: string;
const month = clinicDateStr(new Date()).slice(0, 7);

const setting = (key: string, value: unknown) => md.put(`/api/settings/${key}`, { value, confirm: true });

async function patient(consent = true) {
  return prisma.patient.create({ data: { name: `Extra ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: recId, whatsappConsent: consent } });
}
async function invoice(amount: number, paid = 0) {
  const p = await patient();
  const res = await rec.post('/api/invoices', { patientId: p.id, lines: [{ description: 'Service', unitPricePaisa: amount }], ...(paid ? { payment: { amountPaisa: paid, paymentModeId: 'pm_cash' } } : {}) }, newKey());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: string };
}

beforeAll(async () => {
  const r = await agentFor('RECEPTIONIST');
  rec = call(r.agent);
  recId = r.user.id;
  mgr = call((await agentFor('MANAGER')).agent);
  md = call((await agentFor('MD')).agent);
});

describe('D-090 bill correction', () => {
  it('changes the bill with a new line; it cannot go below what was paid; the Doctor has no say', async () => {
    const inv = await invoice(1_000_000, 400_000);
    const r = await rec.post('/api/ops/invoice-requests', { type: 'BILL_CORRECTION', invoiceId: inv.id, note: 'Price ghalat likhi' });
    expect((await mgr.post(`/api/ops/invoice-requests/${r.body.id}/decide`, { approve: true, adjustmentPaisa: -700_000 })).status).toBe(422);
    const ok = await mgr.post(`/api/ops/invoice-requests/${r.body.id}/decide`, { approve: true, adjustmentPaisa: -200_000 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
    expect(after).toMatchObject({ totalPaisa: 800_000n, paidPaisa: 400_000n, balancePaisa: 400_000n });
    expect(after.lines.reduce((s, l) => s + l.lineTotalPaisa, 0n)).toBe(800_000n);
  });
});

describe('D-090 vendor payments', () => {
  it('Manager asks, an owner approves, it is paid once; with the setting on, the direct route is closed', async () => {
    const vendor = await prisma.vendor.create({ data: { name: `Vendor ${uid()}` } });
    const r = await mgr.post('/api/ops/vendor-payments', { vendorId: vendor.id, amountPaisa: 500_000, note: 'Invoice 221' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await mgr.post(`/api/ops/vendor-payments/${r.body.id}/record`, { method: 'CASH' })).status).toBe(409);
    expect((await mgr.post(`/api/ops/vendor-payments/${r.body.id}/decide`, { approve: true })).status).toBe(403);
    expect((await md.post(`/api/ops/vendor-payments/${r.body.id}/decide`, { approve: true })).status).toBe(200);
    expect((await mgr.post(`/api/ops/vendor-payments/${r.body.id}/record`, { method: 'CASH' })).status).toBe(200);
    expect((await mgr.post(`/api/ops/vendor-payments/${r.body.id}/record`, { method: 'CASH' })).status).toBe(409);
    expect(await prisma.supplierPayment.count({ where: { vendorId: vendor.id } })).toBe(1);

    expect((await mgr.post(`/api/inventory/vendors/${vendor.id}/payments`, { amountPaisa: 100, method: 'CASH' }, newKey())).status).toBe(201);
    expect((await setting('vendor.requirePaymentApproval', true)).status).toBe(200);
    try {
      expect((await mgr.post(`/api/inventory/vendors/${vendor.id}/payments`, { amountPaisa: 100, method: 'CASH' }, newKey())).status).toBe(409);
    } finally {
      await setting('vendor.requirePaymentApproval', false);
    }
  });
});

describe('D-090 messages', () => {
  it('payment message goes to the outbox when the patient agreed; login message never holds a password', async () => {
    const inv = await invoice(100_000);
    const sent = await rec.post(`/api/ops/invoices/${inv.id}/payment-message`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: sent.body.messageId } })).template).toBe('payment_request');

    const p = await patient(false);
    const no = await rec.post('/api/invoices', { patientId: p.id, lines: [{ description: 'S', unitPricePaisa: 100 }] }, newKey());
    expect((await rec.post(`/api/ops/invoices/${no.body.id}/payment-message`)).status).toBe(409);

    const staff = await makeUser('ASSISTANT');
    await prisma.user.update({ where: { id: staff.id }, data: { phone: normalizePhone(uniquePhone())! } });
    const login = await md.post(`/api/ops/staff/${staff.id}/send-login`);
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const m = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: login.body.messageId } });
    expect(JSON.stringify(m.payload)).not.toMatch(/password/i);
    expect((await rec.post(`/api/ops/staff/${staff.id}/send-login`)).status).toBe(403);
  });
});

describe('D-090 lowest price', () => {
  it('no limit until it is set; then a counter sale below it is refused', async () => {
    const item = await prisma.stockItem.create({ data: { name: `Serum ${uid()}`, category: 'Test', baseUnit: 'piece', kind: 'PHARMACY', minQty: 0, salePricePaisa: 100_000n } });
    const batch = await prisma.stockBatch.create({ data: { itemId: item.id, lotNo: uid(), status: 'AVAILABLE' } });
    await prisma.stockTransaction.create({ data: { itemId: item.id, batchId: batch.id, type: 'STOCK_IN', quantity: 10, actorId: recId } });
    const sale = (price: number) => rec.post('/api/reception/counter-sales', { buyerName: 'Walk-in', lines: [{ itemId: item.id, quantity: 1, unitPricePaisa: price, discount: { type: 'NONE' } }], payments: [{ method: 'CASH', amountPaisa: price }] }, newKey());
    const first = await sale(50_000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await md.put(`/api/ops/products/${item.id}/floor-price`, { floorPaisa: 200_000 })).status).toBe(422);
    expect((await md.put(`/api/ops/products/${item.id}/floor-price`, { floorPaisa: 80_000 })).status).toBe(200);
    expect((await mgr.put(`/api/ops/products/${item.id}/floor-price`, { floorPaisa: 1 })).status).toBe(403);
    expect((await sale(70_000)).status).toBe(422);
    expect((await sale(80_000)).status).toBe(201);
  });
});

describe('D-090 tax on non-cash payments', () => {
  it('uses the non-cash rate only when one is set and the first payment is not cash', async () => {
    await md.put('/api/invoices/settings', { taxEnabled: true, taxBasisPoints: 1600, taxCardBasisPoints: 500 });
    try {
      const p = await patient();
      const card = await prisma.paymentMode.findFirstOrThrow({ where: { method: 'CARD' } });
      const bank = await prisma.bankAccount.create({ data: { name: `Bank ${uid()}`, bankName: 'HBL', accountNo: uid() } });
      const paidCard = await rec.post('/api/invoices', { patientId: p.id, confirmOpenVisit: true, lines: [{ description: 'S', unitPricePaisa: 1_050_000 }], payment: { amountPaisa: 100, paymentModeId: card.id, bankAccountId: bank.id } }, newKey());
      expect(paidCard.status, JSON.stringify(paidCard.body)).toBe(201);
      expect(paidCard.body).toMatchObject({ taxRateBp: 500, taxPaisa: 50_000, totalPaisa: 1_050_000 });
      const paidCash = await rec.post('/api/invoices', { patientId: p.id, confirmOpenVisit: true, lines: [{ description: 'S', unitPricePaisa: 1_160_000 }], payment: { amountPaisa: 100, paymentModeId: 'pm_cash' } }, newKey());
      expect(paidCash.body).toMatchObject({ taxRateBp: 1600, taxPaisa: 160_000 });
    } finally {
      await md.put('/api/invoices/settings', { taxEnabled: false, taxBasisPoints: 0, taxCardBasisPoints: null });
    }
  });
});

describe('D-090 departments', () => {
  it('a doctor with departments is offered theirs and services with none; without departments, everything', async () => {
    const doctor = await makeUser('DOCTOR');
    const dep = await prisma.service.create({ data: { name: `Dental ${uid()}`, type: 'PROCEDURE', durationMin: 20, defaultPricePaisa: 100n, department: 'Dental' } });
    const other = await prisma.service.create({ data: { name: `ENT ${uid()}`, type: 'PROCEDURE', durationMin: 20, defaultPricePaisa: 100n, department: 'ENT' } });
    const ids = async () => (await rec.get(`/api/scheduling/services?doctorId=${doctor.id}`)).body.items.map((s: { id: string }) => s.id);
    expect(await ids()).toEqual(expect.arrayContaining([dep.id, other.id]));
    expect((await mgr.put(`/api/ops/departments/doctors/${doctor.id}`, { departments: ['Dental'] })).status).toBe(200);
    const after = await ids();
    expect(after).toContain(dep.id);
    expect(after).not.toContain(other.id);
  });
});

describe('D-090 limited access outside', () => {
  const on = (role: 'RECEPTIONIST') => agentFor(role);
  afterAll(async () => {
    await setting('geofence.outsideLimitedAccess', false);
  });

  it('off by default; outside, the setting opens Chat but not the rest', async () => {
    const u = await on('RECEPTIONIST');
    await prisma.user.update({ where: { id: u.user.id }, data: { geofenceRequired: true } });
    const api = call(u.agent);
    await prisma.geofenceConfig.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    try {
      expect((await api.get('/api/ops/chat/rooms')).body.error?.code).toBe('GEOFENCE_REQUIRED');
      await setting('geofence.outsideLimitedAccess', true);
      expect((await api.get('/api/ops/chat/rooms')).status).toBe(200);
      expect((await api.get('/api/invoices')).body.error?.code).toBe('GEOFENCE_REQUIRED');
    } finally {
      await prisma.geofenceConfig.updateMany({ data: { enabled: false } });
      await prisma.user.update({ where: { id: u.user.id }, data: { geofenceRequired: false } });
    }
  });
});

describe('D-090 payroll, feedback', () => {
  it('a bonus adds to the net; warnings and points are counted', async () => {
    const staff = await makeUser('OFFICE_BOY');
    await md.put(`/api/ops/staff/${staff.id}`, { salaryPaisa: 1_000_000 });
    await mgr.post(`/api/ops/staff/${staff.id}/marks`, { month, kind: 'WARNING', note: 'Late' });
    await md.post(`/api/ops/staff/${staff.id}/marks`, { month, kind: 'POINTS', points: 4 });
    const list = await md.get(`/api/ops/staff?month=${month}`);
    expect(list.body.items.find((x: { id: string }) => x.id === staff.id)).toMatchObject({ warnings: 1, points: 4 });
    expect((await md.post(`/api/ops/staff/${staff.id}/pay`, { month, advanceCutPaisa: 0, bonusPaisa: 50_000 })).body).toMatchObject({ bonusPaisa: 50_000, netPaisa: 1_050_000 });
  });

  it('the feedback report averages by person and hides nothing behind the owners-only gate', async () => {
    const res = await md.get(`/api/ops/feedback-report?month=${month}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.overall.map((o: { name: string }) => o.name)).toEqual(['Staff', 'Clinic', 'Reception', 'Manager']);
    expect((await rec.get('/api/ops/feedback-report')).status).toBe(403);
  });
});
