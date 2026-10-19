import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { ValidationError } from '../../lib/errors';
import { route } from '../../middleware/route';
import { pushEnabled, removeSubscription, saveSubscription, sendToUsers } from '../../services/push';

/**
 * This device's Web Push subscription (D-046). Every role holds `notifications:own`; each user manages only their
 * own devices. The VAPID public key is not a secret (browsers need it to subscribe).
 */
export const pushRouter = Router();
const P = 'notifications:own' as const;

const subscription = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'https endpoint required'),
  keys: z.object({ p256dh: z.string().min(10).max(255), auth: z.string().min(8).max(255) }),
});

pushRouter.get(
  '/config',
  route({ permission: P }, async ({ user }) => ({
    enabled: pushEnabled(),
    publicKey: pushEnabled() ? env.VAPID_PUBLIC_KEY! : null,
    devices: await prisma.pushSubscription.count({ where: { userId: user.id } }),
  })),
);

pushRouter.post(
  '/subscriptions',
  route({ permission: P, body: z.object({ subscription, userAgent: z.string().max(400).optional() }) }, async ({ user, body }) => {
    if (!pushEnabled()) throw new ValidationError('Phone notifications abhi server par set nahi — Developer se rabta karein.');
    return saveSubscription(user.id, body.subscription, body.userAgent);
  }),
);

/** Turn notifications off on this device (also called on logout). */
pushRouter.post(
  '/subscriptions/remove',
  route({ permission: P, body: z.object({ endpoint: z.string().max(2000) }) }, async ({ user, body }) => removeSubscription(user.id, body.endpoint)),
);

pushRouter.post(
  '/test',
  route({ permission: P }, async ({ user }) => {
    if (!pushEnabled()) throw new ValidationError('Phone notifications abhi server par set nahi — Developer se rabta karein.');
    const r = await sendToUsers([user.id], {
      title: 'The Vertex Health — test',
      body: 'Notifications is device par kaam kar rahi hain ✅',
      url: '/',
      tag: `test:${user.id}`,
      urgent: false,
    });
    return { ...r, devices: await prisma.pushSubscription.count({ where: { userId: user.id } }) };
  }),
);
