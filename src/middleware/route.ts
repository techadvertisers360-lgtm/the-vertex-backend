import type { Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AppError, ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '../lib/errors';
import { sha256, toJsonSafe } from '../lib/misc';
import { hasPermission, type Permission } from '../auth/permissions';
import type { Actor } from '../services/audit';
import type { AuthUser } from './auth';

type Infer<T> = T extends ZodTypeAny ? z.infer<T> : undefined;

export interface RouteCtx<B, Q, P> {
  req: Request;
  res: Response;
  user: AuthUser;
  actor: Actor;
  body: B;
  query: Q;
  params: P;
  idempotencyKey: string | null;
}

export interface RouteOptions<B extends ZodTypeAny | undefined, Q extends ZodTypeAny | undefined, P extends ZodTypeAny | undefined> {
  /** User must hold at least one of these permissions (role-level gate). Object scope is checked in services. */
  permission: Permission | Permission[];
  body?: B;
  query?: Q;
  params?: P;
  /** Require `Idempotency-Key` and replay the stored response on retry (spec §22). */
  idempotent?: boolean;
  status?: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

function parse<T extends ZodTypeAny | undefined>(schema: T, value: unknown, where: string): Infer<T> {
  if (!schema) return undefined as Infer<T>;
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError(`Invalid ${where}`, r.error.flatten());
  return r.data as Infer<T>;
}

/**
 * Standard authenticated route: permission gate → zod validation → optional idempotency → handler.
 * The handler's return value is sent as JSON (bigint-safe).
 */
export function route<B extends ZodTypeAny | undefined = undefined, Q extends ZodTypeAny | undefined = undefined, P extends ZodTypeAny | undefined = undefined>(
  opts: RouteOptions<B, Q, P>,
  handler: (ctx: RouteCtx<Infer<B>, Infer<Q>, Infer<P>>) => Promise<unknown>,
): RequestHandler {
  const perms = Array.isArray(opts.permission) ? opts.permission : [opts.permission];
  const handlerFn: RequestHandler & { routePermissions?: Permission[] } = async (req, res) => {
    const user = req.user;
    const actor = req.actor;
    if (!user || !actor) throw new UnauthorizedError();
    if (!perms.some((p) => hasPermission(user.role, p))) {
      throw new ForbiddenError({ recordType: 'Endpoint', recordId: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}`, rule: `permission:${perms.join('|')}` });
    }
    const ctx: RouteCtx<Infer<B>, Infer<Q>, Infer<P>> = {
      req,
      res,
      user,
      actor,
      body: parse(opts.body as B, req.body, 'request body'),
      query: parse(opts.query as Q, req.query, 'query'),
      params: parse(opts.params as P, req.params, 'path parameters'),
      idempotencyKey: null,
    };

    if (!opts.idempotent) {
      const out = await handler(ctx);
      res.status(opts.status ?? 200).json(toJsonSafe(out ?? { ok: true }));
      return;
    }

    const key = req.get('idempotency-key');
    if (!key || key.length < 8 || key.length > 128) {
      throw new ValidationError('Idempotency-Key header (8–128 chars) is required for this action.');
    }
    ctx.idempotencyKey = key;
    const path = `${req.baseUrl}${req.path}`;
    const requestHash = sha256(JSON.stringify({ path, body: req.body ?? null }));

    let recordId: string;
    try {
      const rec = await prisma.idempotencyRecord.create({
        data: { key, userId: user.id, method: req.method, path, requestHash, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS) },
      });
      recordId = rec.id;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const existing = await prisma.idempotencyRecord.findUnique({ where: { userId_key: { userId: user.id, key } } });
      if (!existing) throw e;
      if (existing.requestHash !== requestHash) {
        throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'Is Idempotency-Key ke saath alag request pehle bheji ja chuki hai.');
      }
      if (existing.statusCode === null) {
        throw new ConflictError('REQUEST_IN_PROGRESS', 'Yeh request abhi process ho rahi hai. Thori dair baad status check karein.');
      }
      res.set('Idempotent-Replay', 'true').status(existing.statusCode).json(existing.responseBody);
      return;
    }

    try {
      const out = toJsonSafe(out_or_ok(await handler(ctx)));
      const status = opts.status ?? 200;
      await prisma.idempotencyRecord.update({
        where: { id: recordId },
        data: { statusCode: status, responseBody: out as Prisma.InputJsonValue },
      });
      res.status(status).json(out);
    } catch (err) {
      // Business rejections (4xx) are final for this key; server errors free the key so the client can retry.
      if (err instanceof AppError && err.status < 500) {
        const body = errorBody(err);
        await prisma.idempotencyRecord.update({ where: { id: recordId }, data: { statusCode: err.status, responseBody: body as Prisma.InputJsonValue } });
      } else {
        await prisma.idempotencyRecord.delete({ where: { id: recordId } }).catch(() => undefined);
      }
      throw err;
    }
  };
  handlerFn.routePermissions = perms;
  return handlerFn;
}

function out_or_ok(v: unknown): unknown {
  return v ?? { ok: true };
}

export function errorBody(err: AppError): Record<string, unknown> {
  return toJsonSafe({ error: { code: err.code, message: err.message, details: err.details ?? undefined } }) as Record<string, unknown>;
}

/** Common param/query schemas. */
export const idParam = z.object({ id: z.string().min(1).max(64) });
export const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(64).optional(),
};
