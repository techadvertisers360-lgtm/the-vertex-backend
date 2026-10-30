import { Router } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { UploadRoute } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors';
import { hasPermission } from '../../auth/permissions';
import { randomToken } from '../../lib/misc';
import { idParam, route } from '../../middleware/route';
import { audit } from '../../services/audit';
import { authorizeRead, authorizeUpload, recordUpload } from '../../services/files';
import { signedUrlFor, uploadsConfigured } from './uploadthing';

export const filesRouter = Router();

/**
 * How the browser may open one attachment, after role + record scope check (spec §22):
 *  - public, non-clinical files (ad creatives): their stored public URL;
 *  - clinical files with UPLOADTHING_PRIVATE_FILES=true: a short-lived signed URL;
 *  - clinical files on the free plan (flag false): our own proxy URL — the UploadThing URL never reaches the
 *    browser and every byte request is re-authorized (D-030).
 */
filesRouter.get(
  '/:id/url',
  route({ permission: 'files:read', params: idParam }, async ({ actor, params }) => {
    const att = await prisma.attachment.findUnique({ where: { id: params.id } });
    if (!att) throw new NotFoundError('File');
    await authorizeRead(actor, att);
    if (!att.isPrivate && att.publicUrl) return { url: att.publicUrl, expiresInSec: null, mode: 'public' };
    if (att.fileKey.startsWith('dev_')) return { url: null, stub: true, expiresInSec: 0, fileName: att.fileName, mode: 'stub' };
    if (env.privateFiles) {
      const url = await signedUrlFor(att.fileKey);
      await audit(prisma, actor, { action: 'FILE_URL_ISSUED', recordType: att.recordType, recordId: att.recordId, after: { attachmentId: att.id, mode: 'signed' } });
      return { url, expiresInSec: env.SIGNED_URL_TTL_SEC, mode: 'signed' };
    }
    return { url: `/api/files/${att.id}/content`, expiresInSec: null, mode: 'proxy' };
  }),
);

/** Stream an attachment's bytes after the same role + record scope check. Never cached by the browser. */
filesRouter.get('/:id/content', async (req, res) => {
  const p = idParam.safeParse(req.params);
  if (!p.success) throw new NotFoundError('File');
  const actor = req.actor!;
  if (!actor.role || !hasPermission(actor.role, 'files:read')) {
    throw new ForbiddenError({ recordType: 'Attachment', recordId: p.data.id, rule: 'permission:files:read' });
  }
  const att = await prisma.attachment.findUnique({ where: { id: p.data.id } });
  if (!att) throw new NotFoundError('File');
  await authorizeRead(actor, att);
  if (att.fileKey.startsWith('dev_')) throw new AppError(404, 'DEV_STUB_FILE', 'Dev stub attachment — file bytes store nahi hue.');
  // Byte ranges are passed through so videos can play and seek (D-082); only the first chunk is audited.
  const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
  const upstream = await fetch(await signedUrlFor(att.fileKey, 60), range ? { headers: { Range: range } } : undefined);
  if (!upstream.ok || !upstream.body) throw new AppError(502, 'FILE_FETCH_FAILED', 'File abhi load nahi ho saki. Dobara koshish karein.');
  if (!range || range.startsWith('bytes=0-')) {
    await audit(prisma, actor, { action: 'FILE_ACCESSED', recordType: att.recordType, recordId: att.recordId, after: { attachmentId: att.id } });
  }
  res.status(upstream.status === 206 ? 206 : 200);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) res.setHeader('Content-Range', contentRange);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', att.mime);
  // ?download=1 saves the file instead of showing it (developer photo gallery, D-072)
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${att.fileName.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  Readable.fromWeb(upstream.body as unknown as NodeReadableStream).pipe(res);
});

/** Attachment metadata for a record; items the actor may not read are omitted. */
filesRouter.get(
  '/',
  route(
    { permission: 'files:read', query: z.object({ recordType: z.string().min(1).max(40), recordId: z.string().min(1).max(64) }) },
    async ({ actor, query }) => {
      const rows = await prisma.attachment.findMany({ where: { recordType: query.recordType, recordId: query.recordId }, orderBy: { createdAt: 'asc' } });
      const visible = [];
      for (const a of rows) {
        try {
          await authorizeRead(actor, a);
          visible.push({ id: a.id, route: a.route, fileName: a.fileName, mime: a.mime, size: a.size, createdAt: a.createdAt, uploadedById: a.uploadedById });
        } catch {
          // not in scope — omitted (denial already audited by authorizeRead's ForbiddenError path is not needed per row)
        }
      }
      return { items: visible };
    },
  ),
);

/**
 * Development/test stand-in for UploadThing while UPLOADTHING_TOKEN is not configured.
 * Runs exactly the same upload authorization and writes the same Attachment row. Disabled in production.
 */
filesRouter.post(
  '/dev-upload',
  route(
    {
      permission: 'files:read',
      body: z.object({
        route: z.nativeEnum(UploadRoute),
        recordType: z.string().min(1).max(40),
        recordId: z.string().min(1).max(64),
        fileName: z.string().min(1).max(200),
        mime: z.string().min(1).max(100),
        size: z.number().int().positive().max(64 * 1024 * 1024),
      }),
      status: 201,
    },
    async ({ actor, body }) => {
      if (env.NODE_ENV === 'production' || uploadsConfigured) throw new NotFoundError('Endpoint');
      await authorizeUpload(actor, body.route, body);
      const att = await recordUpload(actor.id!, body.route, body, {
        key: `dev_${randomToken(12)}`,
        name: body.fileName,
        size: body.size,
        type: body.mime,
      });
      return { attachmentId: att.id };
    },
  ),
);
