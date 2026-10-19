import { describe, expect, it } from 'vitest';
import { cleanPhone, detectColumns, META_DEFAULT_COLUMNS, parseRow, resolveColumns } from '../../src/modules/leadSync/parse';
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
    expect(parseRow(['', '', '', '', '03001234567'], 15, cols!)).toMatchObject({ kind: 'lead', name: 'Naam nahi diya', phone: '923001234567' }); // never dropped (D-045)
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

  it('detects Meta columns from the header; every other useful column goes to remarks (D-045)', () => {
    const header = ['id', 'created_time', 'ad_id', 'ad_name', 'adset_name', 'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic', 'platform', 'which_treatment?', 'full_name', 'phone_number', 'email', 'city'];
    const d = detectColumns(header);
    expect(d.map).toEqual({
      id: 'id',
      name: 'full_name',
      phone: 'phone_number',
      extra: ['created_time', 'ad_name', 'adset_name', 'campaign_name', 'form_name', 'platform', 'which_treatment?', 'email', 'city'],
      auto: true,
    });
    const { cols } = resolveColumns(header, d.map!);
    const row = ['l:1', '2026-10-19', '9', 'Ad A', 'Set', '7', 'Laser Oct', '5', 'Form', 'false', 'ig', 'Laser', 'Sana', 'p:+923001234567', 'sana@x.pk', 'Lahore'];
    expect((parseRow(row, 2, cols!) as { remarks: string }).remarks).toContain('which_treatment?: Laser · email: sana@x.pk · city: Lahore');
  });

  it('detects plain sheets, unusual phone headers by content, and says what is missing', () => {
    expect(detectColumns(['Naam', 'Mobile No', 'Treatment']).map).toMatchObject({ name: 'Naam', phone: 'Mobile No', id: null, extra: ['Treatment'] });
    expect(detectColumns(['Customer Name', 'Rabta', 'Notes'], [['Ali', '0300 1234567', 'x'], ['Sara', '03211234567', '']]).map).toMatchObject({ name: 'Customer Name', phone: 'Rabta', extra: ['Notes'] });
    expect(detectColumns(['First Name', 'Last Name', 'Phone']).map).toMatchObject({ name: 'First Name', extra: ['Last Name'] });
    expect(detectColumns(['ad_name', 'campaign_name', 'phone']).problem).toContain('naam');
    expect(detectColumns(['full_name', 'notes']).problem).toContain('phone');
    expect(detectColumns(['', '']).problem).toContain('header');
  });
});
