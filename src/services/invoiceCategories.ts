import type { AppointmentType } from '@prisma/client';
import type { Tx } from '../lib/prisma';

/**
 * Keeps a service's managed category in step with its free-text category (D-084). Reception and the CSV import still
 * type a category; the matching managed one is found (ignoring case) or created. With no text, the service type decides.
 */
export async function invoiceCategoryFor(tx: Tx, text: string | null | undefined, type: AppointmentType): Promise<string> {
  const name = text?.trim().replace(/\s+/g, ' ');
  if (!name) return type === 'CONSULTATION' ? 'ic_consultation' : 'ic_procedure';
  const found = await tx.invoiceCategory.findFirst({ where: { name }, select: { id: true } });
  if (found) return found.id;
  return (await tx.invoiceCategory.create({ data: { name, sortOrder: 100 }, select: { id: true } })).id;
}
