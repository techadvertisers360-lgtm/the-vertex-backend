import type { Prisma, StockItem } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ValidationError } from '../../lib/errors';
import { sha256 } from '../../lib/misc';
import { clinicDateStr, dateOnly } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { nextItemCodes } from '../../services/stock';
import { PHARMACY_COLUMNS, PROCEDURE_COLUMNS, SERVICE_COLUMNS, parsePharmacyCsv, parseProcedureCsv, parseServiceCsv, type ImportKind, type RowIssue } from './stockImportParse';

/**
 * Developer CSV stock import (client 2026-10-26, D-055). Procedure file = the product catalogue (no quantities);
 * pharmacy file = products with batch, distributor, prices, quantity and expiry. Re-uploading the same file adds
 * nothing twice: products are matched by Item ID / name, batches by product + Batch No, and each batch's opening
 * `STOCK_IN` row carries the key `csv:<batchId>`. `dryRun` returns the same summary without writing.
 *
 * Writes are bulk (createMany) so a file of hundreds of rows stays within the hosted transaction limit (D-054).
 */

const PREVIEW_MAX = 300;
const UPDATE_CHUNK = 100;

type Action = 'NEW' | 'UPDATE' | 'SAME' | 'EXISTS';
export interface ImportResult {
  kind: ImportKind;
  dryRun: boolean;
  dataRows: number;
  products: { new: number; updated: number; same: number };
  batches: { new: number; existing: number };
  vendorsNew: number;
  quantityIn: number;
  errors: RowIssue[];
  warnings: RowIssue[];
  preview: { row: number; name: string; detail: string; action: Action }[];
}

const key = (s: string) => s.trim().toLowerCase();

function missingHeaders(kind: ImportKind, missing: string[]): never {
  const cols = Object.values(kind === 'PROCEDURE' ? PROCEDURE_COLUMNS : kind === 'SERVICE' ? SERVICE_COLUMNS : PHARMACY_COLUMNS).join(', ');
  throw new ValidationError(`CSV mein yeh column nahi mila: ${missing.join(', ')}. Pehli row mein column ke naam hon: ${cols}.`, { missing });
}

export async function importStock(actor: Actor, input: { kind: ImportKind; csv: string; fileName?: string; dryRun: boolean }): Promise<ImportResult> {
  if (input.kind === 'SERVICE') return importServices(actor, input);
  return input.kind === 'PROCEDURE' ? importProcedure(actor, input) : importPharmacy(actor, input);
}

function mergeUses(...lists: (string | null)[]): string | null {
  const seen = new Map<string, string>();
  for (const l of lists) for (const u of (l ?? '').split(/\s*;\s*/)) if (u.trim() && !seen.has(key(u))) seen.set(key(u), u.trim());
  return seen.size ? [...seen.values()].join('; ') : null;
}

async function importProcedure(actor: Actor, input: { csv: string; fileName?: string; dryRun: boolean }): Promise<ImportResult> {
  const parsed = parseProcedureCsv(input.csv);
  if (parsed.missing.length) missingHeaders('PROCEDURE', parsed.missing);
  const errors = [...parsed.errors];
  const warnings: RowIssue[] = [];

  // One product per name: the same supply listed under several procedures becomes one stock item whose
  // "Procedure / Use" lists all of them.
  // The file's Item ID column is ignored: Item IDs come from the app's one sequence (D-069).
  const merged = new Map<string, (typeof parsed.rows)[number]>();
  for (const r of parsed.rows) {
    const m = merged.get(key(r.name));
    if (!m) merged.set(key(r.name), { ...r });
    else m.procedureUse = mergeUses(m.procedureUse, r.procedureUse);
  }
  const rows = [...merged.values()];
  const existing = rows.length ? await prisma.stockItem.findMany({ where: { name: { in: rows.map((r) => r.name) } } }) : [];
  const byName = new Map(existing.map((i) => [key(i.name), i]));

  const creates: Prisma.StockItemCreateManyInput[] = [];
  const updates: { before: StockItem; data: Prisma.StockItemUpdateInput }[] = [];
  const preview: ImportResult['preview'] = [];
  let same = 0;
  for (const r of rows) {
    const match = byName.get(key(r.name));
    if (match?.kind === 'PHARMACY') {
      errors.push({ row: r.row, message: `${r.name}: yeh naam Pharmacy product ka hai — procedure mein nahi aa sakta.` });
      continue;
    }
    if (!match) {
      creates.push({
        name: r.name,
        kind: 'PROCEDURE',
        category: r.category ?? 'Procedure',
        department: r.department,
        procedureUse: r.procedureUse,
        baseUnit: r.unit ?? 'piece',
        packUnit: r.packUnit,
        packSize: r.packSize,
        itemType: r.itemType,
        sterile: r.sterile,
        note: r.note,
        minQty: 0,
      });
      preview.push({ row: r.row, name: r.name, detail: [r.category, r.unit].filter(Boolean).join(' · '), action: 'NEW' });
      continue;
    }
    const want: Prisma.StockItemUpdateInput = {
      ...(r.name !== match.name ? { name: r.name } : {}),
      ...(r.category && r.category !== match.category ? { category: r.category } : {}),
      ...(r.department && r.department !== match.department ? { department: r.department } : {}),
      ...(r.unit && r.unit !== match.baseUnit ? { baseUnit: r.unit } : {}),
      ...(r.packUnit && r.packUnit !== match.packUnit ? { packUnit: r.packUnit } : {}),
      ...(r.packSize && r.packSize !== match.packSize ? { packSize: r.packSize } : {}),
      ...(r.itemType && r.itemType !== match.itemType ? { itemType: r.itemType } : {}),
      ...(r.sterile !== null && r.sterile !== match.sterile ? { sterile: r.sterile } : {}),
      ...(r.note && r.note !== match.note ? { note: r.note } : {}),
    };
    const uses = mergeUses(match.procedureUse, r.procedureUse);
    if (uses !== match.procedureUse) want.procedureUse = uses;
    if (Object.keys(want).length) {
      updates.push({ before: match, data: want });
      preview.push({ row: r.row, name: r.name, detail: `Badlega: ${Object.keys(want).join(', ')}`, action: 'UPDATE' });
    } else {
      same++;
      preview.push({ row: r.row, name: r.name, detail: 'Pehle se bilkul aisa hai', action: 'SAME' });
    }
  }

  const result: ImportResult = {
    kind: 'PROCEDURE',
    dryRun: input.dryRun,
    dataRows: parsed.dataRows,
    products: { new: creates.length, updated: updates.length, same },
    batches: { new: 0, existing: 0 },
    vendorsNew: 0,
    quantityIn: 0,
    errors: errors.sort((a, b) => a.row - b.row),
    warnings,
    preview: preview.sort((a, b) => a.row - b.row).slice(0, PREVIEW_MAX),
  };
  if (input.dryRun || (!creates.length && !updates.length)) return result;

  await prisma.$transaction(async (tx) => {
    if (creates.length) {
      const codes = await nextItemCodes(tx, creates.length);
      await tx.stockItem.createMany({ data: creates.map((c, i) => ({ ...c, code: codes[i] })), skipDuplicates: true });
    }
    await audit(tx, actor, {
      action: 'STOCK_CSV_IMPORTED',
      recordType: 'StockItem',
      after: { kind: 'PROCEDURE', fileName: input.fileName ?? null, rows: parsed.dataRows, created: creates.map((c) => c.name), updated: updates.length, errors: errors.length },
    });
  });
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK);
    await prisma.$transaction(async (tx) => {
      for (const u of chunk) {
        const after = await tx.stockItem.update({ where: { id: u.before.id }, data: u.data });
        await audit(tx, actor, { action: 'STOCK_ITEM_UPDATED', recordType: 'StockItem', recordId: after.id, before: u.before, after, reason: `CSV import${input.fileName ? ` (${input.fileName})` : ''}` });
      }
    });
  }
  return result;
}

async function importPharmacy(actor: Actor, input: { csv: string; fileName?: string; dryRun: boolean }): Promise<ImportResult> {
  const parsed = parsePharmacyCsv(input.csv);
  if (parsed.missing.length) missingHeaders('PHARMACY', parsed.missing);
  const errors = [...parsed.errors];
  const warnings: RowIssue[] = [];
  const today = clinicDateStr(new Date());

  // Products (one per name) and their batches (one per Batch No; a row without one gets a lot number derived from
  // its contents, so re-uploading it is still recognised).
  type Batch = { row: number; lotNo: string; quantity: number; expiry: string | null; costPaisa: bigint | null; distributor: string | null };
  type Product = { row: number; name: string; unit: string | null; salePaisa: bigint | null; batches: Map<string, Batch> };
  const products = new Map<string, Product>();
  for (const r of parsed.rows) {
    let p = products.get(key(r.name));
    if (!p) products.set(key(r.name), (p = { row: r.row, name: r.name, unit: r.unit, salePaisa: null, batches: new Map() }));
    p.unit ??= r.unit;
    if (r.sellingPricePaisa !== null) p.salePaisa = r.sellingPricePaisa; // the last price in the file wins
    if (r.expiry && r.expiry <= today && r.quantity > 0) warnings.push({ row: r.row, message: `${r.name}: expiry ${r.expiry} guzar chuki — stock aaye ga lekin use / sale nahi hoga.` });
    if (r.quantity === 0) continue;
    const lotNo = r.batchNo ?? `CSV-${sha256([key(r.name), r.expiry ?? '', r.purchasePricePaisa ?? '', r.distributor ?? ''].join('|')).slice(0, 10).toUpperCase()}`;
    const b = p.batches.get(key(lotNo));
    if (b) {
      b.quantity += r.quantity;
      warnings.push({ row: r.row, message: `${r.name}: Batch ${r.batchNo ?? '(khaali)'} file mein dobara hai — quantity row ${b.row} mein jama ki gayi.` });
    } else p.batches.set(key(lotNo), { row: r.row, lotNo, quantity: r.quantity, expiry: r.expiry, costPaisa: r.purchasePricePaisa, distributor: r.distributor });
  }

  const list = [...products.values()];
  const existing = list.length ? await prisma.stockItem.findMany({ where: { name: { in: list.map((p) => p.name) } } }) : [];
  const byName = new Map(existing.map((i) => [key(i.name), i]));
  const oldBatches = existing.length
    ? await prisma.stockBatch.findMany({ where: { itemId: { in: existing.map((i) => i.id) } }, select: { itemId: true, lotNo: true } })
    : [];
  const hasBatch = new Set(oldBatches.map((b) => `${b.itemId}|${key(b.lotNo)}`));

  const creates: Prisma.StockItemCreateManyInput[] = [];
  const priceUpdates: { before: StockItem; salePaisa: bigint }[] = [];
  const newBatches: { product: Product; batch: Batch }[] = [];
  const preview: ImportResult['preview'] = [];
  let same = 0;
  let existingBatches = 0;
  for (const p of list) {
    const match = byName.get(key(p.name));
    if (match && match.kind !== 'PHARMACY') {
      for (const b of p.batches.values()) errors.push({ row: b.row, message: `${p.name}: yeh naam Procedure product ka hai — pharmacy mein nahi aa sakta.` });
      if (!p.batches.size) errors.push({ row: p.row, message: `${p.name}: yeh naam Procedure product ka hai — pharmacy mein nahi aa sakta.` });
      continue;
    }
    if (!match) creates.push({ name: p.name, kind: 'PHARMACY', category: 'Pharmacy', baseUnit: p.unit ?? 'piece', minQty: 0, salePricePaisa: p.salePaisa });
    else if (p.salePaisa !== null && p.salePaisa !== match.salePricePaisa) priceUpdates.push({ before: match, salePaisa: p.salePaisa });
    else same++;
    if (!p.batches.size) preview.push({ row: p.row, name: p.name, detail: 'Quantity 0 — sirf product', action: match ? 'SAME' : 'NEW' });
    for (const b of p.batches.values()) {
      const detail = `Batch ${b.lotNo} · ${b.quantity} ${p.unit ?? 'piece'}${b.expiry ? ` · exp ${b.expiry}` : ''}`;
      if (match && hasBatch.has(`${match.id}|${key(b.lotNo)}`)) {
        existingBatches++;
        preview.push({ row: b.row, name: p.name, detail: `${detail} — pehle se import ho chuka`, action: 'EXISTS' });
      } else {
        newBatches.push({ product: p, batch: b });
        preview.push({ row: b.row, name: p.name, detail, action: 'NEW' });
      }
    }
  }
  const distributors = [...new Map(newBatches.flatMap(({ batch }) => (batch.distributor ? [[key(batch.distributor), batch.distributor] as const] : []))).values()];
  const knownVendors = distributors.length ? await prisma.vendor.findMany({ where: { name: { in: distributors } }, select: { id: true, name: true } }) : [];
  const newVendors = distributors.filter((d) => !knownVendors.some((v) => key(v.name) === key(d)));

  const result: ImportResult = {
    kind: 'PHARMACY',
    dryRun: input.dryRun,
    dataRows: parsed.dataRows,
    products: { new: creates.length, updated: priceUpdates.length, same },
    batches: { new: newBatches.length, existing: existingBatches },
    vendorsNew: newVendors.length,
    quantityIn: newBatches.reduce((s, { batch }) => s + batch.quantity, 0),
    errors: errors.sort((a, b) => a.row - b.row),
    warnings: warnings.sort((a, b) => a.row - b.row),
    preview: preview.sort((a, b) => a.row - b.row).slice(0, PREVIEW_MAX),
  };
  if (input.dryRun || (!creates.length && !priceUpdates.length && !newBatches.length)) return result;

  const reason = `Opening stock — CSV import${input.fileName ? ` (${input.fileName})` : ''}`;
  await prisma.$transaction(async (tx) => {
    if (newVendors.length) await tx.vendor.createMany({ data: newVendors.map((name) => ({ name })), skipDuplicates: true });
    if (creates.length) await tx.stockItem.createMany({ data: creates, skipDuplicates: true });
    const vendors = distributors.length ? await tx.vendor.findMany({ where: { name: { in: distributors } }, select: { id: true, name: true } }) : [];
    const items = newBatches.length ? await tx.stockItem.findMany({ where: { name: { in: [...new Set(newBatches.map((n) => n.product.name))] } }, select: { id: true, name: true } }) : [];
    const itemId = (name: string) => items.find((i) => key(i.name) === key(name))!.id;
    const vendorId = (name: string | null) => (name ? (vendors.find((v) => key(v.name) === key(name))?.id ?? null) : null);
    if (newBatches.length) {
      await tx.stockBatch.createMany({
        data: newBatches.map(({ product, batch }) => ({
          itemId: itemId(product.name),
          lotNo: batch.lotNo,
          expiryDate: batch.expiry ? dateOnly(batch.expiry) : null,
          vendorId: vendorId(batch.distributor),
          unitCostPaisa: batch.costPaisa,
        })),
        skipDuplicates: true,
      });
      const ids = [...new Set(newBatches.map((n) => itemId(n.product.name)))];
      const batches = await tx.stockBatch.findMany({ where: { itemId: { in: ids }, lotNo: { in: newBatches.map((n) => n.batch.lotNo) } }, select: { id: true, itemId: true, lotNo: true, vendorId: true, unitCostPaisa: true } });
      await tx.stockTransaction.createMany({
        data: newBatches.map(({ product, batch }) => {
          const b = batches.find((x) => x.itemId === itemId(product.name) && key(x.lotNo) === key(batch.lotNo))!;
          return { itemId: b.itemId, batchId: b.id, type: 'STOCK_IN' as const, quantity: batch.quantity, unitCostPaisa: b.unitCostPaisa, vendorId: b.vendorId, actorId: actor.id!, reason, idempotencyKey: `csv:${b.id}` };
        }),
        skipDuplicates: true,
      });
    }
    for (const u of priceUpdates) {
      const after = await tx.stockItem.update({ where: { id: u.before.id }, data: { salePricePaisa: u.salePaisa } });
      await audit(tx, actor, { action: 'STOCK_ITEM_UPDATED', recordType: 'StockItem', recordId: after.id, before: u.before, after, reason });
    }
    await audit(tx, actor, {
      action: 'STOCK_CSV_IMPORTED',
      recordType: 'StockItem',
      after: {
        kind: 'PHARMACY',
        fileName: input.fileName ?? null,
        rows: parsed.dataRows,
        created: creates.map((c) => c.name),
        vendorsCreated: newVendors,
        batches: newBatches.map(({ product, batch }) => ({ name: product.name, lotNo: batch.lotNo, quantity: batch.quantity })),
        errors: errors.length,
      },
      reason,
    });
  });
  return result;
}

/**
 * Procedure / service list (D-060) → the `Service` catalogue (booking and treatment-plan pickers). Matched by name;
 * a filled cell updates the saved value, a blank one never wipes it. New entries are procedures (type PROCEDURE)
 * with the default duration.
 */
async function importServices(actor: Actor, input: { csv: string; fileName?: string; dryRun: boolean }): Promise<ImportResult> {
  const parsed = parseServiceCsv(input.csv);
  if (parsed.missing.length) missingHeaders('SERVICE', parsed.missing);
  const errors = [...parsed.errors];
  const warnings: RowIssue[] = [];
  const merged = new Map<string, (typeof parsed.rows)[number]>();
  for (const r of parsed.rows) {
    const m = merged.get(key(r.name));
    if (!m) merged.set(key(r.name), { ...r });
    else {
      m.category ??= r.category;
      m.source ??= r.source;
      m.note ??= r.note;
      warnings.push({ row: r.row, message: `${r.name}: file mein dobara hai — row ${m.row} ke saath mila diya.` });
    }
  }
  const rows = [...merged.values()];
  const existing = rows.length ? await prisma.service.findMany({ where: { name: { in: rows.map((r) => r.name) } } }) : [];
  const byName = new Map(existing.map((x) => [key(x.name), x]));
  const creates: Prisma.ServiceCreateManyInput[] = [];
  const updates: { before: (typeof existing)[number]; data: Prisma.ServiceUpdateInput }[] = [];
  const preview: ImportResult['preview'] = [];
  let same = 0;
  for (const r of rows) {
    const match = byName.get(key(r.name));
    if (!match) {
      creates.push({ name: r.name, type: 'PROCEDURE', category: r.category, source: r.source, note: r.note });
      preview.push({ row: r.row, name: r.name, detail: [r.category, r.source].filter(Boolean).join(' · '), action: 'NEW' });
      continue;
    }
    const data: Prisma.ServiceUpdateInput = {
      ...(r.category && r.category !== match.category ? { category: r.category } : {}),
      ...(r.source && r.source !== match.source ? { source: r.source } : {}),
      ...(r.note && r.note !== match.note ? { note: r.note } : {}),
    };
    if (Object.keys(data).length) {
      updates.push({ before: match, data });
      preview.push({ row: r.row, name: r.name, detail: `Badlega: ${Object.keys(data).join(', ')}`, action: 'UPDATE' });
    } else {
      same++;
      preview.push({ row: r.row, name: r.name, detail: 'Pehle se bilkul aisa hai', action: 'SAME' });
    }
  }
  const result: ImportResult = {
    kind: 'SERVICE',
    dryRun: input.dryRun,
    dataRows: parsed.dataRows,
    products: { new: creates.length, updated: updates.length, same },
    batches: { new: 0, existing: 0 },
    vendorsNew: 0,
    quantityIn: 0,
    errors: errors.sort((a, b) => a.row - b.row),
    warnings: warnings.sort((a, b) => a.row - b.row),
    preview: preview.sort((a, b) => a.row - b.row).slice(0, PREVIEW_MAX),
  };
  if (input.dryRun || (!creates.length && !updates.length)) return result;

  await prisma.$transaction(async (tx) => {
    if (creates.length) await tx.service.createMany({ data: creates, skipDuplicates: true });
    await audit(tx, actor, {
      action: 'SERVICE_CSV_IMPORTED',
      recordType: 'Service',
      after: { fileName: input.fileName ?? null, rows: parsed.dataRows, created: creates.map((c) => c.name), updated: updates.length, errors: errors.length },
    });
  });
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK);
    await prisma.$transaction(async (tx) => {
      for (const u of chunk) {
        const after = await tx.service.update({ where: { id: u.before.id }, data: u.data });
        await audit(tx, actor, { action: 'SERVICE_UPDATED', recordType: 'Service', recordId: after.id, before: u.before, after, reason: `CSV import${input.fileName ? ` (${input.fileName})` : ''}` });
      }
    });
  }
  return result;
}
