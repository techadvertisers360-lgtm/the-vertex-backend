import { Router, type Request } from 'express';
import { z } from 'zod';
import { createRouteHandler, createUploadthing, type FileRouter } from 'uploadthing/express';
import { UploadThingError, UTApi } from 'uploadthing/server';
import type { UploadRoute } from '@prisma/client';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/misc';
import { authenticate, requireOnSite } from '../../middleware/auth';
import { authorizeUpload, recordUpload, UPLOAD_RULES, type RouteRule } from '../../services/files';

const f = createUploadthing();
const targetInput = z.object({ recordType: z.string().min(1).max(40), recordId: z.string().min(1).max(64) });

/** One UploadThing file route per UploadRoute, each running our auth + RBAC + object scope before upload. */
function buildRoute(route: UploadRoute) {
  const rule = UPLOAD_RULES[route];
  // Private ACL only when the plan supports it (UPLOADTHING_PRIVATE_FILES=true). Otherwise no per-route ACL is sent
  // and the app default applies; the file URL is still never stored or exposed for clinical routes (D-030).
  const acl = rule.isPrivate && env.privateFiles ? ({ acl: 'private' } as const) : {};
  const config: Record<string, { maxFileSize: RouteRule['maxFileSize'] | '64MB'; maxFileCount: number; acl?: 'private' }> = {};
  for (const kind of rule.kinds) {
    config[kind] = { maxFileSize: kind === 'video' ? (rule.videoMaxFileSize ?? rule.maxFileSize) : rule.maxFileSize, maxFileCount: 10, ...acl };
  }
  return f(config)
    .input(targetInput)
    .middleware(async ({ req, input }) => {
      try {
        const user = await authenticate(req as Request);
        await requireOnSite(req as Request, user); // clinic-only users upload only on site (D-062)
        const actor = (req as Request).actor!;
        await authorizeUpload(actor, route, input);
        return { actorId: actor.id!, recordType: input.recordType, recordId: input.recordId };
      } catch (e) {
        if (e instanceof AppError) throw new UploadThingError({ code: e.status === 401 ? 'FORBIDDEN' : 'FORBIDDEN', message: e.message });
        throw e;
      }
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const att = await recordUpload(metadata.actorId, route, { recordType: metadata.recordType, recordId: metadata.recordId }, file);
      return { attachmentId: att.id };
    });
}

const routes = Object.keys(UPLOAD_RULES) as UploadRoute[];
export const uploadRouter = Object.fromEntries(routes.map((r) => [r, buildRoute(r)])) as Record<UploadRoute, ReturnType<typeof buildRoute>>;
export type OurFileRouter = typeof uploadRouter & FileRouter;

export const uploadsConfigured = Boolean(env.UPLOADTHING_TOKEN);

/** Express router mounted at /api/uploadthing. Without a token, responds 503 (dev stub endpoint is used instead). */
export function uploadthingHandler(): Router {
  if (!uploadsConfigured) {
    const r = Router();
    r.all('/', (_req, res) => {
      res.status(503).json({ error: { code: 'UPLOADS_NOT_CONFIGURED', message: 'File uploads abhi configure nahi hain (UPLOADTHING_TOKEN missing).' } });
    });
    return r;
  }
  return createRouteHandler({ router: uploadRouter, config: { token: env.UPLOADTHING_TOKEN, logLevel: 'Warning' } });
}

let utapi: UTApi | null = null;

/** Short-lived signed URL (works for private and public files). Never returned to the browser in public mode. */
export async function signedUrlFor(fileKey: string, ttlSec: number = env.SIGNED_URL_TTL_SEC): Promise<string> {
  if (!uploadsConfigured) throw new AppError(503, 'UPLOADS_NOT_CONFIGURED', 'File storage configure nahi hai.');
  utapi ??= new UTApi({ token: env.UPLOADTHING_TOKEN });
  try {
    const { ufsUrl } = await utapi.generateSignedURL(fileKey, { expiresIn: ttlSec });
    return ufsUrl;
  } catch (err) {
    logger.error({ err }, 'signed URL generation failed');
    throw new AppError(502, 'FILE_URL_FAILED', 'File link abhi nahi ban saka. Dobara koshish karein.');
  }
}
