/**
 * Playwright e2e seed — runs against the TEST database only (DATABASE_URL must equal DATABASE_URL_TEST).
 * Creates one fresh, clearly-labelled "E2E" cast for the main flow and writes their logins to the state file:
 *   Lead member (with an assigned sheet + lead) · Receptionist · Doctor (works all day) · Assistant (checked in).
 * Password = the integration-test fixture password (tests/integration/helpers.ts), never a real credential.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Role } from '@prisma/client';
import { clinicDate } from '../../src/lib/time';

const url = process.env.DATABASE_URL;
if (!url || url !== process.env.DATABASE_URL_TEST) throw new Error('e2e seed must run against DATABASE_URL_TEST');
const out: string = process.argv[2] ?? '';
if (!out) throw new Error('usage: tsx tests/e2e/seed.ts <state.json>');

const prisma = new PrismaClient();
const PASSWORD = 'Test@12345';
const tag = `e2e${Date.now().toString(36)}`;
let n = 0;

async function user(role: Role, name: string) {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const u = await prisma.user.create({ data: { displayName: `${name} (E2E ${tag})`, role, email: `${tag}-${role.toLowerCase()}-${++n}@test.local`, passwordHash, active: true } });
  if (role === 'DOCTOR') await prisma.doctorProfile.create({ data: { userId: u.id } });
  return u;
}

async function main() {
  const now = new Date();
  const ROOMS = [
    ['C01', 'CONSULT', 1], ['C02', 'CONSULT', 2], ['C03', 'CONSULT', 3],
    ['P01', 'PROCEDURE', 4], ['P02', 'PROCEDURE', 5], ['P03', 'PROCEDURE', 6],
  ] as const;
  for (const [code, kind, sortOrder] of ROOMS) await prisma.room.upsert({ where: { code }, update: { active: true }, create: { code, kind, sortOrder, name: code } });
  // Earlier integration runs may have left rooms reserved: free them from now on (test DB only).
  await prisma.roomReservation.updateMany({ where: { status: { in: ['ACTIVE', 'AWAITING_CLEAN'] }, endAt: { gt: new Date(now.getTime() - 12 * 3600_000) } }, data: { status: 'RELEASED', releasedAt: now } });

  const admin = await user('MD', 'Admin');
  const lead = await user('LEAD_MEMBER', 'Lead Member');
  await prisma.user.update({ where: { id: lead.id }, data: { memberCode: `LM-${tag.slice(-6).toUpperCase()}` } });
  const reception = await user('RECEPTIONIST', 'Receptionist');
  const doctor = await user('DOCTOR', 'Dr E2E');
  await prisma.user.update({ where: { id: doctor.id }, data: { phone: `92300${String(Date.now()).slice(-7)}` } });
  for (let weekday = 1; weekday <= 7; weekday++) {
    await prisma.doctorSchedule.create({ data: { doctorId: doctor.id, weekday, startMinute: 0, endMinute: 24 * 60 - 1, effectiveFrom: new Date('2026-01-01T00:00:00Z'), createdById: admin.id } });
  }
  const assistant = await user('ASSISTANT', 'Assistant');
  await prisma.attendance.create({ data: { userId: assistant.id, date: clinicDate(now), checkInAt: now } });

  const sheet = await prisma.metaSheet.create({ data: { externalId: `E2E-${tag}`, title: `E2E sheet ${tag}`, campaign: `E2E Campaign ${tag}`, createdById: admin.id } });
  await prisma.sheetAssignment.create({ data: { sheetId: sheet.id, memberId: lead.id, assignedById: admin.id } });
  const phone = `92301${String(Date.now()).slice(-7)}`;
  const leadRow = await prisma.lead.create({ data: { sheetId: sheet.id, assignedMemberId: lead.id, name: `E2E Patient ${tag}`, phone, phoneRaw: `0${phone.slice(2)}` } });

  // §24 checks: a second lead of the same member (network-retry booking) and a lead owned by someone else.
  const phone2 = `92302${String(Date.now()).slice(-7)}`;
  const retryLead = await prisma.lead.create({ data: { sheetId: sheet.id, assignedMemberId: lead.id, name: `E2E Retry ${tag}`, phone: phone2, phoneRaw: `0${phone2.slice(2)}` } });
  const otherMember = await user('LEAD_MEMBER', 'Other Member');
  const otherSheet = await prisma.metaSheet.create({ data: { externalId: `E2E-O-${tag}`, title: `E2E other ${tag}`, campaign: `E2E Other ${tag}`, createdById: admin.id } });
  await prisma.sheetAssignment.create({ data: { sheetId: otherSheet.id, memberId: otherMember.id, assignedById: admin.id } });
  const phone3 = `92303${String(Date.now()).slice(-7)}`;
  const otherLead = await prisma.lead.create({ data: { sheetId: otherSheet.id, assignedMemberId: otherMember.id, name: `E2E Not Yours ${tag}`, phone: phone3, phoneRaw: `0${phone3.slice(2)}` } });

  const state = {
    retryLeadId: retryLead.id,
    retryPatientName: retryLead.name,
    otherLeadId: otherLead.id,
    otherLeadName: otherLead.name,
    tag,
    password: PASSWORD,
    lead: { email: lead.email, name: lead.displayName },
    reception: { email: reception.email, name: reception.displayName },
    doctor: { email: doctor.email, name: doctor.displayName },
    assistant: { email: assistant.email, name: assistant.displayName },
    leadId: leadRow.id,
    patientName: leadRow.name,
    patientPhone: leadRow.phoneRaw,
  };
  writeFileSync(out, JSON.stringify(state, null, 2));
  console.log(`e2e seed ready: ${tag}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
