import { Router } from 'express';
import { z } from 'zod';
import { idParam, route } from '../../middleware/route';
import { prisma } from '../../lib/prisma';
import { audit } from '../../services/audit';
import { notifyUsers } from '../../services/notifications';
import * as lead from '../leadAdmin/service';
import * as sync from '../leadSync/service';
import { columnMapSchema } from '../leadSync/parse';
import { parseSpreadsheetId } from '../../services/googleSheets';
import { ValidationError } from '../../lib/errors';
import * as offers from '../offers/service';
import * as md from './service';

/** MD (spec §15). Mounted at /md. */
export const mdRouter = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = { from: isoDate, to: isoDate };

mdRouter.get('/dashboard', route({ permission: 'md:dashboard' }, async ({ actor }) => md.dashboard(actor)));
mdRouter.get('/approvals', route({ permission: 'md:approvals' }, async ({ actor }) => md.approvals(actor)));
mdRouter.get(
  '/history',
  route({ permission: ['md:approvals', 'reports:all'], query: z.object({ recordType: z.string().max(60), recordId: z.string().max(64) }) }, async ({ query }) => md.history(query.recordType, query.recordId)),
);
mdRouter.get('/leave-impacts', route({ permission: 'md:dashboard' }, async () => md.leaveImpacts()));
mdRouter.post(
  '/leave-impacts/:id/escalate',
  route({ permission: 'md:dashboard', params: idParam, body: z.object({ note: z.string().trim().min(2).max(2000) }) }, async ({ actor, params, body }) => md.nudgeLeaveImpact(actor, params.id, body.note)),
);
mdRouter.get('/escalated-reports', route({ permission: 'md:dashboard' }, async () => md.escalatedReports()));
mdRouter.get('/reports/staff', route({ permission: 'reports:all', query: z.object({ ...range, userId: z.string().max(64).optional() }) }, async ({ query }) => md.staffReport(query.from, query.to, query.userId)));
mdRouter.get('/reports/purchases', route({ permission: 'reports:all', query: z.object(range) }, async ({ query }) => md.purchaseReport(query.from, query.to)));
mdRouter.get('/reports/completed', route({ permission: 'reports:all', query: z.object({ ...range, action: z.string().max(60).optional() }) }, async ({ query }) => md.completedActions(query.from, query.to, query.action)));

/** Lead Team admin (Hamza Zafar / Usama Sufain only — `leads:admin`). Mounted at /lead-admin. */
export const leadAdminRouter = Router();
leadAdminRouter.get('/members', route({ permission: 'leads:admin' }, async () => lead.members()));
leadAdminRouter.post(
  '/members',
  route(
    {
      permission: 'leads:admin',
      status: 201,
      body: z.object({ displayName: z.string().trim().min(2).max(100), memberCode: z.string().regex(/^[A-Za-z0-9-]{3,20}$/).optional(), phone: z.string().min(7).max(20).optional(), email: z.string().email().max(120).optional(), password: z.string().min(8).max(200) }),
    },
    async ({ actor, body }) => lead.addMember(actor, body),
  ),
);
leadAdminRouter.patch(
  '/members/:id',
  route(
    { permission: 'leads:admin', params: idParam, body: z.object({ displayName: z.string().trim().min(2).max(100).optional(), phone: z.string().min(7).max(20).nullable().optional(), email: z.string().email().max(120).nullable().optional(), active: z.boolean().optional() }) },
    async ({ actor, params, body }) => lead.updateMember(actor, params.id, body),
  ),
);
const sheetSource = { googleSheetId: z.string().max(500).nullable().optional(), tabName: z.string().max(100).nullable().optional(), columnMap: columnMapSchema.nullable().optional() };
leadAdminRouter.get('/sheets', route({ permission: 'leads:admin' }, async () => lead.sheets()));
leadAdminRouter.post(
  '/sheets',
  route(
    // With a Google Sheet link everything else is optional — it is read from the sheet (D-045).
    { permission: 'leads:admin', status: 201, body: z.object({ externalId: z.string().trim().max(200).optional(), title: z.string().trim().max(200).optional(), campaign: z.string().trim().max(200).optional(), ...sheetSource }) },
    async ({ actor, body }) => lead.createSheet(actor, body),
  ),
);
leadAdminRouter.patch(
  '/sheets/:id',
  route({ permission: 'leads:admin', params: idParam, body: z.object({ title: z.string().max(200).optional(), campaign: z.string().max(200).optional(), active: z.boolean().optional(), ...sheetSource }) }, async ({ actor, params, body }) =>
    lead.updateSheet(actor, params.id, body),
  ),
);
/** Google Sheets sync (Phase 9b, D-039). The service account key never leaves the server; only its email is shown. */
leadAdminRouter.get('/sync-config', route({ permission: 'leads:admin' }, async () => sync.syncConfig()));
leadAdminRouter.post(
  '/sheets/test-connection',
  route(
    { permission: 'leads:admin', body: z.object({ googleSheetId: z.string().trim().min(1).max(500), tabName: z.string().trim().max(100).nullable().optional(), columnMap: columnMapSchema.nullable().optional() }) },
    async ({ actor, body }) => {
      const id = parseSpreadsheetId(body.googleSheetId);
      if (!id) throw new ValidationError('Yeh Google Sheet ka link nahi lagta — browser se poora sheet link copy karke paste karein.');
      return sync.testConnection(actor, { googleSheetId: id, link: body.googleSheetId, tabName: body.tabName || null, columnMap: body.columnMap ?? null });
    },
  ),
);
leadAdminRouter.post('/sheets/:id/sync', route({ permission: 'leads:admin', params: idParam }, async ({ actor, params }) => sync.syncNow(actor, params.id)));
leadAdminRouter.get('/sheets/:id/sync-runs', route({ permission: 'leads:admin', params: idParam }, async ({ params }) => sync.syncRuns(params.id)));
leadAdminRouter.post('/sheets/:id/assign', route({ permission: 'leads:admin', params: idParam, body: z.object({ memberId: z.string().min(1).max(64) }) }, async ({ actor, params, body }) => lead.assignSheet(actor, params.id, body.memberId)));
leadAdminRouter.post('/sheets/:id/unassign', route({ permission: 'leads:admin', params: idParam }, async ({ actor, params }) => lead.unassignSheet(actor, params.id)));

/** Offers / creatives (spec §17). Mounted at /offers. */
export const offersRouter = Router();
offersRouter.get('/active', route({ permission: 'offers:read' }, async () => offers.activeOffers()));
offersRouter.get('/', route({ permission: 'marketing:offers' }, async () => offers.allOffers()));
offersRouter.post(
  '/',
  route(
    {
      permission: 'marketing:offers',
      status: 201,
      body: z.object({ title: z.string().trim().min(2).max(200), serviceName: z.string().max(200).optional(), description: z.string().max(2000).optional(), sheetId: z.string().max(64).optional(), validFrom: z.coerce.date(), validTo: z.coerce.date(), attachmentId: z.string().min(1).max(64) }),
    },
    async ({ actor, body }) => offers.createOffer(actor, body),
  ),
);
offersRouter.post('/:id/withdraw', route({ permission: 'marketing:offers', params: idParam, body: z.object({ reason: z.string().trim().min(2).max(1000) }) }, async ({ actor, params, body }) => offers.withdrawOffer(actor, params.id, body.reason)));

/** Performance notes: Muaz annotates a view and sends the issue / action to Hamza (spec §17). Mounted at /lead-reports. */
export const performanceNotesRouter = Router();
performanceNotesRouter.post(
  '/notes',
  route(
    { permission: 'leads:reports', status: 201, body: z.object({ memberId: z.string().max(64).optional(), sheetId: z.string().max(64).optional(), from: isoDate, to: isoDate, note: z.string().trim().min(3).max(4000) }) },
    async ({ actor, body }) =>
      prisma.$transaction(async (tx) => {
        const n = await tx.performanceNote.create({ data: { authorId: actor.id!, memberId: body.memberId ?? null, sheetId: body.sheetId ?? null, fromDate: body.from, toDate: body.to, note: body.note } });
        await audit(tx, actor, { action: 'PERFORMANCE_NOTE', recordType: 'PerformanceNote', recordId: n.id, after: n });
        const hamza = (await tx.user.findMany({ where: { role: 'MARKETING_DIRECTOR', active: true }, select: { id: true } })).map((u) => u.id).filter((id) => id !== actor.id);
        const [member, sheet] = await Promise.all([body.memberId ? tx.user.findUnique({ where: { id: body.memberId }, select: { displayName: true } }) : null, body.sheetId ? tx.metaSheet.findUnique({ where: { id: body.sheetId }, select: { title: true } }) : null]);
        const scope = [member?.displayName, sheet?.title, `${body.from} → ${body.to}`].filter(Boolean).join(' · ');
        await notifyUsers(tx, hamza, { type: 'PERFORMANCE_NOTE', subject: `Performance note from ${actor.displayName}`, body: `${scope}: ${body.note}`, recordType: 'PerformanceNote', recordId: n.id, sender: actor, priority: 1, dedupeKey: `perfnote:${n.id}` });
        return n;
      }),
  ),
);
/** Lead sync health for Hamza / Muaz / MD dashboards (no Google IDs or column details). */
performanceNotesRouter.get('/sync-status', route({ permission: 'leads:reports' }, async () => sync.syncStatus()));
performanceNotesRouter.get(
  '/notes',
  route({ permission: 'leads:reports' }, async () => {
    const rows = await prisma.performanceNote.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.authorId, r.memberId].filter((x): x is string => !!x)))] } }, select: { id: true, displayName: true } });
    const sheets = await prisma.metaSheet.findMany({ where: { id: { in: rows.map((r) => r.sheetId).filter((x): x is string => !!x) } }, select: { id: true, title: true } });
    return { items: rows.map((r) => ({ ...r, author: users.find((u) => u.id === r.authorId)?.displayName ?? null, member: users.find((u) => u.id === r.memberId)?.displayName ?? null, sheet: sheets.find((s) => s.id === r.sheetId)?.title ?? null })) };
  }),
);
