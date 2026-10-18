/**
 * DEMO helper (development only): create two clearly-labelled demo visits for *today* so the Reception
 * screens can be exercised on any day (the seeded Doctors do not work Sundays):
 *   1) "Demo Walk-in (test)" — CONFIRMED, ready for check-in
 *   2) "Demo Billing (test)" — already sent to Reception with a demo Doctor plan, ready for billing
 * Usage: npx tsx prisma/demo-today.ts
 */
import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/lib/phone';

const prisma = new PrismaClient();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to create demo visits in production.');
  process.exit(1);
}

async function patient(name: string, phone: string, createdById: string) {
  const p = normalizePhone(phone)!;
  return (await prisma.patient.findFirst({ where: { phone: p } })) ?? prisma.patient.create({ data: { name, phone: p, createdById, whatsappConsent: true, contactConsent: true } });
}

async function main() {
  const reception = await prisma.user.findUniqueOrThrow({ where: { email: 'reception@demo.vertexhealth.local' } });
  const doctor = await prisma.user.findUniqueOrThrow({ where: { email: 'dr.sara@demo.vertexhealth.local' } });
  const room = await prisma.room.findUniqueOrThrow({ where: { code: 'C02' } });
  const now = new Date();

  const walkIn = await patient('Demo Walk-in (test)', '03009990001', reception.id);
  const a1 = await prisma.appointment.create({
    data: { patientId: walkIn.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: now, endAt: new Date(now.getTime() + 20 * 60_000), roomId: room.id, status: 'CONFIRMED', source: 'RECEPTION', createdById: reception.id, reason: 'Demo walk-in' },
  });
  await prisma.appointmentStatusHistory.create({ data: { appointmentId: a1.id, toStatus: 'CONFIRMED', actorId: reception.id, reason: 'demo-today script' } });

  const billing = await patient('Demo Billing (test)', '03009990002', reception.id);
  const a2 = await prisma.appointment.create({
    data: { patientId: billing.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: new Date(now.getTime() - 3600_000), endAt: new Date(now.getTime() - 2400_000), roomId: room.id, status: 'RECEPTION', source: 'RECEPTION', createdById: reception.id, checkedInAt: new Date(now.getTime() - 3600_000), sentToReceptionAt: new Date(now.getTime() - 600_000), reason: 'Demo billing visit' },
  });
  await prisma.appointmentStatusHistory.create({ data: { appointmentId: a2.id, toStatus: 'RECEPTION', actorId: doctor.id, reason: 'demo-today script' } });
  const plan = await prisma.treatmentPlan.create({ data: { patientId: billing.id, doctorId: doctor.id, appointmentId: a2.id, currentVersionNo: 1 } });
  await prisma.treatmentPlanVersion.create({
    data: {
      planId: plan.id,
      versionNo: 1,
      consultationReason: 'Demo plan',
      consultationFeePaisa: 200_000n,
      itemsSubtotalPaisa: 600_000n,
      itemsDiscountPaisa: 50_000n,
      totalDiscountPaisa: 0n,
      grandTotalPaisa: 750_000n,
      advanceRequestedPaisa: 300_000n,
      balancePaisa: 750_000n,
      installmentCount: 1,
      createdById: doctor.id,
      items: { create: [{ sessionNumber: 1, procedureName: 'Teeth Scaling (demo)', sameDay: true, scheduledStart: now, scheduledEnd: new Date(now.getTime() + 2700_000), pricePaisa: 600_000n, discountPaisa: 50_000n }] },
    },
  });
  console.log('Demo visits created for today:', { walkIn: a1.id, billing: a2.id });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
