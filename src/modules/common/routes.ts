import { Router } from 'express';
import { z } from 'zod';
import { idParam, paging, route } from '../../middleware/route';
import { listNotifications, markAllRead, markRead } from '../../services/notifications';
import { listSettings, updateSetting } from '../../services/settings';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  route(
    { permission: 'notifications:own', query: z.object({ filter: z.enum(['unread', 'read', 'all']).default('unread'), ...paging }) },
    async ({ user, query }) => listNotifications(user.id, query.filter, query.limit, query.cursor),
  ),
);

notificationsRouter.post(
  '/:id/read',
  route({ permission: 'notifications:own', params: idParam }, async ({ user, params }) => {
    await markRead(user.id, params.id);
    return { ok: true };
  }),
);

notificationsRouter.post(
  '/read-all',
  route({ permission: 'notifications:own' }, async ({ user }) => ({ updated: await markAllRead(user.id) })),
);

export const settingsRouter = Router();

settingsRouter.get('/', route({ permission: 'settings:manage' }, async () => ({ items: await listSettings() })));

settingsRouter.put(
  '/:key',
  route(
    {
      permission: 'settings:manage',
      params: z.object({ key: z.string().min(1).max(80) }),
      body: z.object({ value: z.unknown(), confirm: z.boolean().default(false) }),
    },
    async ({ actor, params, body }) => {
      await updateSetting(actor, params.key, body.value, body.confirm);
      return { ok: true };
    },
  ),
);
