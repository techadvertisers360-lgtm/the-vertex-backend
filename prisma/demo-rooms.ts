/**
 * DEMO helper (development only): give the demo Assistants today's rooms, as the Manager would
 * (Manager screens arrive in Phase 8). Bilal → P01, P02, C01; Zara → P03, C02. Safe to re-run.
 * Usage: npx tsx prisma/demo-rooms.ts
 */
import { PrismaClient } from '@prisma/client';
import { clinicDate } from '../src/lib/time';

const prisma = new PrismaClient();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to create demo room assignments in production.');
  process.exit(1);
}

const PLAN: Record<string, string[]> = {
  'assistant1@demo.vertexhealth.local': ['P01', 'P02', 'C01'],
  'assistant2@demo.vertexhealth.local': ['P03', 'C02'],
};

async function main() {
  const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'manager@demo.vertexhealth.local' } });
  const date = clinicDate(new Date());
  for (const [email, codes] of Object.entries(PLAN)) {
    const a = await prisma.user.findUniqueOrThrow({ where: { email } });
    for (const code of codes) {
      const room = await prisma.room.findUniqueOrThrow({ where: { code } });
      const held = await prisma.roomAssignment.findFirst({ where: { date, roomId: room.id, unassignedAt: null } });
      if (held) continue;
      const ra = await prisma.roomAssignment.create({ data: { assistantId: a.id, roomId: room.id, date, assignedById: manager.id } });
      await prisma.notification.create({
        data: { recipientId: a.id, type: 'ROOM_ASSIGNED', subject: `Room ${code} assign hua`, body: 'Accept karein aur opening checklist jama karein', recordType: 'RoomAssignment', recordId: ra.id, senderId: manager.id, senderLabel: manager.displayName, actionLabel: 'Accept', dedupeKey: `room:${ra.id}:assigned` },
      });
      console.log(`${a.displayName} → ${code}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
