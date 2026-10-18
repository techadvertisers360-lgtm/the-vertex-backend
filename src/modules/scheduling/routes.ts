import { Router } from 'express';
import { z } from 'zod';
import { AppointmentType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { route } from '../../middleware/route';
import { checkAvailability, daySlots } from '../../services/scheduling';

/**
 * Read-only scheduling endpoints for booking forms (Lead, Reception, Manager). They only show options;
 * the final booking endpoint in each role module re-checks everything under lock (spec §6).
 */
export const schedulingRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PERM = 'availability:read' as const;

schedulingRouter.get(
  '/doctors',
  route({ permission: PERM }, async () => ({
    items: await prisma.user.findMany({
      where: { role: 'DOCTOR', active: true },
      select: { id: true, displayName: true, doctorProfile: { select: { specialty: true } } },
      orderBy: { displayName: 'asc' },
    }),
  })),
);

schedulingRouter.get(
  '/services',
  route({ permission: PERM }, async () => ({
    // Prices are not exposed here (booking does not need them).
    items: await prisma.service.findMany({ where: { active: true }, select: { id: true, name: true, type: true, durationMin: true }, orderBy: { name: 'asc' } }),
  })),
);

schedulingRouter.get(
  '/rooms',
  route({ permission: [PERM, 'manager:room_assign'] }, async () => ({
    items: await prisma.room.findMany({ where: { active: true }, select: { id: true, code: true, name: true, kind: true }, orderBy: [{ sortOrder: 'asc' }] }),
  })),
);

schedulingRouter.get(
  '/slots',
  route(
    {
      permission: PERM,
      query: z.object({ doctorId: z.string().min(1), type: z.nativeEnum(AppointmentType), date: isoDate, serviceId: z.string().optional() }),
    },
    async ({ query }) => daySlots(query),
  ),
);

schedulingRouter.post(
  '/check',
  route(
    {
      permission: PERM,
      body: z.object({
        doctorId: z.string().min(1),
        type: z.nativeEnum(AppointmentType),
        start: z.coerce.date(),
        serviceId: z.string().optional(),
        roomId: z.string().optional(),
        excludeAppointmentId: z.string().optional(),
      }),
    },
    async ({ body }) => checkAvailability(body),
  ),
);
