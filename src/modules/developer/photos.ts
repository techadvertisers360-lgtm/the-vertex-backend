import type { Prisma, UploadRoute } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { clinicDayBounds } from '../../lib/time';

/**
 * Developer photo gallery (D-072): every uploaded image, newest first, with who uploaded it and where it belongs.
 * Only metadata here — the picture itself is opened through /api/files/:id/url, which audits each access.
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
    select: { id: true, route: true, fileName: true, mime: true, size: true, recordType: true, recordId: true, uploadedById: true, createdAt: true },
  });
  const page = rows.slice(0, q.limit);
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(page.map((r) => r.uploadedById))] } }, select: { id: true, displayName: true, role: true } });
  return {
    total: await prisma.attachment.count({ where }),
    items: page.map((r) => {
      const u = users.find((x) => x.id === r.uploadedById);
      return { ...r, uploadedBy: u?.displayName ?? null, uploadedByRole: u?.role ?? null };
    }),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
  };
}
