import { fromRupeeString } from '../../lib/money';

/**
 * Pure CSV parsing for the developer's stock import (D-055; no DB, unit-tested). Columns are matched by header text
 * (case / spacing / punctuation ignored), so column order does not matter and extra columns are ignored.
 */

/** RFC 4180 CSV: quoted cells, "" escapes, commas and newlines inside quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // byte-order mark from Excel
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const clean = (s: string | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');

export const PROCEDURE_COLUMNS = {
  code: 'Item ID',
  category: 'Stock Category',
  department: 'Department',
  procedureUse: 'Procedure / Use',
  name: 'Product or Supply',
  unit: 'Inventory Unit',
  packUnit: 'Purchase Unit',
  packSize: 'Units per Purchase Pack',
  itemType: 'Item Type',
  sterile: 'Sterile',
  note: 'Stock / Selection Note',
} as const;

export const PHARMACY_COLUMNS = {
  batchNo: 'Batch No',
  name: 'Name',
  distributor: 'Distributor',
  purchasePrice: 'Purchase Price',
  sellingPrice: 'Selling Price',
  unit: 'Stock Unit',
  quantity: 'Quantity',
  totalPurchase: 'Total Purchase Price',
  totalSelling: 'Total Selling Price',
  expiry: 'Expiration Date',
} as const;

/** Procedure / service list (D-060): becomes the `Service` catalogue used in booking and treatment plans. */
export const SERVICE_COLUMNS = {
  category: 'Category',
  name: 'Procedure / Service',
  source: 'Source',
  note: 'Note',
} as const;

export type ImportKind = 'PROCEDURE' | 'PHARMACY' | 'SERVICE';
const REQUIRED: Record<ImportKind, string[]> = { PROCEDURE: ['name'], PHARMACY: ['name', 'quantity'], SERVICE: ['name'] };

export interface RowIssue {
  row: number;
  message: string;
}

export interface ProcedureRow {
  row: number;
  code: string | null;
  name: string;
  category: string | null;
  department: string | null;
  procedureUse: string | null;
  unit: string | null;
  packUnit: string | null;
  packSize: number | null;
  itemType: string | null;
  sterile: boolean | null;
  note: string | null;
}

export interface PharmacyRow {
  row: number;
  name: string;
  batchNo: string | null;
  distributor: string | null;
  purchasePricePaisa: bigint | null;
  sellingPricePaisa: bigint | null;
  unit: string | null;
  quantity: number;
  expiry: string | null; // YYYY-MM-DD
}

/** Amount cell → paisa: "Rs 1,250.50", "1250", "PKR 90" (null when blank). Throws on anything else. */
export function parseMoneyCell(raw: string): bigint | null {
  const s = raw.replace(/^(rs\.?|pkr)\s*/i, '').replace(/\s/g, '');
  if (!s || s === '-') return null;
  const p = fromRupeeString(s);
  if (p < 0n) throw new Error('negative');
  return p;
}

/** Whole quantity: "12", "12.0", "1,200". */
export function parseQuantity(raw: string): number | null {
  const s = raw.replace(/,/g, '').trim();
  if (!s) return null;
  const m = /^(\d+)(?:\.0+)?$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function ymd(y: number, m: number, d: number | null): string | null {
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12)) return null;
  const day = d ?? lastDay(y, m);
  if (day < 1 || day > lastDay(y, m)) return null;
  return `${y}-${pad(m)}-${pad(day)}`;
}

/**
 * Expiry cell → YYYY-MM-DD. Accepts 2027-05-31, 31/05/2027 or 31-05-27 (day first, as written in Pakistan; a first
 * number above 12 is always the day), 31 May 2027, May 2027 / 05/2027 / May-27 (month only → last day of the month)
 * and Excel serial numbers. Null when blank; throws when unreadable.
 */
export function parseExpiry(raw: string): string | null {
  const s = raw.trim();
  if (!s || s === '-' || /^n\/?a$/i.test(s)) return null;
  let m: RegExpExecArray | null;
  let out: string | null = null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) out = ymd(+m[1]!, +m[2]!, +m[3]!);
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) {
    const a = +m[1]!;
    const b = +m[2]!;
    out = b > 12 && a <= 12 ? ymd(year(m[3]!), a, b) : ymd(year(m[3]!), b, a);
  } else if ((m = /^(\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s))) out = ymd(year(m[2]!), +m[1]!, null);
  else if ((m = /^(\d{1,2})?[-/ ]?([a-z]{3})[a-z]*[-/ ,]+(\d{4}|\d{2})$/i.exec(s))) {
    const mon = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    out = mon ? ymd(year(m[3]!), mon, m[1] ? +m[1] : null) : null;
  } else if ((m = /^(\d{5})$/.exec(s))) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86_400_000);
    out = ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (!out) throw new Error('date');
  return out;
}

function parseSterile(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === '-' || s === 'n/a') return null;
  if (['yes', 'y', 'true', '1', 'sterile', 'haan'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'non-sterile', 'non sterile', 'nahi'].includes(s)) return false;
  return null;
}

type Columns<T extends Record<string, string>> = { [K in keyof T]: number };

/** Header row → column indexes. `missing` lists required headers that are not present. */
function resolve<T extends Record<string, string>>(header: string[], cols: T, kind: ImportKind): { idx: Columns<T>; missing: string[] } {
  const h = header.map(norm);
  const idx = Object.fromEntries(Object.entries(cols).map(([k, label]) => [k, h.indexOf(norm(label))])) as Columns<T>;
  const missing = REQUIRED[kind].filter((k) => idx[k as keyof T] < 0).map((k) => cols[k as keyof T]!);
  return { idx, missing };
}

export interface Parsed<R> {
  rows: R[];
  errors: RowIssue[];
  missing: string[];
  dataRows: number;
}

/** First non-empty row is the header; row numbers in messages are spreadsheet row numbers (header = its row). */
function split(text: string) {
  const all = parseCsv(text);
  const start = all.findIndex((r) => r.some((c) => c.trim()));
  if (start < 0) return { header: [] as string[], body: [] as { row: number; cells: string[] }[] };
  return {
    header: all[start]!,
    body: all
      .slice(start + 1)
      .map((cells, i) => ({ row: start + i + 2, cells }))
      .filter((r) => r.cells.some((c) => c.trim())),
  };
}

export function parseProcedureCsv(text: string): Parsed<ProcedureRow> {
  const { header, body } = split(text);
  const { idx, missing } = resolve(header, PROCEDURE_COLUMNS, 'PROCEDURE');
  if (missing.length) return { rows: [], errors: [], missing, dataRows: body.length };
  const rows: ProcedureRow[] = [];
  const errors: RowIssue[] = [];
  const get = (cells: string[], k: keyof typeof PROCEDURE_COLUMNS) => (idx[k] >= 0 ? clean(cells[idx[k]]) : '');
  for (const { row, cells } of body) {
    const name = get(cells, 'name');
    if (name.length < 2) {
      errors.push({ row, message: `"${PROCEDURE_COLUMNS.name}" khaali hai.` });
      continue;
    }
    const packRaw = get(cells, 'packSize');
    const packSize = packRaw ? parseQuantity(packRaw) : null;
    if (packSize !== null && !(packSize > 0)) {
      errors.push({ row, message: `${name}: "${PROCEDURE_COLUMNS.packSize}" ("${packRaw}") poora number ho.` });
      continue;
    }
    const code = get(cells, 'code');
    if (code.length > 64) {
      errors.push({ row, message: `${name}: Item ID 64 characters se lamba hai.` });
      continue;
    }
    rows.push({
      row,
      code: code || null,
      name: name.slice(0, 191),
      category: get(cells, 'category').slice(0, 191) || null,
      department: get(cells, 'department').slice(0, 191) || null,
      procedureUse: get(cells, 'procedureUse') || null,
      unit: get(cells, 'unit').slice(0, 191) || null,
      packUnit: get(cells, 'packUnit').slice(0, 191) || null,
      packSize,
      itemType: get(cells, 'itemType').slice(0, 191) || null,
      sterile: parseSterile(get(cells, 'sterile')),
      note: get(cells, 'note') || null,
    });
  }
  return { rows, errors, missing, dataRows: body.length };
}

export function parsePharmacyCsv(text: string): Parsed<PharmacyRow> {
  const { header, body } = split(text);
  const { idx, missing } = resolve(header, PHARMACY_COLUMNS, 'PHARMACY');
  if (missing.length) return { rows: [], errors: [], missing, dataRows: body.length };
  const rows: PharmacyRow[] = [];
  const errors: RowIssue[] = [];
  const get = (cells: string[], k: keyof typeof PHARMACY_COLUMNS) => (idx[k] >= 0 ? clean(cells[idx[k]]) : '');
  for (const { row, cells } of body) {
    const name = get(cells, 'name');
    if (name.length < 2) {
      errors.push({ row, message: `"${PHARMACY_COLUMNS.name}" khaali hai.` });
      continue;
    }
    const qRaw = get(cells, 'quantity');
    const quantity = parseQuantity(qRaw) ?? 0;
    if (Number.isNaN(quantity)) {
      errors.push({ row, message: `${name}: Quantity ("${qRaw}") poora number ho.` });
      continue;
    }
    let purchasePricePaisa: bigint | null;
    let sellingPricePaisa: bigint | null;
    let expiry: string | null;
    try {
      purchasePricePaisa = parseMoneyCell(get(cells, 'purchasePrice'));
    } catch {
      errors.push({ row, message: `${name}: Purchase Price ("${get(cells, 'purchasePrice')}") sahi nahi.` });
      continue;
    }
    try {
      sellingPricePaisa = parseMoneyCell(get(cells, 'sellingPrice'));
    } catch {
      errors.push({ row, message: `${name}: Selling Price ("${get(cells, 'sellingPrice')}") sahi nahi.` });
      continue;
    }
    try {
      expiry = parseExpiry(get(cells, 'expiry'));
    } catch {
      errors.push({ row, message: `${name}: Expiration Date ("${get(cells, 'expiry')}") samajh nahi aayi — 2027-05-31 ya 31/05/2027 likhein.` });
      continue;
    }
    const batchNo = get(cells, 'batchNo');
    if (batchNo.length > 100) {
      errors.push({ row, message: `${name}: Batch No bohat lamba hai.` });
      continue;
    }
    rows.push({
      row,
      name: name.slice(0, 191),
      batchNo: batchNo || null,
      distributor: get(cells, 'distributor').slice(0, 191) || null,
      purchasePricePaisa,
      sellingPricePaisa,
      unit: get(cells, 'unit').slice(0, 191) || null,
      quantity,
      expiry,
    });
  }
  return { rows, errors, missing, dataRows: body.length };
}

export interface ServiceRow {
  row: number;
  name: string;
  category: string | null;
  source: string | null;
  note: string | null;
}

export function parseServiceCsv(text: string): Parsed<ServiceRow> {
  const { header, body } = split(text);
  const { idx, missing } = resolve(header, SERVICE_COLUMNS, 'SERVICE');
  if (missing.length) return { rows: [], errors: [], missing, dataRows: body.length };
  const rows: ServiceRow[] = [];
  const errors: RowIssue[] = [];
  const get = (cells: string[], k: keyof typeof SERVICE_COLUMNS) => (idx[k] >= 0 ? clean(cells[idx[k]]) : '');
  for (const { row, cells } of body) {
    const name = get(cells, 'name');
    if (name.length < 2) {
      errors.push({ row, message: `"${SERVICE_COLUMNS.name}" khaali hai.` });
      continue;
    }
    rows.push({ row, name: name.slice(0, 191), category: get(cells, 'category').slice(0, 191) || null, source: get(cells, 'source').slice(0, 191) || null, note: get(cells, 'note') || null });
  }
  return { rows, errors, missing, dataRows: body.length };
}
