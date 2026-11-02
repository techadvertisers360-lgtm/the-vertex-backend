import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { ValidationError } from '../../lib/errors';
import { formatRs } from '../../lib/money';
import type { exportRows } from './service';

/**
 * Invoice exports (D-084). Files are built on the server so an export can never carry more than the role may see. The
 * API runs on Vercel, which refuses responses above 4.5 MB, so an oversized file gets a clear message instead.
 */

export type ExportRow = Awaited<ReturnType<typeof exportRows>>[number];

/** Vercel's response limit is 4.5 MB; this leaves room for headers. */
const MAX_FILE_BYTES = 4_200_000;

export function assertFileFits(file: Buffer): Buffer {
  if (file.length > MAX_FILE_BYTES) throw new ValidationError('File bohat bari hai. Date range chhota karein.');
  return file;
}

const who = (r: ExportRow) => r.patient?.name ?? r.buyerName ?? 'Walk-in';
const phoneOf = (r: ExportRow) => r.patient?.phone ?? r.buyerPhone ?? '';
const statusOf = (r: ExportRow) => (r.cancelled ? 'Cancelled' : r.status === 'OPEN' ? 'Open' : 'Closed');
const numbered = (services: string[]) => services.map((s, i) => `${i + 1}. ${s}`).join('\n');

/** Exact rupees for a data file: 1234.50, never a binary float. */
export function plainRupees(p: bigint | number | null | undefined): string {
  if (p === null || p === undefined) return '';
  const v = BigInt(p);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** A name starting with = + - @ would run as a formula when a CSV opens in Excel. */
export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function invoicesCsv(rows: ExportRow[]): Buffer {
  const head = ['Invoice', 'Date', 'Kind', 'Status', 'Patient', 'Phone', 'Doctor', 'Services', 'Sub Total (Rs)', 'Discount (Rs)', 'Tax (Rs)', 'Total (Rs)', 'Paid (Rs)', 'Balance (Rs)', 'Cancel reason'];
  const body = rows.map((r) =>
    [r.number, r.date, r.kind, statusOf(r), safeCell(who(r)), phoneOf(r), safeCell(r.doctor?.name ?? ''), safeCell(numbered(r.services)), plainRupees(r.subtotalPaisa), plainRupees(r.discountPaisa), r.taxPaisa === null ? 'N/A' : plainRupees(r.taxPaisa), plainRupees(r.totalPaisa), plainRupees(r.paidPaisa), plainRupees(r.balancePaisa), safeCell(r.cancelReason ?? '')]
      .map(csvCell)
      .join(','),
  );
  // The BOM makes Excel read the file as UTF-8.
  return assertFileFits(Buffer.from(`\uFEFF${[head.join(','), ...body].join('\r\n')}\r\n`, 'utf8'));
}

export async function invoicesXlsx(rows: ExportRow[], seeDiscount: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Invoices', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'ID', key: 'number', width: 18 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Status', key: 'status', width: 11 },
    { header: 'Patient', key: 'patient', width: 26 },
    { header: 'Phone', key: 'phone', width: 15 },
    { header: 'Doctor', key: 'doctor', width: 22 },
    { header: 'Services', key: 'services', width: 40 },
    { header: 'Sub Total', key: 'subtotal', width: 13 },
    ...(seeDiscount ? [{ header: 'Discount', key: 'discount', width: 12 }] : []),
    { header: 'Tax', key: 'tax', width: 11 },
    { header: 'Total', key: 'total', width: 13 },
    { header: 'Paid', key: 'paid', width: 13 },
    { header: 'Balance', key: 'balance', width: 13 },
    { header: 'Cancel reason', key: 'reason', width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  // Display only: paisa to rupees for the sheet. No calculation ever reads these numbers back.
  const rs = (p: bigint | number | null | undefined) => (p === null || p === undefined ? null : Number(p) / 100);
  for (const r of rows) {
    const row = ws.addRow({
      number: r.number,
      date: r.date,
      status: statusOf(r),
      patient: who(r),
      phone: phoneOf(r),
      doctor: r.doctor?.name ?? '',
      services: numbered(r.services),
      subtotal: rs(r.subtotalPaisa),
      ...(seeDiscount ? { discount: rs(r.discountPaisa) } : {}),
      tax: r.taxPaisa === null ? 'N/A' : rs(r.taxPaisa),
      total: rs(r.totalPaisa),
      paid: rs(r.paidPaisa),
      balance: rs(r.balancePaisa),
      reason: r.cancelReason ?? '',
    });
    row.getCell('services').alignment = { wrapText: true, vertical: 'top' };
    if (r.cancelled) row.font = { strike: true, color: { argb: 'FF888888' } };
  }
  for (const key of ['subtotal', ...(seeDiscount ? ['discount'] : []), 'tax', 'total', 'paid', 'balance']) ws.getColumn(key).numFmt = '#,##0.00';
  return assertFileFits(Buffer.from(await wb.xlsx.writeBuffer()));
}

export function invoicesPdf(rows: ExportRow[], title: string, seeDiscount: boolean): Promise<Buffer> {
  const money = (p: bigint | number | null | undefined) => (p === null || p === undefined ? '' : formatRs(BigInt(p)));
  const cols: { head: string; w: number; cell: (r: ExportRow) => string }[] = [
    { head: 'ID', w: 88, cell: (r) => (r.cancelled ? `${r.number}\nCANCELLED` : r.number) },
    { head: 'Date', w: 58, cell: (r) => r.date },
    { head: 'Patient', w: 112, cell: (r) => who(r) },
    { head: 'Services', w: seeDiscount ? 174 : 234, cell: (r) => numbered(r.services) },
    { head: 'Sub Total', w: 60, cell: (r) => money(r.subtotalPaisa) },
    ...(seeDiscount ? [{ head: 'Discount', w: 60, cell: (r: ExportRow) => money(r.discountPaisa) }] : []),
    { head: 'Tax', w: 44, cell: (r) => (r.taxPaisa === null ? 'N/A' : money(r.taxPaisa)) },
    { head: 'Total', w: 60, cell: (r) => money(r.totalPaisa) },
    { head: 'Paid', w: 60, cell: (r) => money(r.paidPaisa) },
    { head: 'Balance', w: 60, cell: (r) => money(r.balancePaisa) },
  ];
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => {
      try {
        resolve(assertFileFits(Buffer.concat(chunks)));
      } catch (e) {
        reject(e as Error);
      }
    });

    const left = doc.page.margins.left;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const drawRow = (cells: string[], bold: boolean, y: number) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      const height = Math.max(...cells.map((c, i) => doc.heightOfString(c || ' ', { width: cols[i]!.w - 6 }))) + 6;
      let x = left;
      cells.forEach((c, i) => {
        doc.text(c, x + 3, y + 3, { width: cols[i]!.w - 6, lineBreak: true });
        x += cols[i]!.w;
      });
      doc.moveTo(left, y + height).lineTo(x, y + height).strokeColor('#cccccc').stroke();
      return y + height;
    };
    const header = (y: number) => drawRow(cols.map((c) => c.head), true, y);

    doc.font('Helvetica-Bold').fontSize(13).text(title, left, doc.page.margins.top);
    doc.font('Helvetica').fontSize(8).text(`${rows.length} invoices`);
    let y = header(doc.y + 6);
    for (const r of rows) {
      const cells = cols.map((c) => c.cell(r));
      doc.font('Helvetica').fontSize(8);
      const need = Math.max(...cells.map((c, i) => doc.heightOfString(c || ' ', { width: cols[i]!.w - 6 }))) + 6;
      if (y + need > bottom()) {
        doc.addPage();
        y = header(doc.page.margins.top);
      }
      y = drawRow(cells, false, y);
    }
    doc.end();
  });
}
