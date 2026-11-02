import { Router } from 'express';
import { z } from 'zod';
import { MONEY_METHODS } from '../../lib/paymentMethods';
import { clinicDateStr } from '../../lib/time';
import { idParam, route } from '../../middleware/route';
import * as desk from './desk';
import * as extra from './extras';
import * as fin from './finance';
import * as money from './money';

/** Clinic operations from the client's demo (D-089). Who may do what is in auth/permissions.ts (`ops:*`, `finance:owner`). */
export const opsRouter = Router();

const id = z.string().min(1).max(64);
const paisa = z.number().int().min(0).max(100_000_000_000);
const positive = paisa.min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const thisMonth = () => clinicDateStr(new Date()).slice(0, 7);
const monthQuery = z.object({ month: month.optional() });
const statusQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() });
const textQuery = z.object({ q: z.string().max(80).optional() });
const decision = z.object({ approve: z.boolean(), note: z.string().max(1000).optional() });
const source = z.enum(['OWNER', 'RECEPTION_DRAWER', 'MANAGER', 'BANK']);
const staffParam = z.object({ id });

const DESK = 'ops:desk' as const;
const MANAGE = 'ops:manage' as const;
const OWNER = 'finance:owner' as const;

// Clinic now, plans
opsRouter.get('/clinic-now', route({ permission: [MANAGE, OWNER] }, async () => desk.clinicNow()));
opsRouter.get('/plans', route({ permission: [DESK, MANAGE, OWNER, 'doctor:share'], query: textQuery }, async ({ actor, query }) => desk.openPlans(query.q, actor.role === 'DOCTOR' ? actor.id! : undefined)));

// Part payment and bill correction
opsRouter.get('/invoice-requests', route({ permission: [DESK, MANAGE, OWNER, 'doctor:share'], query: statusQuery }, async ({ actor, query }) => money.listInvoiceRequests(actor, query.status)));
opsRouter.post(
  '/invoice-requests',
  route({ permission: DESK, status: 201, body: z.object({ type: z.enum(['PART_PAYMENT', 'BILL_CORRECTION']), invoiceId: id, amountAskedPaisa: paisa.optional(), note: z.string().max(1000) }) }, async ({ actor, body }) => money.createInvoiceRequest(actor, body)),
);
opsRouter.post(
  '/invoice-requests/:id/decide',
  route({ permission: [MANAGE, OWNER, 'doctor:share'], params: idParam, body: decision.extend({ amountApprovedPaisa: paisa.optional(), adjustmentPaisa: z.number().int().min(-100_000_000_000).max(100_000_000_000).optional() }) }, async ({ actor, params, body }) => money.decideInvoiceRequest(actor, params.id, body)),
);

// Cash handover
opsRouter.get('/handovers', route({ permission: [DESK, MANAGE, OWNER], query: z.object({ date: isoDate.optional() }) }, async ({ actor, query }) => money.listHandovers(actor, query.date)));
opsRouter.post(
  '/handovers',
  route({ permission: [DESK, MANAGE, OWNER], status: 201, body: z.object({ date: isoDate.optional(), amountPaisa: positive, leftAtDeskPaisa: paisa.optional(), toId: id, note: z.string().max(500).optional() }) }, async ({ actor, body }) => money.createHandover(actor, body)),
);
opsRouter.post('/handovers/:id/confirm', route({ permission: [DESK, MANAGE, OWNER], params: idParam }, async ({ actor, params }) => money.confirmHandover(actor, params.id)));

// Pharmacy sale returns
opsRouter.get('/sale-returns/sales', route({ permission: [DESK, MANAGE], query: textQuery }, async ({ query }) => money.returnableSales(query.q)));
opsRouter.get('/sale-returns', route({ permission: [DESK, MANAGE, OWNER], query: statusQuery }, async ({ query }) => money.listSaleReturns(query.status)));
opsRouter.post(
  '/sale-returns',
  route(
    { permission: [DESK, MANAGE], status: 201, body: z.object({ invoiceLineId: id, quantity: z.number().int().min(1), restock: z.boolean(), method: z.enum(MONEY_METHODS), bankAccountId: id.optional(), reference: z.string().max(100).optional(), reason: z.string().max(1000) }) },
    async ({ actor, body }) => money.requestSaleReturn(actor, body),
  ),
);
opsRouter.post('/sale-returns/:id/decide', route({ permission: [MANAGE, OWNER], params: idParam, body: decision }, async ({ actor, params, body }) => money.decideSaleReturn(actor, params.id, body)));

// Expenses; the desk can record cash paid out of the drawer
opsRouter.get('/expenses', route({ permission: OWNER, query: monthQuery }, async ({ query }) => money.listExpenses(query.month ?? thisMonth())));
const expense = z.object({ date: isoDate.optional(), category: z.string().trim().min(2).max(60), description: z.string().max(200), amountPaisa: positive });
opsRouter.post('/expenses', route({ permission: OWNER, status: 201, body: expense.extend({ paidFrom: source }) }, async ({ actor, body }) => money.addExpense(actor, body)));
opsRouter.post('/cash-out', route({ permission: [DESK, MANAGE], status: 201, body: expense }, async ({ actor, body }) => money.addExpense(actor, { ...body, paidFrom: 'RECEPTION_DRAWER' })));

// Doctor ledger
opsRouter.get('/doctor-ledger', route({ permission: OWNER, query: monthQuery.extend({ doctorId: id.optional() }) }, async ({ query }) => fin.doctorLedger(query.month ?? thisMonth(), query.doctorId)));
opsRouter.get('/doctor-ledger/manager', route({ permission: MANAGE, query: monthQuery }, async ({ query }) => fin.doctorLedgerForManager(query.month ?? thisMonth())));
opsRouter.get('/my-share', route({ permission: 'doctor:share', query: monthQuery }, async ({ actor, query }) => fin.myShare(actor, query.month ?? thisMonth())));
opsRouter.put(
  '/doctor-ledger/:id/rule',
  route(
    { permission: OWNER, params: staffParam, body: z.object({ ownConsultBp: z.number().int().min(0).max(10_000), ownProcedureBp: z.number().int().min(0).max(10_000), clinicConsultBp: z.number().int().min(0).max(10_000), clinicProcedureBp: z.number().int().min(0).max(10_000), fixedCostPaisa: paisa }) },
    async ({ actor, params, body }) => fin.setShareRule(actor, params.id, body),
  ),
);
opsRouter.put('/doctor-ledger/:id/own-patient', route({ permission: OWNER, params: staffParam, body: z.object({ patientId: id, own: z.boolean() }) }, async ({ actor, params, body }) => fin.setOwnPatient(actor, params.id, body.patientId, body.own)));
opsRouter.post(
  '/doctor-ledger/:id/pay',
  route({ permission: OWNER, status: 201, params: staffParam, body: z.object({ amountPaisa: positive, method: z.string().min(2).max(30), reference: z.string().max(100).optional(), note: z.string().max(500).optional() }) }, async ({ actor, params, body }) => fin.payDoctor(actor, params.id, body)),
);

// Costs, profit and loss
opsRouter.get('/procedure-costs', route({ permission: OWNER, query: monthQuery }, async ({ query }) => fin.procedureCosts(query.month ?? thisMonth())));
opsRouter.get('/profit-loss', route({ permission: OWNER, query: monthQuery }, async ({ query }) => fin.profitAndLoss(query.month ?? thisMonth())));

// Payroll
opsRouter.get('/staff', route({ permission: OWNER, query: monthQuery }, async ({ query }) => fin.staffList(query.month ?? thisMonth())));
opsRouter.put(
  '/staff/:id',
  route(
    { permission: OWNER, params: staffParam, body: z.object({ salaryPaisa: paisa.optional(), workingDays: z.number().int().min(1).max(31).optional(), startDate: isoDate.nullable().optional(), emergencyContact: z.string().max(40).nullable().optional(), personalEmail: z.string().email().max(120).nullable().optional() }) },
    async ({ actor, params, body }) => fin.saveStaffProfile(actor, params.id, body),
  ),
);
opsRouter.post('/staff/:id/marks', route({ permission: [OWNER, MANAGE], status: 201, params: staffParam, body: z.object({ month, kind: z.enum(['ABSENCE', 'LATE', 'UNIFORM', 'WARNING', 'POINTS']), points: z.number().int().min(1).max(5).optional(), note: z.string().max(500).optional() }) }, async ({ actor, params, body }) => fin.addStaffMark(actor, params.id, body)));
opsRouter.post('/staff/:id/advance', route({ permission: OWNER, status: 201, params: staffParam, body: z.object({ amountPaisa: positive, note: z.string().max(500).optional() }) }, async ({ actor, params, body }) => fin.giveAdvance(actor, params.id, body)));
opsRouter.post('/staff/:id/pay', route({ permission: OWNER, status: 201, params: staffParam, body: z.object({ month, advanceCutPaisa: paisa, bonusPaisa: paisa.optional() }) }, async ({ actor, params, body }) => fin.paySalary(actor, params.id, body)));

// Packages
opsRouter.get('/package-types', route({ permission: [DESK, MANAGE, OWNER] }, async () => ({ items: await desk.listPackageTypes() })));
opsRouter.post('/package-types', route({ permission: [MANAGE, OWNER], status: 201, body: z.object({ name: z.string().trim().min(2).max(100), kind: z.enum(['PACKAGE', 'MEMBERSHIP']), sessions: z.number().int().min(1).max(1000), pricePaisa: positive, validDays: z.number().int().min(1).max(3650).nullable().optional() }) }, async ({ actor, body }) => desk.savePackageType(actor, body)));
opsRouter.get('/packages', route({ permission: [DESK, MANAGE, OWNER], query: textQuery }, async ({ query }) => desk.listPackageSales(query.q)));
opsRouter.post(
  '/packages',
  route(
    { permission: DESK, idempotent: true, status: 201, body: z.object({ typeId: id, patientId: id, payment: z.object({ amountPaisa: positive, paymentModeId: id, reference: z.string().max(100).optional(), bankAccountId: id.optional() }).optional() }) },
    async ({ actor, body, idempotencyKey }) => desk.sellPackage(actor, body, idempotencyKey!),
  ),
);
opsRouter.post('/packages/:id/use', route({ permission: DESK, status: 201, params: idParam, body: z.object({ note: z.string().max(300).optional() }) }, async ({ actor, params, body }) => desk.usePackageSession(actor, params.id, body.note)));

// Purchase orders
opsRouter.get('/purchase-orders', route({ permission: [DESK, MANAGE, OWNER] }, async () => desk.listPurchaseOrders()));
opsRouter.post('/purchase-orders', route({ permission: [DESK, MANAGE], status: 201, body: z.object({ vendorId: id, lines: z.array(z.object({ itemId: id.optional(), name: z.string().max(120).optional(), quantity: z.number().int().min(1) })).max(100) }) }, async ({ actor, body }) => desk.createPurchaseOrder(actor, body)));
opsRouter.post('/purchase-orders/:id/decide', route({ permission: [DESK, MANAGE], params: idParam, body: z.object({ action: z.enum(['RECEIVED', 'CANCELLED']), vendorBillNo: z.string().max(60).optional(), received: z.array(z.object({ lineId: id, quantity: z.number().int().min(0), costPaisa: paisa.optional(), expiryDate: isoDate.optional() })).optional() }) }, async ({ actor, params, body }) => desk.decidePurchaseOrder(actor, params.id, body)));

// Office purchases
opsRouter.get('/office-purchases', route({ permission: ['office:purchase', MANAGE, OWNER, DESK] }, async ({ actor }) => desk.listOfficePurchases(actor)));
opsRouter.post('/office-purchases', route({ permission: 'office:purchase', status: 201, body: z.object({ items: z.array(z.object({ name: z.string().trim().min(2).max(100), quantity: z.string().trim().min(1).max(30), approxPaisa: paisa })).min(1).max(30) }) }, async ({ actor, body }) => desk.requestOfficePurchase(actor, body)));
opsRouter.post('/office-purchases/:id/decide', route({ permission: [MANAGE, OWNER], params: idParam, body: z.object({ action: z.enum(['APPROVE', 'REJECT', 'SEND_TO_OWNERS']), budgetPaisa: paisa.optional(), cashFrom: source.optional(), note: z.string().max(500).optional() }) }, async ({ actor, params, body }) => desk.decideOfficePurchase(actor, params.id, body)));
opsRouter.post('/office-purchases/:id/settle', route({ permission: [MANAGE, OWNER, DESK], params: idParam, body: z.object({ billTotalPaisa: paisa, billAttachmentId: id.optional() }) }, async ({ actor, params, body }) => desk.settleOfficePurchase(actor, params.id, body)));

// Chat
opsRouter.get('/chat/rooms', route({ permission: 'chat:use' }, async ({ actor }) => desk.chatRooms(actor)));
const roomParam = z.object({ room: z.string().min(1).max(40) });
opsRouter.get('/chat/:room', route({ permission: 'chat:use', params: roomParam }, async ({ actor, params }) => desk.chatMessages(actor, params.room)));
opsRouter.post('/chat/:room', route({ permission: 'chat:use', status: 201, params: roomParam, body: z.object({ body: z.string().max(2000) }) }, async ({ actor, params, body }) => desk.sendChat(actor, params.room, body.body)));

// Documents, data check
opsRouter.get('/documents', route({ permission: [DESK, MANAGE, OWNER], query: textQuery }, async ({ query }) => desk.searchDocuments(query.q)));
opsRouter.get('/saved-reports/:id', route({ permission: [DESK, MANAGE, OWNER], params: idParam }, async ({ params }) => desk.savedReport(params.id)));
opsRouter.get('/data-check', route({ permission: OWNER }, async () => desk.dataCheck()));

// Standard kits
opsRouter.get('/kits', route({ permission: [MANAGE, OWNER] }, async () => desk.listKits()));
opsRouter.put('/kits', route({ permission: [MANAGE, OWNER], body: z.object({ serviceId: id, itemId: id, quantity: z.number().int().min(1) }) }, async ({ actor, body }) => desk.saveKitItem(actor, body)));
opsRouter.post('/kits/:id/remove', route({ permission: [MANAGE, OWNER], params: idParam }, async ({ actor, params }) => desk.removeKitItem(actor, params.id)));
opsRouter.get('/kits/for-procedure', route({ permission: 'assistant:tasks', query: z.object({ name: z.string().max(200) }) }, async ({ query }) => desk.kitForProcedure(query.name)));

// Room held for a video shoot
opsRouter.get('/room-holds', route({ permission: [MANAGE, OWNER] }, async () => desk.listRoomHolds()));
opsRouter.post('/room-holds', route({ permission: MANAGE, status: 201, body: z.object({ roomId: id, startAt: z.string().max(40), minutes: z.number().int().min(10).max(600), purpose: z.string().trim().min(2).max(100) }) }, async ({ actor, body }) => desk.holdRoom(actor, body)));
opsRouter.post('/room-holds/:id/cancel', route({ permission: MANAGE, params: idParam }, async ({ actor, params }) => desk.releaseRoomHold(actor, params.id)));

// Vendor payment requests
opsRouter.get('/vendor-payments', route({ permission: [MANAGE, OWNER] }, async () => extra.listVendorPayments()));
opsRouter.post('/vendor-payments', route({ permission: MANAGE, status: 201, body: z.object({ vendorId: id, amountPaisa: positive, note: z.string().max(500) }) }, async ({ actor, body }) => extra.requestVendorPayment(actor, body)));
opsRouter.post('/vendor-payments/:id/decide', route({ permission: OWNER, params: idParam, body: decision }, async ({ actor, params, body }) => extra.decideVendorPayment(actor, params.id, body)));
opsRouter.post('/vendor-payments/:id/record', route({ permission: [MANAGE, OWNER], params: idParam, body: z.object({ method: z.enum(MONEY_METHODS), reference: z.string().max(100).optional(), bankAccountId: id.optional() }) }, async ({ actor, params, body }) => extra.recordVendorPayment(actor, params.id, body)));

// Messages
opsRouter.post('/invoices/:id/payment-message', route({ permission: [DESK, 'invoice:pay'], params: idParam }, async ({ actor, params }) => extra.sendPaymentMessage(actor, params.id)));
opsRouter.post('/staff/:id/send-login', route({ permission: OWNER, params: staffParam }, async ({ actor, params }) => extra.sendLoginMessage(actor, params.id)));

// Lowest price, departments
opsRouter.get('/products', route({ permission: OWNER }, async () => extra.listProducts()));
opsRouter.put('/products/:id/floor-price', route({ permission: OWNER, params: idParam, body: z.object({ floorPaisa: paisa.nullable() }) }, async ({ actor, params, body }) => extra.setFloorPrice(actor, params.id, body.floorPaisa)));
opsRouter.get('/departments', route({ permission: [MANAGE, OWNER] }, async () => extra.listDepartments()));
opsRouter.put('/departments/doctors/:id', route({ permission: [MANAGE, OWNER], params: idParam, body: z.object({ departments: z.array(z.string().max(60)).max(20) }) }, async ({ actor, params, body }) => extra.setDoctorDepartments(actor, params.id, body.departments)));
opsRouter.put('/departments/services/:id', route({ permission: [MANAGE, OWNER], params: idParam, body: z.object({ department: z.string().max(60).nullable() }) }, async ({ actor, params, body }) => extra.setServiceDepartment(actor, params.id, body.department)));

// New items from the Assistant
opsRouter.get('/new-items', route({ permission: OWNER }, async () => extra.listNewItems()));
opsRouter.put('/new-items/:id', route({ permission: OWNER, params: idParam, body: z.object({ unit: z.string().trim().min(1).max(30), minQty: z.number().int().min(0).max(100_000), costPaisa: paisa }) }, async ({ actor, params, body }) => extra.completeNewItem(actor, params.id, body)));

// Patient feedback by person
opsRouter.get('/feedback-report', route({ permission: [OWNER, MANAGE], query: monthQuery }, async ({ query }) => extra.feedbackReport(query.month ?? thisMonth())));

// Campaign performance
opsRouter.get('/campaigns', route({ permission: [OWNER, 'marketing:dashboard'], query: monthQuery }, async ({ query }) => desk.campaignPerformance(query.month ?? thisMonth())));
opsRouter.put('/campaigns', route({ permission: OWNER, body: z.object({ campaign: z.string().min(1).max(191), month, spendPaisa: paisa }) }, async ({ actor, body }) => desk.setCampaignSpend(actor, body)));
