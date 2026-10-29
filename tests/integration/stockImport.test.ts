import { beforeAll, describe, expect, it } from 'vitest';
import { onHand } from '../../src/services/stock';
import { agentFor, call, newKey, prisma, uid } from './helpers';

/** D-055 — developer uploads a CSV of procedure products or pharmacy products (with batches). */

let dev: ReturnType<typeof call>;
beforeAll(async () => {
  dev = call((await agentFor('DEVELOPER')).agent);
});

const PROC_HEADER = 'Item ID,Stock Category,Department,Procedure / Use,Product or Supply,Inventory Unit,Purchase Unit,Units per Purchase Pack,Item Type,Sterile,Stock / Selection Note';
const PHARM_HEADER = 'Batch No,Name,Distributor,Purchase Price,Selling Price,Stock Unit,Quantity,Total Purchase Price,Total Selling Price,Expiration Date';

describe('D-055 — stock CSV import', () => {
  it('procedure catalogue: preview writes nothing; import creates; the same supply in two procedures is one product; re-import changes nothing', async () => {
    const t = uid();
    const csv = [
      PROC_HEADER,
      `P-${t}-1,Consumables,Derma,Hydrafacial,Gloves ${t},piece,box,100,Disposable,Yes,Medium size`,
      `P-${t}-2,Consumables,Derma,PRP,Gloves ${t},piece,box,100,Disposable,Yes,`,
      `P-${t}-3,Injectables,Aesthetics,Botox,Syringe ${t},piece,pack,10,Disposable,No,`,
    ].join('\n');
    const preview = await dev.post('/api/developer/stock-import', { kind: 'PROCEDURE', csv, dryRun: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.products).toEqual({ new: 2, updated: 0, same: 0 });
    expect(await prisma.stockItem.count({ where: { name: `Gloves ${t}` } })).toBe(0);

    const run = await dev.post('/api/developer/stock-import', { kind: 'PROCEDURE', csv, fileName: 'proc.csv', dryRun: false });
    expect(run.status).toBe(200);
    const gloves = await prisma.stockItem.findUniqueOrThrow({ where: { name: `Gloves ${t}` } });
    // the file's Item ID is ignored; the app gives the next numbers in its sequence (D-069)
    expect(gloves.code).toMatch(/^P-\d{4,}$/);
    const syringe = await prisma.stockItem.findUniqueOrThrow({ where: { name: `Syringe ${t}` } });
    expect(Number(syringe.code!.slice(2))).toBe(Number(gloves.code!.slice(2)) + 1);
    expect(gloves).toMatchObject({ kind: 'PROCEDURE', category: 'Consumables', department: 'Derma', procedureUse: 'Hydrafacial; PRP', baseUnit: 'piece', packUnit: 'box', packSize: 100, sterile: true, note: 'Medium size' });
    expect(await prisma.auditEvent.count({ where: { action: 'STOCK_CSV_IMPORTED', after: { path: '$.fileName', equals: 'proc.csv' } } })).toBeGreaterThan(0);

    const again = await dev.post('/api/developer/stock-import', { kind: 'PROCEDURE', csv, dryRun: false });
    expect(again.body.products).toEqual({ new: 0, updated: 0, same: 2 });

    const edited = csv.replace('Botox', 'Botox;Filler');
    expect((await dev.post('/api/developer/stock-import', { kind: 'PROCEDURE', csv: edited, dryRun: false })).body.products.updated).toBe(1);
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { name: `Syringe ${t}` } })).procedureUse).toBe('Botox; Filler');
  });

  it('pharmacy: products, distributors, batches and opening stock; re-upload adds no stock twice', async () => {
    const t = uid();
    const csv = [
      PHARM_HEADER,
      `B1-${t},Panadol ${t},Dist ${t},100,150,box,10,1000,1500,31/12/2030`,
      `B2-${t},Panadol ${t},Dist ${t},110,160,box,5,550,800,2031-06-30`,
      `,Sunblock ${t},,900,1200,tube,3,,,`,
      `X,Broken ${t},,abc,1,box,1,,,`,
    ].join('\n');
    const preview = await dev.post('/api/developer/stock-import', { kind: 'PHARMACY', csv, dryRun: true });
    expect(preview.body).toMatchObject({ products: { new: 2 }, batches: { new: 3, existing: 0 }, vendorsNew: 1, quantityIn: 18 });
    expect(preview.body.errors).toEqual([{ row: 5, message: expect.stringContaining('Purchase Price') }]);

    expect((await dev.post('/api/developer/stock-import', { kind: 'PHARMACY', csv, dryRun: false })).status).toBe(200);
    const pan = await prisma.stockItem.findUniqueOrThrow({ where: { name: `Panadol ${t}` } });
    expect(pan).toMatchObject({ kind: 'PHARMACY', baseUnit: 'box', salePricePaisa: 16_000n });
    expect(await onHand(prisma, pan.id)).toBe(15);
    const b1 = await prisma.stockBatch.findUniqueOrThrow({ where: { itemId_lotNo: { itemId: pan.id, lotNo: `B1-${t}` } } });
    expect(b1.unitCostPaisa).toBe(10_000n);
    expect(b1.vendorId).toBe((await prisma.vendor.findUniqueOrThrow({ where: { name: `Dist ${t}` } })).id);
    const sun = await prisma.stockItem.findUniqueOrThrow({ where: { name: `Sunblock ${t}` } });
    expect(await onHand(prisma, sun.id)).toBe(3);

    const again = await dev.post('/api/developer/stock-import', { kind: 'PHARMACY', csv, dryRun: false });
    expect(again.body).toMatchObject({ batches: { new: 0, existing: 3 }, vendorsNew: 0, quantityIn: 0 });
    expect(await onHand(prisma, pan.id)).toBe(15);
    expect(await onHand(prisma, sun.id)).toBe(3);

    // the pharmacy product shows in Reception's pharmacy list
    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const list = await rec.get('/api/reception/stock?kind=PHARMACY');
    expect(list.body.items.find((i: { name: string }) => i.name === `Panadol ${t}`)).toMatchObject({ onHand: 15 });
  });

  it('a name in the other category is refused; missing headers are named; only the developer may import', async () => {
    const t = uid();
    await dev.post('/api/developer/stock-import', { kind: 'PROCEDURE', csv: `${PROC_HEADER}\n,,,,Cream ${t},tube,,,,,`, dryRun: false });
    const r = await dev.post('/api/developer/stock-import', { kind: 'PHARMACY', csv: `${PHARM_HEADER}\nB,Cream ${t},,1,1,tube,1,,,`, dryRun: true });
    expect(r.body.errors[0].message).toContain('Procedure product');
    const bad = await dev.post('/api/developer/stock-import', { kind: 'PHARMACY', csv: 'Name,Qty\nA,1', dryRun: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message ?? JSON.stringify(bad.body)).toContain('Quantity');
    for (const role of ['MANAGER', 'RECEPTIONIST', 'MD'] as const) {
      expect((await call((await agentFor(role)).agent).post('/api/developer/stock-import', { kind: 'PHARMACY', csv: PHARM_HEADER, dryRun: true })).status).toBe(403);
    }
  });

  it('D-057 — Reception adds with the CSV columns; the lists return them; the pharmacy batch keeps its number and distributor', async () => {
    const t = uid();
    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const mgr = call((await agentFor('MANAGER')).agent);
    const details = { procedureUse: 'PRP', packSize: 50, note: 'Small' };
    const only = await rec.post('/api/reception/stock', { kind: 'PROCEDURE', name: `Needle ${t}`, quantity: 0, pricePaisa: 0, unit: 'piece', details }, newKey());
    expect(only.status, JSON.stringify(only.body)).toBe(201);
    expect(only.body.intakeId).toBeNull();
    const proc = await rec.get('/api/reception/stock?kind=PROCEDURE');
    expect(proc.body.items.find((i: { name: string }) => i.name === `Needle ${t}`)).toMatchObject({ ...details, code: expect.stringMatching(/^P-\d{4,}$/), unit: 'piece', onHand: 0, low: false });
    // D-069 — a typed Item ID is ignored; the next product gets the next number
    const next = await rec.post('/api/reception/stock', { kind: 'PROCEDURE', name: `Needle B ${t}`, quantity: 0, pricePaisa: 0, details: { code: 'MINE-1' } }, newKey());
    expect(next.status).toBe(201);
    const [a, b] = await Promise.all([`Needle ${t}`, `Needle B ${t}`].map((name) => prisma.stockItem.findUniqueOrThrow({ where: { name } })));
    expect(Number(b.code!.slice(2))).toBe(Number(a.code!.slice(2)) + 1);

    const add = await rec.post('/api/reception/stock', { kind: 'PHARMACY', name: `Serum ${t}`, quantity: 4, pricePaisa: 250_000, costPaisa: 150_000, lotNo: `LOT-${t}`, distributor: `Dist ${t}`, unit: 'bottle', expiryDate: '2031-01-31' }, newKey());
    expect(add.status).toBe(201);
    expect((await mgr.post(`/api/reception/stock-intakes/${add.body.intakeId}/verify`)).status).toBe(200);
    const ph = await rec.get('/api/reception/stock?kind=PHARMACY');
    expect(ph.body.items.find((i: { name: string }) => i.name === `Serum ${t}`)).toMatchObject({
      salePricePaisa: 250_000,
      batches: [{ lotNo: `LOT-${t}`, distributor: `Dist ${t}`, costPaisa: 150_000, quantity: 4, expiryDate: '2031-01-31' }],
    });
  });

  it('D-058 — Reception edits any column, clears one, deletes (hides) and brings back a product', async () => {
    const t = uid();
    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const made = await rec.post('/api/reception/stock', { kind: 'PROCEDURE', name: `Cannula ${t}`, quantity: 0, pricePaisa: 0, details: { note: 'old' } }, newKey());
    const id = made.body.itemId as string;
    const edit = await rec.patch(`/api/reception/stock/${id}`, { name: `Cannula 25G ${t}`, unit: 'piece', minQty: 3, details: { procedureUse: 'PRP', packSize: 20, note: null } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(await prisma.stockItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: `Cannula 25G ${t}`, code: expect.stringMatching(/^P-\d{4,}$/), procedureUse: 'PRP', packSize: 20, note: null, minQty: 3 });

    expect((await rec.patch(`/api/reception/stock/${id}`, { active: false })).status).toBe(200);
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id } })).active).toBe(false);
    expect(await prisma.auditEvent.count({ where: { action: 'STOCK_ITEM_REMOVED', recordId: id } })).toBe(1);
    expect((await rec.patch(`/api/reception/stock/${id}`, { active: true })).status).toBe(200);
    expect(await prisma.stockItem.findUnique({ where: { id } })).not.toBeNull(); // never hard-deleted
  });
});
