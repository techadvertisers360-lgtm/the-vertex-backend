import { Router, type Response } from 'express';
import { z } from 'zod';
import { hasPermission } from '../../auth/permissions';
import { idParam, route } from '../../middleware/route';
import { MONEY_METHODS } from '../../lib/paymentMethods';
import { prisma } from '../../lib/prisma';
import { audit, type Actor } from '../../services/audit';
import { getSetting, invoiceSettingKeys, updateSetting } from '../../services/settings';
import * as reception from '../reception/service';
import { invoicesCsv, invoicesPdf, invoicesXlsx } from './export';
import { renderInvoiceNumber } from './money';
import * as svc from './service';

/** Invoice module API (D-084). Who may do what is in auth/permissions.ts, so it can change in one place. */
export const invoicesRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(64);
const paisa = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positivePaisa = paisa.positive();
const page = z.coerce.number().int().min(1).max(100_000).default(1);

const filters = z.object({ from: isoDate.optional(), to: isoDate.optional(), doctorId: id.optional(), q: z.string().trim().max(80).optional() });
const listQuery = filters.extend({ page, pageSize: z.coerce.number().refine((n) => [10, 25, 50, 100].includes(n), 'pageSize must be 10, 25, 50 or 100').default(25) });
const paging = z.object({ page, pageSize: z.coerce.number().int().min(1).max(100).default(25) });

const moneyFields = { paymentModeId: id, reference: z.string().max(100).optional(), bankAccountId: id.optional() };
const payment = z.object({ amountPaisa: paisa, ...moneyFields, extraToAdvance: z.boolean().optional(), slipAttachmentId: id.optional() });

// ───────────── List and exports (static paths first, so they are not read as an :id) ─────────────

invoicesRouter.get('/', route({ permission: 'invoice:view', query: listQuery }, async ({ user, query }) => svc.listInvoices(user.role, query)));

const MAX_EXPORT_ROWS = { xlsx: 20_000, pdf: 5_000, csv: 50_000 };
const CONTENT_TYPE = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
};

function sendFile(res: Response, kind: keyof typeof CONTENT_TYPE, name: string, file: Buffer) {
  res.set({ 'Content-Type': CONTENT_TYPE[kind], 'Content-Disposition': `attachment; filename="${name}.${kind}"`, 'Cache-Control': 'no-store' }).send(file);
}

const exportAudit = (actor: Actor, kind: string, scope: string, f: object, rows: number) =>
  audit(prisma, actor, { action: 'INVOICES_EXPORTED', recordType: 'Invoice', after: { kind, scope, filters: f, rows } });

invoicesRouter.get(
  '/export.xlsx',
  route({ permission: 'invoice:export', query: filters }, async ({ res, user, actor, query }) => {
    const rows = await svc.exportRows(user.role, query, MAX_EXPORT_ROWS.xlsx);
    const file = await invoicesXlsx(rows, hasPermission(user.role, 'invoice:view_discount'));
    await exportAudit(actor, 'xlsx', 'filtered', query, rows.length);
    sendFile(res, 'xlsx', 'invoices', file);
  }),
);

invoicesRouter.get(
  '/export.pdf',
  route({ permission: 'invoice:export', query: filters }, async ({ res, user, actor, query }) => {
    const rows = await svc.exportRows(user.role, query, MAX_EXPORT_ROWS.pdf);
    const file = await invoicesPdf(rows, `${await getSetting('clinic.name')}: Invoices`, hasPermission(user.role, 'invoice:view_discount'));
    await exportAudit(actor, 'pdf', 'filtered', query, rows.length);
    sendFile(res, 'pdf', 'invoices', file);
  }),
);

/** MD: every invoice, at any time. With from / to it can be split if the whole history no longer fits one file. */
invoicesRouter.get(
  '/export-all.csv',
  route({ permission: 'invoice:export_all', query: z.object({ from: isoDate.optional(), to: isoDate.optional() }) }, async ({ res, user, actor, query }) => {
    const f = { from: query.from ?? '2000-01-01', to: query.to ?? '2999-12-31' };
    const rows = await svc.exportRows(user.role, f, MAX_EXPORT_ROWS.csv);
    const file = invoicesCsv(rows);
    await exportAudit(actor, 'csv', 'all', query, rows.length);
    sendFile(res, 'csv', 'all-invoices', file);
  }),
);

invoicesRouter.get(
  '/export-all.xlsx',
  route({ permission: 'invoice:export_all', query: z.object({ from: isoDate.optional(), to: isoDate.optional() }) }, async ({ res, user, actor, query }) => {
    const f = { from: query.from ?? '2000-01-01', to: query.to ?? '2999-12-31' };
    const rows = await svc.exportRows(user.role, f, MAX_EXPORT_ROWS.xlsx);
    const file = await invoicesXlsx(rows, true);
    await exportAudit(actor, 'xlsx', 'all', query, rows.length);
    sendFile(res, 'xlsx', 'all-invoices', file);
  }),
);

invoicesRouter.get('/audit-log', route({ permission: 'invoice:audit', query: paging }, async ({ query }) => svc.auditHistory(query)));

// ───────────── Form data and patients ─────────────

invoicesRouter.get('/options', route({ permission: 'invoice:create' }, async () => svc.formOptions()));

invoicesRouter.get(
  '/patients',
  route({ permission: 'invoice:create', query: z.object({ q: z.string().max(80) }) }, async ({ query }) => reception.search(query.q)),
);

invoicesRouter.post(
  '/patients',
  route(
    {
      permission: 'invoice:create',
      status: 201,
      body: z.object({
        name: z.string().min(2).max(120),
        phone: z.string().min(7).max(20),
        contactConsent: z.boolean(),
        whatsappConsent: z.boolean(),
        ageYears: z.number().int().min(0).max(120).optional(),
        gender: z.string().max(20).optional(),
        confirmSharedPhone: z.object({ reason: z.string().min(3).max(300) }).optional(),
      }),
    },
    async ({ actor, body }) => reception.newPatient(actor, body),
  ),
);

invoicesRouter.get('/patients/:id/context', route({ permission: 'invoice:create', params: idParam }, async ({ params }) => svc.patientContext(params.id)));

// ───────────── Advance payments ─────────────

invoicesRouter.get(
  '/advances',
  route({ permission: 'invoice:advance', query: paging.extend({ patientId: id.optional(), q: z.string().trim().max(80).optional() }) }, async ({ query }) => svc.advanceEntries(query)),
);

invoicesRouter.post(
  '/advances',
  route(
    { permission: 'invoice:advance', idempotent: true, status: 201, body: z.object({ patientId: id, amountPaisa: positivePaisa, ...moneyFields, note: z.string().max(500).optional() }) },
    async ({ actor, body, idempotencyKey }) => svc.recordAdvance(actor, body, idempotencyKey!),
  ),
);

invoicesRouter.post(
  '/advances/patient/:id/refund',
  route(
    { permission: 'invoice:cancel', params: idParam, idempotent: true, status: 201, body: z.object({ amountPaisa: positivePaisa, ...moneyFields, reason: z.string().trim().min(3).max(500) }) },
    async ({ actor, params, body, idempotencyKey }) => svc.refundPatientAdvance(actor, params.id, body, idempotencyKey!),
  ),
);

// ───────────── Payment modes, categories, settings (MD) ─────────────

invoicesRouter.get('/payment-modes', route({ permission: 'invoice:settings' }, async () => svc.listPaymentModes()));
invoicesRouter.post(
  '/payment-modes',
  route({ permission: 'invoice:settings', status: 201, body: z.object({ name: z.string().trim().min(2).max(60), method: z.enum(MONEY_METHODS), sortOrder: z.number().int().min(0).max(1000).optional() }) }, async ({ actor, body }) => svc.addPaymentMode(actor, body)),
);
invoicesRouter.patch(
  '/payment-modes/:id',
  route({ permission: 'invoice:settings', params: idParam, body: z.object({ name: z.string().trim().min(2).max(60).optional(), active: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional() }) }, async ({ actor, params, body }) => svc.updatePaymentMode(actor, params.id, body)),
);

invoicesRouter.get('/categories', route({ permission: 'invoice:settings' }, async () => svc.listCategories()));
invoicesRouter.post(
  '/categories',
  route({ permission: 'invoice:settings', status: 201, body: z.object({ name: z.string().trim().min(2).max(60), sortOrder: z.number().int().min(0).max(1000).optional() }) }, async ({ actor, body }) => svc.addCategory(actor, body)),
);
invoicesRouter.patch(
  '/categories/:id',
  route({ permission: 'invoice:settings', params: idParam, body: z.object({ name: z.string().trim().min(2).max(60).optional(), active: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional() }) }, async ({ actor, params, body }) => svc.updateCategory(actor, params.id, body)),
);
invoicesRouter.put(
  '/services/:id/category',
  route({ permission: 'invoice:settings', params: idParam, body: z.object({ categoryId: id }) }, async ({ actor, params, body }) => svc.setServiceCategory(actor, params.id, body.categoryId)),
);

async function currentSettings() {
  const taxCardBasisPoints = await getSetting('invoice.taxCardBasisPoints');
  const [numberPrefix, numberFormat, taxEnabled, taxBasisPoints, clinicName, logoDataUrl] = await Promise.all([
    getSetting('invoice.numberPrefix'),
    getSetting('invoice.numberFormat'),
    getSetting('invoice.taxEnabled'),
    getSetting('invoice.taxBasisPoints'),
    getSetting('clinic.name'),
    getSetting('clinic.logoDataUrl'),
  ]);
  return { numberPrefix, numberFormat, taxEnabled, taxBasisPoints, taxCardBasisPoints, clinicName, logoDataUrl, numberExample: renderInvoiceNumber(numberFormat, { prefix: numberPrefix, year: new Date().getUTCFullYear(), seq: 1 }) };
}

invoicesRouter.get('/settings', route({ permission: 'invoice:settings' }, async () => currentSettings()));

invoicesRouter.put(
  '/settings',
  route(
    {
      permission: 'invoice:settings',
      body: z.object({
        numberPrefix: z.string().min(1).max(10).optional(),
        numberFormat: z.string().optional(),
        taxEnabled: z.boolean().optional(),
        taxBasisPoints: z.number().int().min(0).max(10_000).optional(),
        taxCardBasisPoints: z.number().int().min(0).max(10_000).nullable().optional(),
        clinicName: z.string().optional(),
        logoDataUrl: z.string().nullable().optional(),
      }),
    },
    async ({ actor, body }) => {
      const pairs = [
        ['invoice.numberPrefix', body.numberPrefix],
        ['invoice.numberFormat', body.numberFormat],
        ['invoice.taxEnabled', body.taxEnabled],
        ['invoice.taxBasisPoints', body.taxBasisPoints],
        ['invoice.taxCardBasisPoints', body.taxCardBasisPoints],
        ['clinic.name', body.clinicName],
        ['clinic.logoDataUrl', body.logoDataUrl],
      ] as const;
      for (const [key, value] of pairs) if (value !== undefined && invoiceSettingKeys.includes(key)) await updateSetting(actor, key, value, true);
      return currentSettings();
    },
  ),
);

// ───────────── One invoice ─────────────

invoicesRouter.post(
  '/',
  route(
    {
      permission: 'invoice:create',
      idempotent: true,
      status: 201,
      body: z.object({
        patientId: id,
        doctorId: id.nullable().optional(),
        date: isoDate.optional(),
        lines: z.array(z.object({ serviceId: id.optional(), description: z.string().trim().max(200).optional(), unitPricePaisa: paisa, quantity: z.number().int().min(1).max(1000).optional() })).min(1).max(50),
        discountPaisa: paisa.optional(),
        applyTax: z.boolean().optional(),
        useAdvancePaisa: paisa.optional(),
        payment: payment.optional(),
        confirmOpenVisit: z.boolean().optional(),
      }),
    },
    async ({ actor, body, idempotencyKey }) => svc.createDirectInvoice(actor, body, idempotencyKey!),
  ),
);

invoicesRouter.get('/:id', route({ permission: 'invoice:view', params: idParam }, async ({ user, params }) => svc.invoiceDetail(params.id, user.role)));
invoicesRouter.get('/:id/print', route({ permission: 'invoice:print', params: idParam }, async ({ params }) => svc.invoicePrint(params.id)));
invoicesRouter.get('/:id/history', route({ permission: 'invoice:audit', params: idParam, query: paging }, async ({ params, query }) => svc.auditHistory({ invoiceId: params.id, ...query })));

invoicesRouter.post(
  '/:id/payments',
  route(
    { permission: 'invoice:pay', params: idParam, idempotent: true, status: 201, body: payment.extend({ amountPaisa: positivePaisa }) },
    async ({ actor, params, body, idempotencyKey }) => svc.addPayment(actor, params.id, body, idempotencyKey!),
  ),
);

invoicesRouter.post(
  '/:id/apply-advance',
  route(
    { permission: 'invoice:pay', params: idParam, idempotent: true, status: 201, body: z.object({ amountPaisa: positivePaisa }) },
    async ({ actor, params, body, idempotencyKey }) => svc.applyAdvanceToInvoice(actor, params.id, body.amountPaisa, idempotencyKey!),
  ),
);

invoicesRouter.post(
  '/:id/cancel',
  route(
    { permission: 'invoice:cancel', params: idParam, body: z.object({ reason: z.string().trim().min(3).max(500), money: z.enum(['MOVE_TO_ADVANCE', 'REFUND']).optional() }) },
    async ({ actor, params, body }) => svc.cancelInvoice(actor, params.id, body),
  ),
);
