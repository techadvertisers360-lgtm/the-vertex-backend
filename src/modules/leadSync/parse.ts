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
  extra: z.array(z.string().trim().min(1).max(100)).max(60).optional(),
  /** Detected by the app from the header (D-045): re-detected on every sync so new form questions are picked up. */
  auto: z.boolean().optional(),
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
  const phone = normalizePhone(phoneRaw);
  if (!phone) return { kind: 'invalid', row, reason: phoneRaw ? `Phone ghalat: ${phoneRaw}` : 'Phone khali' };
  const id = cols.id !== null ? cell(cols.id) : '';
  const key = (id ? `id:${id}` : `row:${row}`).slice(0, 191);
  const extras = cols.extra.map((e) => [e.label, cell(e.index)] as const).filter(([, v]) => v);
  const remarks = extras.length ? `Sheet: ${extras.map(([k, v]) => `${k}: ${v}`).join(' · ')}`.slice(0, 8000) : null;
  // A row with a phone but no name is still a lead — never dropped (D-045).
  return { kind: 'lead', row, key, name: name || 'Naam nahi diya', phone, phoneRaw, remarks };
}

// ───────────── Auto-detect (D-045): only the sheet link is entered; the tab and columns are found here ─────────────

const NAME_EXACT = ['full name', 'name', 'customer name', 'patient name', 'client name', 'naam', 'your name', 'first name'];
const PHONE_EXACT = ['phone number', 'phone', 'mobile', 'mobile number', 'contact', 'contact number', 'whatsapp', 'whatsapp number', 'cell', 'cell number', 'phone no', 'mobile no', 'number'];
const ID_EXACT = ['id', 'lead id', 'leadgen id'];
/** Meta's technical id columns (ad / campaign / form ids) add nothing to a call; every other column goes to remarks. */
const SKIP_EXTRA = /(^| )(ad|adset|ad set|campaign|form|page) id$|^is organic$/;

const firstIndex = (h: string[], test: (x: string) => boolean, taken: Set<number>) => h.findIndex((x, i) => !taken.has(i) && !!x && test(x));

/** Column whose sample cells are mostly phone numbers (for sheets whose phone header is unusual). */
function phoneByContent(rows: string[][], taken: Set<number>, width: number): number {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < width; i++) {
    if (taken.has(i)) continue;
    const cells = rows.map((r) => (r[i] ?? '').trim()).filter(Boolean);
    if (!cells.length) continue;
    const score = cells.filter((c) => normalizePhone(cleanPhone(c))).length / cells.length;
    if (score >= 0.6 && score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

export type Detection = { map: ColumnMap; problem?: undefined } | { map: null; problem: string };

/**
 * Find the name / phone / lead-id columns from the header row (and sample rows when the phone header is unusual).
 * Every other non-technical column (form questions, email, city, created time, ad / campaign name…) is copied into
 * the lead's remarks, so nothing in the sheet is lost.
 */
export function detectColumns(header: string[], sampleRows: string[][] = []): Detection {
  const h = header.map((x) => norm(String(x ?? '')));
  if (!h.some(Boolean)) return { map: null, problem: 'Pehli row (header) khali hai — row 1 mein columns ke naam hone chahiyein.' };
  const taken = new Set<number>();
  const pick = (exact: string[], loose?: (x: string) => boolean) => {
    for (const e of exact) {
      const i = firstIndex(h, (x) => x === e, taken);
      if (i >= 0) return i;
    }
    return loose ? firstIndex(h, loose, taken) : -1;
  };
  const id = pick(ID_EXACT);
  if (id >= 0) taken.add(id);
  let phone = pick(PHONE_EXACT, (x) => /phone|mobile|whats ?app|contact|cell/.test(x));
  if (phone < 0) phone = phoneByContent(sampleRows, taken, h.length);
  if (phone >= 0) taken.add(phone);
  const name = pick(NAME_EXACT, (x) => /(^| )name$|naam/.test(x) && !/^(ad|adset|ad set|campaign|form|page|platform|city|company|business|last|sur) ?name$/.test(x));
  if (name >= 0) taken.add(name);

  const missing = [phone < 0 ? 'phone' : null, name < 0 ? 'naam' : null].filter(Boolean);
  if (missing.length) return { map: null, problem: `Sheet mein ${missing.join(' aur ')} ka column nahi mila. Row 1 ke columns: ${header.filter(Boolean).join(', ')}` };

  const seen = new Set<string>();
  const extra: string[] = [];
  header.forEach((label, i) => {
    const n = h[i]!;
    if (!n || taken.has(i) || seen.has(n) || SKIP_EXTRA.test(n)) return;
    seen.add(n);
    extra.push(String(label).trim().slice(0, 100));
  });
  return { map: { name: String(header[name]).trim(), phone: String(header[phone]).trim(), id: id >= 0 ? String(header[id]).trim() : null, extra: extra.slice(0, 60), auto: true } };
}
