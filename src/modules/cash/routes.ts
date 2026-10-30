import { Router } from 'express';
import { z } from 'zod';
import { idParam, route } from '../../middleware/route';
import { createBankAccount, listBankAccounts, updateBankAccount } from './bankAccounts';

/** Clinic bank accounts — Manager and MD (D-080). */
export const bankAccountsRouter = Router();

const fields = { name: z.string().max(120), bankName: z.string().max(120), accountNo: z.string().max(60) };

bankAccountsRouter.get('/', route({ permission: 'bank:manage' }, async () => listBankAccounts()));
bankAccountsRouter.post('/', route({ permission: 'bank:manage', body: z.object(fields), status: 201 }, async ({ actor, body }) => createBankAccount(actor, body)));
bankAccountsRouter.patch(
  '/:id',
  route({ permission: 'bank:manage', params: idParam, body: z.object({ ...fields, active: z.boolean() }).partial() }, async ({ actor, params, body }) => updateBankAccount(actor, params.id, body)),
);
