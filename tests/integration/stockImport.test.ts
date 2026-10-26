import { beforeAll, describe, expect, it } from 'vitest';
import { onHand } from '../../src/services/stock';
import { agentFor, call, prisma, uid } from './helpers';

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
    expect(gloves).toMatchObject({ kind: 'PROCEDURE', code: `P-${t}-1`, category: 'Consumables', department: 'Derma', procedureUse: 'Hydrafacial; PRP', baseUnit: 'piece', packUnit: 'box', packSize: 100, sterile: true, note: 'Medium size' });
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
});
