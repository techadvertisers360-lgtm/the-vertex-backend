import { Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { idParam, route } from '../../middleware/route';
import { createUser, listUsers, setPassword, updateUser } from './service';

export const usersRouter = Router();

usersRouter.get(
  '/',
  route(
    {
      permission: ['users:manage', 'leads:admin'],
      query: z.object({
        role: z.nativeEnum(Role).optional(),
        active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
        q: z.string().max(80).optional(),
      }),
    },
    async ({ actor, query }) => ({ items: await listUsers(actor, query) }),
  ),
);

usersRouter.post(
  '/',
  route(
    {
      permission: ['users:manage', 'leads:admin'],
      status: 201,
      body: z.object({
        displayName: z.string().min(2).max(100),
        role: z.nativeEnum(Role),
        email: z.string().email().max(120).optional(),
        phone: z.string().min(7).max(20).optional(),
        memberCode: z.string().regex(/^[A-Za-z0-9-]{3,20}$/).optional(),
        title: z.string().max(120).optional(),
        password: z.string().min(8).max(200),
        specialty: z.string().max(120).optional(),
      }),
    },
    async ({ actor, body }) => createUser(actor, body),
  ),
);

usersRouter.patch(
  '/:id',
  route(
    {
      permission: ['users:manage', 'leads:admin'],
      params: idParam,
      body: z.object({
        displayName: z.string().min(2).max(100).optional(),
        role: z.nativeEnum(Role).optional(),
        active: z.boolean().optional(),
        email: z.string().email().max(120).nullable().optional(),
        phone: z.string().min(7).max(20).nullable().optional(),
        title: z.string().max(120).nullable().optional(),
        attendanceRequired: z.boolean().optional(),
      }),
    },
    async ({ actor, params, body }) => updateUser(actor, params.id, body),
  ),
);

/** Set someone's password — the developer only (D-044); it stays as given. */
usersRouter.post(
  '/:id/password',
  route({ permission: 'developer:console', params: idParam, body: z.object({ password: z.string().min(8).max(200) }) }, async ({ actor, params, body }) =>
    setPassword(actor, params.id, body.password),
  ),
);
