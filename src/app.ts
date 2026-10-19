import express, { Router, type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { requireAuth, requireClientHeader } from './middleware/auth';
import { errorHandler, notFound, requestId } from './middleware/error';
import { authRouter, meRouter } from './modules/auth/routes';
import { notificationsRouter, settingsRouter } from './modules/common/routes';
import { filesRouter } from './modules/files/routes';
import { uploadthingHandler } from './modules/files/uploadthing';
import { usersRouter } from './modules/users/routes';
import { schedulingRouter } from './modules/scheduling/routes';
import { leadReportsRouter, leadRouter } from './modules/leads/routes';
import { requestsRouter } from './modules/requests/routes';
import { receptionRouter } from './modules/reception/routes';
import { attendanceRouter } from './modules/attendance/routes';
import { publicRouter } from './modules/public/routes';
import { doctorRouter, managerApprovalsRouter } from './modules/doctor/routes';
import { assistantRouter, managerProceduresRouter, receptionProceduresRouter } from './modules/assistant/routes';
import { managerOfficeRouter, officeRouter, stockRouter } from './modules/office/routes';
import { managerRouter } from './modules/manager/routes';
import { cashRouter, inventoryRouter } from './modules/inventory/routes';
import { leadAdminRouter, mdRouter, offersRouter, performanceNotesRouter } from './modules/md/routes';
import { webhooksRouter } from './modules/messaging/webhooks';
import { messagesRouter } from './modules/messaging/routes';
import { cronRouter, realtimeRouter } from './modules/platform/routes';
import { developerRouter } from './modules/developer/routes';
import { relayAfterResponse } from './realtime/afterResponse';
import { pushRouter } from './modules/push/routes';
import { pushEnabled } from './services/push';

/**
 * Authenticated routers in mount order (all behind requireAuth). Exported so the authorization test can walk every
 * route and prove the server rejects roles without the route's permission (spec §25 last item).
 */
export const API_MOUNTS: [string, Router][] = [
  ['/me', meRouter],
  ['/notifications', notificationsRouter],
  ['/push', pushRouter],
  ['/settings', settingsRouter],
  ['/users', usersRouter],
  ['/files', filesRouter],
  ['/scheduling', schedulingRouter],
  ['/lead', leadRouter],
  ['/lead-reports', leadReportsRouter],
  ['/requests', requestsRouter],
  ['/reception', receptionRouter],
  ['/reception', receptionProceduresRouter],
  ['/assistant', assistantRouter],
  ['/attendance', attendanceRouter],
  ['/doctor', doctorRouter],
  ['/manager/messages', messagesRouter],
  ['/manager/approvals', managerApprovalsRouter],
  ['/manager', managerProceduresRouter],
  ['/manager', managerOfficeRouter],
  ['/manager', managerRouter],
  ['/inventory', inventoryRouter],
  ['/cash', cashRouter],
  ['/md', mdRouter],
  ['/lead-admin', leadAdminRouter],
  ['/offers', offersRouter],
  ['/lead-reports', performanceNotesRouter],
  ['/office', officeRouter],
  ['/stock', stockRouter],
  ['/realtime', realtimeRouter],
  ['/developer', developerRouter],
];

/** Express app factory (no listen) so integration tests can drive it with supertest. */
export function createApp(): Express {
  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-VH-Client', 'X-Request-Id', 'x-uploadthing-package', 'x-uploadthing-version', 'traceparent', 'b3'],
    }),
  );
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Root: lets anyone opening the deployed backend URL see the API is up (no data, no auth).
  app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'Vertex Health API', version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local', time: new Date().toISOString() });
  });

  // UploadThing parses its own body and receives server callbacks without cookies; auth runs inside its middleware.
  app.use('/api/uploadthing', uploadthingHandler());

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', requireClientHeader);
  // Serverless (Supabase realtime): deliver what this request published once its transaction has committed.
  // Serverless relays run after the response: Supabase live events and/or Web Push (D-042, D-046).
  if (env.REALTIME_PROVIDER === 'supabase' || pushEnabled()) app.use(relayAfterResponse);

  // Unauthenticated
  app.use('/api/auth', authRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/cron', cronRouter); // CRON_SECRET-protected worker cycle (D-042)

  // Authenticated
  const api = Router();
  api.use(requireAuth);
  for (const [path, router] of API_MOUNTS) api.use(path, router);
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
