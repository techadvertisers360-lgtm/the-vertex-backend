import type { Prisma, UploadRoute } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { clinicDayBounds } from '../../lib/time';

/**
 * Developer photo gallery (D-072): every uploaded image, newest first, with who uploaded it and where it belongs.
 * Each row carries how to open it (same rules as /api/files/:id/url), so the page does not need one /url request
 * per photo — 60 parallel requests exhausted the database connections. The picture bytes still come through
 * /api/files/:id/content, which re-checks access and audits every view. Signed-URL mode (private files) has no
 * URL here: the page asks /url for those, which audits the issue.
 */
export async function listPhotos(q: { route?: UploadRoute; from?: string; to?: string; cursor?: string; limit: number }) {
  const where: Prisma.AttachmentWhereInput = {
    mime: { startsWith: 'image/' },
    ...(q.route ? { route: q.route } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: clinicDayBounds(q.from).start } : {}), ...(q.to ? { lt: clinicDayBounds(q.to).end } : {}) } } : {}),
  };
  const rows = await prisma.attachment.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: { id: true, route: true, fileName: true, mime: true, size: true, recordType: true, recordId: true, uploadedById: true, createdAt: true, fileKey: true, isPrivate: true, publicUrl: true },
  });
  const page = rows.slice(0, q.limit);
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(page.map((r) => r.uploadedById))] } }, select: { id: true, displayName: true, role: true } });
  return {
    total: await prisma.attachment.count({ where }),
    items: page.map(({ fileKey, isPrivate, publicUrl, ...r }) => {
      const u = users.find((x) => x.id === r.uploadedById);
      return { ...r, ...openWith(r.id, fileKey, isPrivate, publicUrl), uploadedBy: u?.displayName ?? null, uploadedByRole: u?.role ?? null };
    }),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
  };
}

function openWith(id: string, fileKey: string, isPrivate: boolean, publicUrl: string | null): { url: string | null; mode: 'public' | 'stub' | 'signed' | 'proxy' } {
  if (!isPrivate && publicUrl) return { url: publicUrl, mode: 'public' };
  if (fileKey.startsWith('dev_')) return { url: null, mode: 'stub' };
  if (env.privateFiles) return { url: null, mode: 'signed' };
  return { url: `/api/files/${id}/content`, mode: 'proxy' };
}
