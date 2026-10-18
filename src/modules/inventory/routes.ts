import { Router } from 'express';
import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { idParam, route } from '../../middleware/route';
import * as cash from '../cash/service';
import * as demands from './demands';
import * as purchasing from './purchasing';
import * as stock from './stock';

/** Inventory (spec §14, §18). Mounted at /inventory. Costs are visible only to Manager / MD routes. */
export const inventoryRouter = Router();

const id = z.string().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paisa = z.number().int().min(0).max(1_000_000_000_00);
const reason = z.string().trim().min(2).max(2000);

// Stock, items, batches
inventoryRouter.get('/stock', route({ permission: ['stock:manage', 'reports:all'] }, async () => stock.overview()));
inventoryRouter.get('/items/:id', route({ permission: ['stock:manage', 'reports:all'], params: idParam }, async ({ params }) => stock.itemDetail(params.id)));
inventoryRouter.post(
  '/items',
  route(
    {
      permission: 'stock:manage',
      status: 201,
      body: z.object({ name: z.string().trim().min(2).max(120), category: z.string().trim().min(1).max(60), baseUnit: z.string().trim().min(1).max(20), packUnit: z.string().max(20).optional(), packSize: z.number().int().min(1).optional(), minQty: z.number().int().min(0), preferredVendorId: id.optional() }),
    },
    async ({ actor, body }) => stock.createItem(actor, body),
  ),
);
inventoryRouter.patch(
  '/items/:id',
  route({ permission: 'stock:manage', params: idParam, body: z.object({ minQty: z.number().int().min(0).optional(), preferredVendorId: id.nullable().optional(), active: z.boolean().optional() }) }, async ({ actor, params, body }) => stock.updateItem(actor, params.id, body)),
);
inventoryRouter.post(
  '/batches/:id/status',
  route({ permission: 'stock:manage', params: idParam, body: z.object({ status: z.enum(['QUARANTINED', 'AVAILABLE']), reason }) }, async ({ actor, params, body }) => stock.setBatchStatus(actor, params.id, body.status, body.reason)),
);

// Demands
inventoryRouter.get(
  '/demands',
  route({ permission: ['stock:manage', 'stock:approve_md', 'reports:all'], query: z.object({ scope: z.enum(['review', 'md', 'purchase', 'all']).default('review') }) }, async ({ query }) => demands.listDemands(query)),
);
inventoryRouter.get('/demands/:id', route({ permission: ['stock:manage', 'stock:approve_md'], params: idParam }, async ({ params }) => demands.getDemand(params.id)));
inventoryRouter.put(
  '/demands/:id/estimates',
  route({ permission: ['stock:approve_manager', 'stock:approve_md'], params: idParam, body: z.object({ lines: z.array(z.object({ lineId: id, estUnitCostPaisa: paisa })).min(1).max(30) }) }, async ({ actor, params, body }) =>
    demands.setEstimates(actor, params.id, body.lines),
  ),
);
inventoryRouter.post(
  '/demands/:id/decision',
  route({ permission: 'stock:approve_manager', params: idParam, body: z.object({ action: z.enum(['APPROVE', 'FORWARD', 'REJECT']), reason: z.string().max(2000).optional() }) }, async ({ actor, params, body }) =>
    demands.managerDecision(actor, params.id, body.action, body.reason),
  ),
);
inventoryRouter.post(
  '/demands/:id/md-decision',
  route({ permission: 'stock:approve_md', params: idParam, body: z.object({ action: z.enum(['APPROVE', 'REJECT', 'RETURN']), reason: z.string().max(2000).optional() }) }, async ({ actor, params, body }) =>
    demands.mdDecision(actor, params.id, body.action, body.reason),
  ),
);
inventoryRouter.post('/demands/:id/close', route({ permission: 'stock:manage', params: idParam, body: z.object({ reason }) }, async ({ actor, params, body }) => demands.closeDemand(actor, params.id, body.reason)));

// Purchasing
inventoryRouter.post(
  '/receipts',
  route(
    {
      permission: 'stock:manage',
      idempotent: true,
      status: 201,
      body: z.object({
        demandId: id,
        vendorId: id,
        vendorInvoiceNo: z.string().max(80).optional(),
        attachmentId: id.optional(),
        lines: z.array(z.object({ demandLineId: id, quantity: z.number().int().min(1).max(1_000_000), unitCostPaisa: paisa, lotNo: z.string().trim().min(1).max(60), expiryDate: isoDate.optional() })).min(1).max(30),
      }),
    },
    async ({ actor, body, idempotencyKey }) => purchasing.receiveGoods(actor, body, idempotencyKey!),
  ),
);
inventoryRouter.get('/vendors', route({ permission: ['stock:manage', 'reports:all'] }, async () => purchasing.listVendors()));
const vendorBody = z.object({ name: z.string().max(120), phone: z.string().max(30).optional(), address: z.string().max(500).optional(), products: z.string().max(1000).optional(), active: z.boolean().optional() });
inventoryRouter.post('/vendors', route({ permission: 'stock:manage', status: 201, body: vendorBody }, async ({ actor, body }) => purchasing.saveVendor(actor, body)));
inventoryRouter.put('/vendors/:id', route({ permission: 'stock:manage', params: idParam, body: vendorBody }, async ({ actor, params, body }) => purchasing.saveVendor(actor, { ...body, id: params.id })));
inventoryRouter.get('/vendors/:id/ledger', route({ permission: ['stock:manage', 'reports:all'], params: idParam }, async ({ params }) => purchasing.vendorLedger(params.id)));
inventoryRouter.post(
  '/vendors/:id/payments',
  route(
    { permission: 'stock:manage', params: idParam, idempotent: true, status: 201, body: z.object({ amountPaisa: z.number().int().positive(), method: z.nativeEnum(PaymentMethod), reference: z.string().max(100).optional(), bankAccountId: id.optional() }) },
    async ({ actor, params, body, idempotencyKey }) => purchasing.payVendor(actor, params.id, body, idempotencyKey!),
  ),
);
inventoryRouter.post(
  '/returns',
  route({ permission: 'stock:manage', status: 201, body: z.object({ batchId: id, quantity: z.number().int().min(1), reason }) }, async ({ actor, body }) => purchasing.returnToSupplier(actor, body)),
);
inventoryRouter.get('/bank-accounts', route({ permission: ['stock:manage', 'cash:closing'] }, async () => purchasing.bankAccounts()));

// Damage / breakage
inventoryRouter.post(
  '/damage',
  route({ permission: 'stock:demand_create', status: 201, body: z.object({ itemId: id, batchId: id.optional(), quantity: z.number().int().min(1), reason, attachmentId: id.optional() }) }, async ({ actor, body }) => stock.reportDamage(actor, body)),
);
inventoryRouter.get(
  '/damage/mine',
  route({ permission: 'stock:demand_create' }, async ({ actor }) => {
    const rows = await prisma.damageReport.findMany({ where: { reportedById: actor.id! }, orderBy: { createdAt: 'desc' }, take: 30 });
    const items = await prisma.stockItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) } }, select: { id: true, name: true, baseUnit: true } });
    return { items: rows.map((r) => ({ id: r.id, itemName: items.find((i) => i.id === r.itemId)?.name ?? '—', unit: items.find((i) => i.id === r.itemId)?.baseUnit ?? '', quantity: r.quantity, reason: r.reason, status: r.status, decisionReason: r.decisionReason, createdAt: r.createdAt })) };
  }),
);
inventoryRouter.get(
  '/damage',
  route({ permission: ['stock:approve_manager', 'stock:approve_md'], query: z.object({ scope: z.enum(['pending', 'all']).default('pending') }) }, async ({ actor, query }) => stock.listDamage(query.scope, actor.role === 'MD' ? 'MD' : 'MANAGER')),
);
inventoryRouter.post(
  '/damage/:id/decision',
  route({ permission: ['stock:approve_manager', 'stock:approve_md'], params: idParam, body: z.object({ approve: z.boolean(), reason: z.string().max(2000).optional() }) }, async ({ actor, params, body }) =>
    stock.decideDamage(actor, params.id, body.approve, body.reason),
  ),
);

/** Cash closing and reports (spec §14). Mounted at /cash. */
export const cashRouter = Router();
cashRouter.get('/day', route({ permission: ['cash:closing', 'reports:all'], query: z.object({ date: isoDate.optional() }) }, async ({ query }) => cash.daySummary(query.date)));
cashRouter.post(
  '/closings',
  route({ permission: 'cash:closing', status: 201, body: z.object({ date: isoDate, countedCashPaisa: paisa, notes: z.string().max(2000).optional(), cashierId: id.optional() }) }, async ({ actor, body }) => cash.closeDay(actor, body)),
);
cashRouter.get('/report', route({ permission: ['cash:closing', 'reports:all'], query: z.object({ from: isoDate, to: isoDate }) }, async ({ query }) => cash.report(query.from, query.to)));
cashRouter.get('/outstanding', route({ permission: ['cash:closing', 'reports:all'] }, async () => cash.outstanding()));
