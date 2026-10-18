import { describe, expect, it } from 'vitest';
import { cleanPhone, META_DEFAULT_COLUMNS, parseRow, resolveColumns } from '../../src/modules/leadSync/parse';
import { a1, parseSpreadsheetId, startRowOf } from '../../src/services/googleSheets';

const HEADER = ['id', 'created_time', 'ad_name', 'Full Name', 'phone_number', 'which_treatment?'];

describe('Google Sheets lead sync — parsing (D-039)', () => {
  it('matches header names ignoring case, spaces and underscores', () => {
    const { cols, missing } = resolveColumns(HEADER, { ...META_DEFAULT_COLUMNS, extra: ['Which Treatment?'] });
    expect(missing).toEqual([]);
    expect(cols).toEqual({ id: 0, name: 3, phone: 4, extra: [{ label: 'Which Treatment?', index: 5 }] });
  });

  it('reports every missing column', () => {
    const r = resolveColumns(['id', 'name'], { name: 'full_name', phone: 'phone_number', id: 'lead_id' });
    expect(r.cols).toBeNull();
    expect(r.missing).toEqual(['full_name', 'phone_number', 'lead_id']);
  });

  it('parses Meta rows: p: phone prefix, id key, extra columns into remarks', () => {
    const { cols } = resolveColumns(HEADER, { ...META_DEFAULT_COLUMNS, extra: ['which_treatment?'] });
    const r = parseRow(['l:9988', '2026-10-18', 'Ad', '  Ayesha   Khan ', 'p:+923001234567', 'Laser'], 7, cols!);
    expect(r).toEqual({ kind: 'lead', row: 7, key: 'id:l:9988', name: 'Ayesha Khan', phone: '923001234567', phoneRaw: '+923001234567', remarks: 'Sheet: which_treatment?: Laser' });
    expect(cleanPhone('P: 0300 1234567')).toBe('0300 1234567');
  });

  it('falls back to the row number without an id column; flags blank and invalid rows', () => {
    const { cols } = resolveColumns(HEADER, { name: 'full name', phone: 'phone number' });
    expect(parseRow(['', '', '', 'Ali', '03001234567'], 12, cols!)).toMatchObject({ kind: 'lead', key: 'row:12' });
    expect(parseRow(['', '', '', '', ''], 13, cols!)).toEqual({ kind: 'blank', row: 13 });
    expect(parseRow(['', '', '', 'Ali', '12'], 14, cols!)).toEqual({ kind: 'invalid', row: 14, reason: 'Phone ghalat: 12' });
    expect(parseRow(['', '', '', '', '03001234567'], 15, cols!)).toEqual({ kind: 'invalid', row: 15, reason: 'Naam khali' });
  });

  it('spreadsheet id from URL or bare id; A1 quoting; start row of returned range', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy';
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(parseSpreadsheetId(id)).toBe(id);
    expect(parseSpreadsheetId('not a sheet')).toBeNull();
    expect(a1("Leads Oct's", 'A2:ZZZ')).toBe("'Leads Oct''s'!A2:ZZZ");
    expect(startRowOf("'Leads'!A7:Q9")).toBe(7);
    expect(startRowOf('Sheet1!$A$12:$F$40')).toBe(12);
  });
});
