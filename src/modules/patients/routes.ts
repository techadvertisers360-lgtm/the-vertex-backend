import { Router } from 'express';
import { z } from 'zod';
import { idParam, route } from '../../middleware/route';
import { correctPatient, listPatients, patientRecord } from './records';

/** Patient Records — Manager and MD (D-078); patient details can be corrected (D-079), history is view only. */
export const patientRecordsRouter = Router();

patientRecordsRouter.get(
  '/',
  route(
    {
      permission: 'patients:records',
      query: z.object({ q: z.string().max(80).optional(), cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
    },
    async ({ query }) => listPatients(query),
  ),
);

patientRecordsRouter.get('/:id', route({ permission: 'patients:records', params: idParam }, async ({ actor, params }) => patientRecord(actor, params.id)));

patientRecordsRouter.patch(
  '/:id',
  route(
    {
      permission: 'patients:records',
      params: idParam,
      body: z.object({
        name: z.string().max(120).optional(),
        phone: z.string().min(7).max(20).optional(),
        ageYears: z.number().int().min(0).max(130).nullable().optional(),
        gender: z.string().max(20).nullable().optional(),
        reason: z.string().max(500),
        confirmSharedPhone: z.boolean().optional(),
      }),
    },
    async ({ actor, params, body }) => correctPatient(actor, params.id, body),
  ),
);
