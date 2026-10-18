import { createSign } from 'node:crypto';
import { env } from '../config/env';

/**
 * Minimal read-only Google Sheets client for the Meta lead-sheet sync (Phase 9b, D-039).
 * Auth: service account JWT (RS256, node:crypto) → OAuth access token; no SDK dependency.
 * The key never leaves this module: errors carry user-facing Roman-Urdu messages, never key material.
 * Tests swap the implementation with `setSheetsApi()`.
 */

export type SheetsErrorCode = 'NOT_CONFIGURED' | 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_RANGE' | 'RATE_LIMIT' | 'NETWORK' | 'OTHER';

export class SheetsApiError extends Error {
  constructor(
    readonly code: SheetsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ValueRange {
  /** A1 range Google actually returned, e.g. `'Leads'!A2:Q40` */
  range: string;
  values: string[][];
}

export interface SheetsApi {
  spreadsheet(spreadsheetId: string): Promise<{ title: string; tabs: string[] }>;
  values(spreadsheetId: string, range: string): Promise<ValueRange>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let parsedKey: ServiceAccount | null | undefined;

function serviceAccount(): ServiceAccount | null {
  if (parsedKey !== undefined) return parsedKey;
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  parsedKey = null;
  if (!raw) return null;
  try {
    const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const k = JSON.parse(json) as Partial<ServiceAccount>;
    if (k.client_email && k.private_key) parsedKey = { client_email: k.client_email, private_key: k.private_key.replace(/\\n/g, '\n'), token_uri: k.token_uri };
  } catch {
    parsedKey = null;
  }
  return parsedKey;
}

/** The address sheets must be shared with. Not a secret; shown on the admin screen. */
export function serviceAccountEmail(): string | null {
  return serviceAccount()?.client_email ?? null;
}

/** Accepts a bare spreadsheet ID or a full https://docs.google.com/spreadsheets/d/<id>/… URL. */
export function parseSpreadsheetId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1]!;
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

/** `'My Tab'!A2:ZZ` — tab names are always quoted (spaces, digits, quotes). */
export function a1(tab: string, cells: string): string {
  return `'${tab.replace(/'/g, "''")}'!${cells}`;
}

/** First row number of a returned A1 range (`'Leads'!A7:Q9` → 7). */
export function startRowOf(range: string): number | null {
  const m = range.match(/!\$?[A-Z]*\$?(\d+)/);
  return m ? Number(m[1]) : null;
}

const TIMEOUT_MS = 20_000;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

class GoogleSheetsApi implements SheetsApi {
  private token: { value: string; exp: number } | null = null;

  private async accessToken(): Promise<string> {
    const sa = serviceAccount();
    if (!sa) throw new SheetsApiError('NOT_CONFIGURED', 'Google service account configure nahi (backend .env mein GOOGLE_SERVICE_ACCOUNT_JSON).');
    if (this.token && this.token.exp - 60_000 > Date.now()) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 })}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    } catch {
      throw new SheetsApiError('AUTH', 'Service account key parh nahi saki — JSON key dobara paste karein.');
    }
    const res = await this.fetch(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    if (!res.ok) throw new SheetsApiError('AUTH', 'Google ne service account login reject kiya — key disable / delete to nahi hui?');
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new SheetsApiError('NETWORK', 'Google se connection nahi hua (internet / timeout). Agli sync mein dobara koshish hogi.');
    }
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.fetch(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (res.ok) return (await res.json()) as T;
    const msg = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? '';
    if (res.status === 401) {
      this.token = null;
      throw new SheetsApiError('AUTH', 'Google login expire / reject — dobara koshish hogi.');
    }
    if (res.status === 403) throw new SheetsApiError('FORBIDDEN', `Sheet service account ke saath share nahi (${serviceAccountEmail()} ko Viewer access dein), ya Google Sheets API enable nahi.`);
    if (res.status === 404) throw new SheetsApiError('NOT_FOUND', 'Google Sheet nahi mili — Sheet ID / link check karein.');
    if (res.status === 400 && /parse range/i.test(msg)) throw new SheetsApiError('BAD_RANGE', 'Tab ka naam sheet mein nahi mila — tab name check karein.');
    if (res.status === 429) throw new SheetsApiError('RATE_LIMIT', 'Google ki request limit — thori der baad khud dobara hogi.');
    throw new SheetsApiError('OTHER', `Google Sheets error ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`);
  }

  async spreadsheet(id: string) {
    const r = await this.get<{ properties: { title: string }; sheets?: { properties: { title: string } }[] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=properties.title,sheets.properties.title`,
    );
    return { title: r.properties.title, tabs: (r.sheets ?? []).map((s) => s.properties.title) };
  }

  async values(id: string, range: string) {
    const r = await this.get<{ range: string; values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    );
    return { range: r.range, values: (r.values ?? []).map((row) => row.map((c) => (c === null || c === undefined ? '' : String(c)))) };
  }
}

let impl: SheetsApi = new GoogleSheetsApi();

export function sheetsApi(): SheetsApi {
  return impl;
}

/** Test seam: replace the Google client (pass null to restore the real one). */
export function setSheetsApi(api: SheetsApi | null): void {
  impl = api ?? new GoogleSheetsApi();
}
