import { Router } from 'express';
import { z } from 'zod';
import { idParam, route } from '../../middleware/route';
import { listPatients, patientRecord } from './records';

/** Patient Records — Manager and MD (D-078). View only. */
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
