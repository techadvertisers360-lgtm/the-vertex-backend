import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';

/**
 * Clinic bank accounts (client 2026-10-30, D-080): Manager and MD add and edit the accounts patients transfer to;
 * Reception picks one when a payment is "Bank / online". Never deleted — an account no longer used is turned off,
 * so old payments keep pointing at it.
 */
const view = { id: true, name: true, bankName: true, accountNo: true, active: true, createdAt: true } as const;

export async function listBankAccounts() {
  return { items: await prisma.bankAccount.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], select: view }) };
}

export interface BankAccountInput {
  name: string;
  bankName: string;
  accountNo: string;
}

function clean(input: BankAccountInput): BankAccountInput {
  const out = { name: input.name.trim(), bankName: input.bankName.trim(), accountNo: input.accountNo.trim() };
  if (out.name.length < 2) throw new ValidationError('Account title likhein.');
  if (out.bankName.length < 2) throw new ValidationError('Bank ka naam likhein.');
  if (out.accountNo.length < 4) throw new ValidationError('Account number / IBAN likhein.');
  return out;
}

export async function createBankAccount(actor: Actor, input: BankAccountInput) {
  const data = clean(input);
  return prisma.$transaction(async (tx) => {
    const row = await tx.bankAccount.create({ data, select: view });
    await audit(tx, actor, { action: 'BANK_ACCOUNT_CREATED', recordType: 'BankAccount', recordId: row.id, after: row });
    return row;
  });
}

export async function updateBankAccount(actor: Actor, id: string, input: Partial<BankAccountInput> & { active?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.bankAccount.findUnique({ where: { id }, select: view });
    if (!before) throw new NotFoundError('Bank account');
    const merged = clean({ name: input.name ?? before.name, bankName: input.bankName ?? before.bankName, accountNo: input.accountNo ?? before.accountNo });
    const row = await tx.bankAccount.update({ where: { id }, data: { ...merged, ...(input.active !== undefined ? { active: input.active } : {}) }, select: view });
    await audit(tx, actor, { action: 'BANK_ACCOUNT_UPDATED', recordType: 'BankAccount', recordId: id, before, after: row });
    return row;
  });
}
