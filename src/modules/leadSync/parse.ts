import { z } from 'zod';
import { normalizePhone } from '../../lib/phone';

/**
 * Pure row parsing for the Google Sheets lead sync (no DB, unit-tested).
 * Columns are matched by the header text in row 1 (case / spacing / underscores ignored), so column moves in
 * the sheet do not break the sync. Meta lead-form sheets: `id`, `full_name`, `phone_number` (values like `p:+92…`).
 */

export const columnMapSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(1).max(100),
  /** Unique lead id column (Meta: `id`). Strongly recommended: without it rows are keyed by row number. */
  id: z.string().trim().max(100).optional().nullable(),
  /** Extra columns copied once into the new lead's remarks (e.g. form answers). */
  extra: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
});
export type ColumnMap = z.infer<typeof columnMapSchema>;

export const META_DEFAULT_COLUMNS: ColumnMap = { id: 'id', name: 'full_name', phone: 'phone_number', extra: [] };

export interface ResolvedColumns {
  name: number;
  phone: number;
  id: number | null;
  extra: { label: string; index: number }[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/** Map header names to column indexes; `missing` lists configured headers not present in row 1. */
export function resolveColumns(header: string[], map: ColumnMap): { cols: ResolvedColumns | null; missing: string[] } {
  const h = header.map(norm);
  const find = (name: string) => h.indexOf(norm(name));
  const missing: string[] = [];
  const need = (name: string) => {
    const i = find(name);
    if (i < 0) missing.push(name);
    return i;
  };
  const name = need(map.name);
  const phone = need(map.phone);
  const id = map.id ? need(map.id) : -1;
  const extra = (map.extra ?? []).map((label) => ({ label, index: need(label) }));
  if (missing.length) return { cols: null, missing };
  return { cols: { name, phone, id: map.id ? id : null, extra }, missing };
}

export type ParsedRow =
  | { kind: 'blank'; row: number }
  | { kind: 'invalid'; row: number; reason: string }
  | { kind: 'lead'; row: number; key: string; name: string; phone: string; phoneRaw: string; remarks: string | null };

/** Meta writes phone cells as `p:+923001234567`; strip that prefix before normalizing. */
export function cleanPhone(raw: string): string {
  return raw.trim().replace(/^p:/i, '').trim();
}

export function parseRow(cells: string[], row: number, cols: ResolvedColumns): ParsedRow {
  const cell = (i: number) => (cells[i] ?? '').trim();
  if (cells.every((c) => !c || !String(c).trim())) return { kind: 'blank', row };
  const name = cell(cols.name).replace(/\s+/g, ' ').slice(0, 191);
  const phoneRaw = cleanPhone(cell(cols.phone)).slice(0, 191);
  if (!name) return { kind: 'invalid', row, reason: 'Naam khali' };
  const phone = normalizePhone(phoneRaw);
  if (!phone) return { kind: 'invalid', row, reason: phoneRaw ? `Phone ghalat: ${phoneRaw}` : 'Phone khali' };
  const id = cols.id !== null ? cell(cols.id) : '';
  const key = (id ? `id:${id}` : `row:${row}`).slice(0, 191);
  const extras = cols.extra.map((e) => [e.label, cell(e.index)] as const).filter(([, v]) => v);
  const remarks = extras.length ? `Sheet: ${extras.map(([k, v]) => `${k}: ${v}`).join(' · ')}`.slice(0, 2000) : null;
  return { kind: 'lead', row, key, name, phone, phoneRaw, remarks };
}
