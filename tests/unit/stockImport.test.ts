import { describe, expect, it } from 'vitest';
import { parseCsv, parseExpiry, parseMoneyCell, parsePharmacyCsv, parseProcedureCsv, parseServiceCsv } from '../../src/modules/developer/stockImportParse';

describe('Developer stock CSV import — parsing (D-055)', () => {
  it('parses quoted cells, escaped quotes, commas / newlines inside quotes, CRLF and a BOM', () => {
    expect(parseCsv(String.fromCharCode(0xfeff) + 'a,b\r\n"x, y","say ""hi"""\n"two\nlines",3\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', '3'],
    ]);
  });

  it('reads money as paisa without floats', () => {
    expect(parseMoneyCell('Rs 1,250.50')).toBe(125_050n);
    expect(parseMoneyCell('90')).toBe(9_000n);
    expect(parseMoneyCell('')).toBeNull();
    expect(() => parseMoneyCell('abc')).toThrow();
  });

  it('reads expiry dates, day first; month-only means the last day of that month', () => {
    expect(parseExpiry('2027-05-31')).toBe('2027-05-31');
    expect(parseExpiry('31/05/2027')).toBe('2027-05-31');
    expect(parseExpiry('05/06/27')).toBe('2027-06-05');
    expect(parseExpiry('12/31/2027')).toBe('2027-12-31');
    expect(parseExpiry('May-27')).toBe('2027-05-31');
    expect(parseExpiry('02/2028')).toBe('2028-02-29');
    expect(parseExpiry('15 Jan 2028')).toBe('2028-01-15');
    expect(parseExpiry('46538')).toBe('2027-05-31');
    expect(parseExpiry('')).toBeNull();
    expect(() => parseExpiry('31/02/2027')).toThrow();
  });

  it('procedure file: columns by header name in any order, row errors keep their spreadsheet row', () => {
    const csv = ['Sterile,Product or Supply,Item ID,Units per Purchase Pack,Inventory Unit,Procedure / Use', 'Yes,Gloves,PR-1,100,piece,Hydrafacial', ',,PR-2,,,', 'No,Gauze,PR-3,ten,piece,PRP'].join('\n');
    const p = parseProcedureCsv(csv);
    expect(p.missing).toEqual([]);
    expect(p.rows).toEqual([expect.objectContaining({ row: 2, name: 'Gloves', code: 'PR-1', packSize: 100, sterile: true, unit: 'piece', procedureUse: 'Hydrafacial', department: null })]);
    expect(p.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(parseProcedureCsv('Item ID,Name\nA,B').missing).toEqual(['Product or Supply']);
  });

  it('pharmacy file: quantity, prices and expiry per row', () => {
    const csv = 'Batch No,Name,Distributor,Purchase Price,Selling Price,Stock Unit,Quantity,Total Purchase Price,Total Selling Price,Expiration Date\nB1,Panadol,Medi Co,"1,000",1200,box,5,5000,6000,31/12/2027\nB2,Bad,X,1,1,box,2.5,,,';
    const p = parsePharmacyCsv(csv);
    expect(p.rows).toEqual([{ row: 2, name: 'Panadol', batchNo: 'B1', distributor: 'Medi Co', purchasePricePaisa: 100_000n, sellingPricePaisa: 120_000n, unit: 'box', quantity: 5, expiry: '2027-12-31' }]);
    expect(p.errors).toEqual([{ row: 3, message: expect.stringContaining('Quantity') }]);
    expect(parsePharmacyCsv('Name\nX').missing).toEqual(['Quantity']);
  });
});

describe('Procedure / service list CSV — parsing (D-060)', () => {
  it('reads Category, Procedure / Service, Source, Note in any order; the name is required', () => {
    const p = parseServiceCsv('Note,Procedure / Service,Category,Source\nTwo sessions,Hydrafacial,Facials,In-house\n,,Laser,');
    expect(p.rows).toEqual([{ row: 2, name: 'Hydrafacial', category: 'Facials', source: 'In-house', note: 'Two sessions' }]);
    expect(p.errors.map((e) => e.row)).toEqual([3]);
    expect(parseServiceCsv('Category,Name\nA,B').missing).toEqual(['Procedure / Service']);
  });
});
