import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError, ForbiddenError } from '../lib/errors';
import { logger } from '../lib/misc';
import { auditDenied } from '../services/audit';
import { reportIssue } from '../services/devIssues';
import { errorBody } from './route';

export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = req.get('x-request-id')?.slice(0, 64) || randomUUID();
  res.set('x-request-id', req.requestId);
  next();
};

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint nahi mila.' } });
};

export const errorHandler: ErrorRequestHandler = async (err, req, res, _next) => {
  if (err instanceof ForbiddenError) {
    await auditDenied(req.actor ?? { id: null, role: null, displayName: 'anonymous', ip: req.ip }, err.denial, `${req.method} ${req.originalUrl}`);
  }
  if (err instanceof AppError) {
    res.status(err.status).json(errorBody(err));
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: { code: 'DUPLICATE', message: 'Yeh record pehle se mojood hai.', details: err.meta } });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record nahi mila.' } });
      return;
    }
    if (err.code === 'P2034') {
      res.status(409).json({ error: { code: 'TRANSACTION_CONFLICT', message: 'Doosri update ke saath takraav hua. Dobara koshish karein.' } });
      return;
    }
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON body.' } });
    return;
  }
  logger.error({ err, requestId: req.requestId, path: req.originalUrl }, 'unhandled error');
  // Unexpected failures reach the developer, naming who hit them (D-045). One notification per endpoint per hour.
  const where = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
  const reason = String((err as Error)?.message ?? err)
    .replace(/mysql:\/\/\S+/g, 'mysql://***')
    .slice(0, 1500);
  await reportIssue(req.actor ?? { id: null, role: null, displayName: 'Anonymous', ip: req.ip }, {
    area: 'Server error',
    tried: where,
    reason,
    context: { requestId: req.requestId, url: req.originalUrl.split('?')[0] },
    dedupeKey: `devissue:500:${where}:${Math.floor(Date.now() / 3_600_000)}`,
  });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Server error. Dobara koshish karein.', requestId: req.requestId } });
};
