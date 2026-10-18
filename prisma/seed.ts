/**
 * DEMO seed data. Every record here is demo data (users flagged isDemo, ids/emails marked "demo").
 * Real names, rates, Doctor schedules, Meta IDs and WhatsApp credentials are provided by the clinic (spec intro).
 * Idempotent: safe to run repeatedly. Refuses to run in production.
 */
import { PrismaClient, type Role, type RoomKind, type AppointmentType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { seedSettingDefaults } from '../src/services/settings';
import { normalizePhone } from '../src/lib/phone';
import { addDaysStr, clinicDateStr, dateOnly } from '../src/lib/time';

const prisma = new PrismaClient();

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Vertex@2026';

interface DemoUser {
  key: string;
  displayName: string;
  role: Role;
  email: string;
  phone: string;
  memberCode?: string;
  title?: string;
  specialty?: string;
}

const USERS: DemoUser[] = [
  { key: 'md', displayName: 'Usama Sufain', role: 'MD', email: 'usama.md@demo.vertexhealth.local', phone: '03001110001', memberCode: 'VH-MD-01', title: 'MD' },
  // Hamza Zafar is the Marketing & Development Director / Co-Founder — a different person from Dr Hamza Rasool.
  { key: 'hamza', displayName: 'Hamza Zafar', role: 'MARKETING_DIRECTOR', email: 'hamza.zafar@demo.vertexhealth.local', phone: '03001110002', memberCode: 'VH-MKT-01', title: 'Marketing & Development Director / Co-Founder' },
  { key: 'muaz', displayName: 'Muaz Tahir', role: 'MARKETING_LEAD', email: 'muaz.tahir@demo.vertexhealth.local', phone: '03001110003', memberCode: 'VH-MKT-02', title: 'Marketing & Lead Performance' },
  { key: 'manager', displayName: 'Demo Manager (Ayesha Khan)', role: 'MANAGER', email: 'manager@demo.vertexhealth.local', phone: '03001110004', memberCode: 'VH-MGR-01', title: 'Clinic Manager' },
  { key: 'drHamza', displayName: 'Dr Hamza Rasool', role: 'DOCTOR', email: 'dr.hamza.rasool@demo.vertexhealth.local', phone: '03001110005', memberCode: 'VH-DR-01', title: 'Doctor', specialty: 'Aesthetics (demo)' },
  { key: 'drSara', displayName: 'Dr Sara Malik (Demo)', role: 'DOCTOR', email: 'dr.sara@demo.vertexhealth.local', phone: '03001110006', memberCode: 'VH-DR-02', title: 'Doctor', specialty: 'Dental (demo)' },
  { key: 'reception', displayName: 'Demo Receptionist (Fatima Noor)', role: 'RECEPTIONIST', email: 'reception@demo.vertexhealth.local', phone: '03001110007', memberCode: 'VH-REC-01' },
  { key: 'asst1', displayName: 'Demo Assistant (Bilal Ahmed)', role: 'ASSISTANT', email: 'assistant1@demo.vertexhealth.local', phone: '03001110008', memberCode: 'VH-AST-01' },
  { key: 'asst2', displayName: 'Demo Assistant (Zara Iqbal)', role: 'ASSISTANT', email: 'assistant2@demo.vertexhealth.local', phone: '03001110009', memberCode: 'VH-AST-02' },
  { key: 'office', displayName: 'Demo Office Boy (Imran Ali)', role: 'OFFICE_BOY', email: 'office@demo.vertexhealth.local', phone: '03001110010', memberCode: 'VH-OB-01' },
  { key: 'lead1', displayName: 'Demo Lead Member (Ali Raza)', role: 'LEAD_MEMBER', email: 'lead1@demo.vertexhealth.local', phone: '03001110011', memberCode: 'LM-001' },
  { key: 'lead2', displayName: 'Demo Lead Member (Sana Javed)', role: 'LEAD_MEMBER', email: 'lead2@demo.vertexhealth.local', phone: '03001110012', memberCode: 'LM-002' },
];

const ROOMS: { code: string; name: string; kind: RoomKind; sortOrder: number }[] = [
  { code: 'C01', name: 'Consultation C01', kind: 'CONSULT', sortOrder: 1 },
  { code: 'C02', name: 'Consultation C02', kind: 'CONSULT', sortOrder: 2 },
  { code: 'C03', name: 'Consultation C03', kind: 'CONSULT', sortOrder: 3 },
  { code: 'P01', name: 'Procedure P01', kind: 'PROCEDURE', sortOrder: 4 },
  { code: 'P02', name: 'Procedure P02', kind: 'PROCEDURE', sortOrder: 5 },
  { code: 'P03', name: 'Procedure P03', kind: 'PROCEDURE', sortOrder: 6 },
];

const SERVICES: { name: string; type: AppointmentType; durationMin: number | null; priceRs: number | null }[] = [
  { name: 'Consultation (demo)', type: 'CONSULTATION', durationMin: null, priceRs: 2000 },
  { name: 'Hydrafacial (demo)', type: 'PROCEDURE', durationMin: 60, priceRs: 12000 },
  { name: 'Laser Hair Removal (demo)', type: 'PROCEDURE', durationMin: 45, priceRs: 15000 },
  { name: 'PRP Therapy (demo)', type: 'PROCEDURE', durationMin: 60, priceRs: 18000 },
  { name: 'Teeth Scaling (demo)', type: 'PROCEDURE', durationMin: 45, priceRs: 6000 },
  { name: 'Hijama (demo)', type: 'PROCEDURE', durationMin: 45, priceRs: 5000 },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const ids: Record<string, string> = {};

  for (const u of USERS) {
    const phone = normalizePhone(u.phone)!;
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { displayName: u.displayName, role: u.role, title: u.title ?? null, memberCode: u.memberCode ?? null, phone, isDemo: true },
      create: { displayName: u.displayName, role: u.role, email: u.email, phone, memberCode: u.memberCode ?? null, title: u.title ?? null, passwordHash, isDemo: true },
    });
    ids[u.key] = user.id;
    if (u.role === 'DOCTOR') {
      await prisma.doctorProfile.upsert({ where: { userId: user.id }, update: { specialty: u.specialty ?? null }, create: { userId: user.id, specialty: u.specialty ?? null } });
    }
    if (u.role === 'LEAD_MEMBER') {
      await prisma.leadMemberProfile.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id, createdById: ids.hamza!, notes: 'Demo lead member' } });
    }
  }

  for (const r of ROOMS) {
    await prisma.room.upsert({ where: { code: r.code }, update: {}, create: r });
  }

  for (const s of SERVICES) {
    await prisma.service.upsert({
      where: { name: s.name },
      update: {},
      create: { name: s.name, type: s.type, durationMin: s.durationMin, defaultPricePaisa: s.priceRs === null ? null : BigInt(s.priceRs) * 100n },
    });
  }

  // Demo doctor hours: Mon–Sat 14:00–21:00 clinic time (placeholder — spec §26 #2).
  const today = clinicDateStr(new Date());
  for (const key of ['drHamza', 'drSara']) {
    const doctorId = ids[key]!;
    const existing = await prisma.doctorSchedule.count({ where: { doctorId } });
    if (existing === 0) {
      for (let weekday = 1; weekday <= 6; weekday++) {
        await prisma.doctorSchedule.create({
          data: { doctorId, weekday, startMinute: 14 * 60, endMinute: 21 * 60, effectiveFrom: dateOnly(addDaysStr(today, -30)), createdById: ids.manager! },
        });
      }
    }
  }

  // Demo Meta sheets: LM-001 gets three, LM-002 gets one.
  const sheets = [
    { externalId: 'DEMO-META-HYDRA-01', title: 'Hydrafacial Lahore (demo)', campaign: 'Hydrafacial Oct (demo)', member: 'lead1' },
    { externalId: 'DEMO-META-LASER-01', title: 'Laser Hair Removal (demo)', campaign: 'Laser Winter (demo)', member: 'lead1' },
    { externalId: 'DEMO-META-PRP-01', title: 'PRP Hair (demo)', campaign: 'PRP Awareness (demo)', member: 'lead1' },
    { externalId: 'DEMO-META-DENTAL-01', title: 'Dental Smile (demo)', campaign: 'Dental Checkup (demo)', member: 'lead2' },
  ];
  const sheetIds: Record<string, string> = {};
  for (const s of sheets) {
    const sheet = await prisma.metaSheet.upsert({
      where: { externalId: s.externalId },
      update: {},
      create: { externalId: s.externalId, title: s.title, campaign: s.campaign, createdById: ids.hamza! },
    });
    sheetIds[s.externalId] = sheet.id;
    const memberId = ids[s.member]!;
    const assigned = await prisma.sheetAssignment.count({ where: { sheetId: sheet.id, memberId, unassignedAt: null } });
    if (!assigned) await prisma.sheetAssignment.create({ data: { sheetId: sheet.id, memberId, assignedById: ids.hamza! } });
  }

  const demoLeads = [
    { sheet: 'DEMO-META-HYDRA-01', name: 'Demo Lead Hira', phone: '03215550001', member: 'lead1' },
    { sheet: 'DEMO-META-HYDRA-01', name: 'Demo Lead Usman', phone: '03215550002', member: 'lead1' },
    { sheet: 'DEMO-META-LASER-01', name: 'Demo Lead Maryam', phone: '03215550003', member: 'lead1' },
    { sheet: 'DEMO-META-LASER-01', name: 'Demo Lead Farhan', phone: '03215550004', member: 'lead1' },
    { sheet: 'DEMO-META-PRP-01', name: 'Demo Lead Kamran', phone: '03215550005', member: 'lead1' },
    { sheet: 'DEMO-META-DENTAL-01', name: 'Demo Lead Nida', phone: '03215550006', member: 'lead2' },
    { sheet: 'DEMO-META-DENTAL-01', name: 'Demo Lead Asad', phone: '03215550007', member: 'lead2' },
  ];
  for (const [i, l] of demoLeads.entries()) {
    await prisma.lead.upsert({
      where: { sheetId_externalRowId: { sheetId: sheetIds[l.sheet]!, externalRowId: `demo-row-${i + 1}` } },
      update: {},
      create: {
        sheetId: sheetIds[l.sheet]!,
        assignedMemberId: ids[l.member]!,
        name: l.name,
        phone: normalizePhone(l.phone)!,
        phoneRaw: l.phone,
        externalRowId: `demo-row-${i + 1}`,
      },
    });
  }

  // Vendors, stock catalog, opening stock (demo).
  const vendors = ['Demo Medical Supplies Co.', 'Demo Aesthetics Traders', 'Demo Dental Depot'];
  const vendorIds: string[] = [];
  for (const name of vendors) {
    const v = await prisma.vendor.upsert({ where: { name }, update: {}, create: { name, phone: normalizePhone('04235550000'), address: 'Demo address, Lahore', products: 'Demo products' } });
    vendorIds.push(v.id);
  }
  const items = [
    { name: 'Nitrile Gloves (demo)', category: 'Consumables', baseUnit: 'piece', packUnit: 'box', packSize: 100, minQty: 200, opening: 500, lot: 'DEMO-GL-01', expiryDays: 400, costPaisa: 1500n },
    { name: 'Syringe 5ml (demo)', category: 'Consumables', baseUnit: 'piece', packUnit: 'box', packSize: 100, minQty: 100, opening: 300, lot: 'DEMO-SY-01', expiryDays: 500, costPaisa: 2500n },
    { name: 'Hydrafacial Serum (demo)', category: 'Aesthetics', baseUnit: 'ml', packUnit: 'bottle', packSize: 500, minQty: 250, opening: 1000, lot: 'DEMO-HS-01', expiryDays: 50, costPaisa: 800n },
    { name: 'Numbing Cream (demo)', category: 'Aesthetics', baseUnit: 'piece', packUnit: 'box', packSize: 10, minQty: 10, opening: 8, lot: 'DEMO-NC-01', expiryDays: 200, costPaisa: 90000n },
    { name: 'Sterile Gauze (demo)', category: 'Consumables', baseUnit: 'piece', packUnit: 'pack', packSize: 50, minQty: 100, opening: 400, lot: 'DEMO-GZ-01', expiryDays: 700, costPaisa: 500n },
  ];
  for (const it of items) {
    const item = await prisma.stockItem.upsert({
      where: { name: it.name },
      update: {},
      create: { name: it.name, category: it.category, baseUnit: it.baseUnit, packUnit: it.packUnit, packSize: it.packSize, minQty: it.minQty, preferredVendorId: vendorIds[0] },
    });
    const batch = await prisma.stockBatch.upsert({
      where: { itemId_lotNo: { itemId: item.id, lotNo: it.lot } },
      update: {},
      create: { itemId: item.id, lotNo: it.lot, expiryDate: dateOnly(addDaysStr(today, it.expiryDays)), vendorId: vendorIds[0], unitCostPaisa: it.costPaisa },
    });
    await prisma.stockTransaction.upsert({
      where: { idempotencyKey: `seed:opening:${batch.id}` },
      update: {},
      create: { itemId: item.id, batchId: batch.id, type: 'ADJUSTMENT', quantity: it.opening, unitCostPaisa: it.costPaisa, reason: 'Demo opening stock', actorId: ids.manager!, idempotencyKey: `seed:opening:${batch.id}` },
    });
  }

  const bank = await prisma.bankAccount.findFirst({ where: { name: 'Demo Clinic Account' } });
  if (!bank) await prisma.bankAccount.create({ data: { name: 'Demo Clinic Account', bankName: 'Demo Bank', accountNo: 'PK00DEMO0000000000001234' } });

  await seedSettingDefaults(prisma);

  console.log(`Seeded demo data. ${USERS.length} users (password: ${process.env.SEED_DEMO_PASSWORD ? '<SEED_DEMO_PASSWORD>' : DEMO_PASSWORD}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
