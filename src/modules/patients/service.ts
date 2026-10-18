import { Prisma, type Patient } from '@prisma/client';
import { prisma, type Db } from '../../lib/prisma';
import { ConflictError, ValidationError } from '../../lib/errors';
import { normalizePhone } from '../../lib/phone';
import { audit, type Actor } from '../../services/audit';

export interface NewPatientInput {
  name: string;
  phone: string;
  contactConsent: boolean;
  whatsappConsent: boolean;
  ageYears?: number | null;
  gender?: string | null;
  /** Staff confirmed this is a different person sharing an existing number (D-010). */
  confirmSharedPhone?: { reason: string } | null;
}

/** Minimal projection shown in a duplicate warning — enough to recognise the person, nothing clinical. */
export const duplicateView = { id: true, name: true, ageYears: true, gender: true, createdAt: true } as const;

export function requirePhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) throw new ValidationError('Phone number durust nahi hai.', { fieldErrors: { phone: ['Phone number durust nahi hai.'] } });
  return phone;
}

export async function patientsOnPhone(db: Db, phone: string) {
  return db.patient.findMany({ where: { phone, mergedIntoId: null }, select: duplicateView, orderBy: { phoneSlot: 'asc' } });
}

/**
 * Create a patient (spec §5, §9, §24; D-010):
 *  - phone normalized and validated;
 *  - if any patient already uses that number → 409 DUPLICATE_PHONE listing them, unless staff confirmed a
 *    different person sharing the number; the confirmed create takes the next phone slot and is audited;
 *  - unique (phone, phoneSlot) means a race or double submit can never create a silent duplicate.
 */
export async function createPatient(db: Db, actor: Actor, input: NewPatientInput): Promise<Patient> {
  const phone = requirePhone(input.phone);
  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError('Patient ka naam zaroori hai.');
  const existing = await patientsOnPhone(db, phone);

  if (existing.length && !input.confirmSharedPhone) {
    throw new ConflictError('DUPLICATE_PHONE', 'Is phone number par pehle se patient mojood hai. Existing patient chunein ya confirm karein ke yeh alag shakhs hai.', { existing });
  }
  if (input.confirmSharedPhone && !input.confirmSharedPhone.reason.trim()) {
    throw new ValidationError('Shared phone confirm karne ki wajah likhein (e.g. family member).');
  }

  const max = await db.patient.aggregate({ where: { phone }, _max: { phoneSlot: true } });
  const phoneSlot = existing.length ? (max._max.phoneSlot ?? 0) + 1 : 0;
  try {
    const patient = await db.patient.create({
      data: {
        name,
        phone,
        phoneSlot,
        ageYears: input.ageYears ?? null,
        gender: input.gender ?? null,
        contactConsent: input.contactConsent,
        whatsappConsent: input.whatsappConsent,
        createdById: actor.id!,
      },
    });
    await audit(db, actor, { action: 'PATIENT_CREATED', recordType: 'Patient', recordId: patient.id, after: patient });
    if (existing.length) {
      await audit(db, actor, {
        action: 'PATIENT_DUPLICATE_PHONE_CONFIRMED',
        recordType: 'Patient',
        recordId: patient.id,
        after: { phone, existingPatientIds: existing.map((e) => e.id), phoneSlot },
        reason: input.confirmSharedPhone!.reason,
      });
    }
    return patient;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      // Lost a race with another create on the same number: surface the fresh duplicate list.
      throw new ConflictError('DUPLICATE_PHONE', 'Is phone number par abhi patient ban gaya. Existing patient chunein ya dobara confirm karein.', {
        existing: await patientsOnPhone(prisma, phone),
      });
    }
    throw e;
  }
}
