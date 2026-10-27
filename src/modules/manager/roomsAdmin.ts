import type { RoomKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDate } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';

/**
 * Rooms are managed by the Manager (client 2026-10-20, D-051): add a consultation or procedure room, rename it,
 * re-order it, or take it out of use. A room with bookings ahead cannot be taken out of use or change type — the
 * booking engine would otherwise lose a room that is already promised. Delete (D-065): a room nothing ever used is
 * removed; a room that old records point to is archived (hidden everywhere, kept so history still shows its code).
 */

export async function listRooms() {
  const now = new Date();
  const [rooms, ahead, owners] = await Promise.all([
    prisma.room.findMany({ where: { deletedAt: null }, orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }] }),
    prisma.roomReservation.groupBy({ by: ['roomId'], where: { status: 'ACTIVE', endAt: { gt: now } }, _count: { _all: true } }),
    prisma.doctorProfile.findMany({ where: { defaultRoomId: { not: null } }, select: { defaultRoomId: true, user: { select: { displayName: true, active: true } } } }),
  ]);
  return {
    items: rooms.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      active: r.active,
      sortOrder: r.sortOrder,
      bookingsAhead: ahead.find((a) => a.roomId === r.id)?._count._all ?? 0,
      doctors: owners.filter((o) => o.defaultRoomId === r.id && o.user.active).map((o) => o.user.displayName),
    })),
  };
}

const cleanCode = (c: string) => c.trim().toUpperCase().replace(/\s+/g, '-');

export async function createRoom(actor: Actor, input: { code: string; name?: string; kind: RoomKind }) {
  const code = cleanCode(input.code);
  if (!/^[A-Z0-9-]{1,20}$/.test(code)) throw new ValidationError('Room code sirf letters / numbers, jaise C04 ya P-2.');
  return prisma.$transaction(async (tx) => {
    const taken = await tx.room.findUnique({ where: { code } });
    if (taken) throw new ConflictError('ROOM_EXISTS', taken.deletedAt ? `${code} ek delete kiye gaye room ka code tha (purane record mein hai) — doosra code chunein.` : `Room ${code} pehle se hai.`);
    const last = await tx.room.aggregate({ where: { kind: input.kind }, _max: { sortOrder: true } });
    const room = await tx.room.create({ data: { code, name: input.name?.trim() || code, kind: input.kind, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
    await audit(tx, actor, { action: 'ROOM_CREATED', recordType: 'Room', recordId: room.id, after: room });
    return room;
  });
}

export async function updateRoom(actor: Actor, id: string, input: { code?: string; name?: string; kind?: RoomKind; active?: boolean; sortOrder?: number }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${id} FOR UPDATE`;
    const before = await tx.room.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw new NotFoundError('Room');
    const code = input.code !== undefined ? cleanCode(input.code) : undefined;
    if (code !== undefined && !/^[A-Z0-9-]{1,20}$/.test(code)) throw new ValidationError('Room code sirf letters / numbers, jaise C04 ya P-2.');
    if (code && code !== before.code && (await tx.room.findUnique({ where: { code } }))) throw new ConflictError('ROOM_EXISTS', `Room code ${code} pehle se kisi room (ya delete kiye gaye room) ka hai.`);
    const leaving = input.active === false && before.active;
    const changingKind = input.kind !== undefined && input.kind !== before.kind;
    if (leaving || changingKind) {
      const ahead = await tx.roomReservation.count({ where: { roomId: id, status: 'ACTIVE', endAt: { gt: new Date() } } });
      if (ahead) throw new ConflictError('ROOM_HAS_BOOKINGS', `Room ${before.code} mein aage ${ahead} booking(s) hain — pehle unhein doosre room / waqt par le jayein.`);
      // a Doctor's assigned room must stay a usable consultation room
      if (leaving || input.kind === 'PROCEDURE') await tx.doctorProfile.updateMany({ where: { defaultRoomId: id }, data: { defaultRoomId: null } });
    }
    const after = await tx.room.update({
      where: { id },
      data: { ...(code ? { code } : {}), ...(input.name !== undefined ? { name: input.name.trim() || code || before.code } : {}), kind: input.kind, active: input.active, sortOrder: input.sortOrder },
    });
    await audit(tx, actor, { action: 'ROOM_UPDATED', recordType: 'Room', recordId: id, before, after });
    return after;
  });
}

/**
 * Delete a room (D-065). Refused while it has bookings ahead, a room still being cleaned, or an Assistant on it today.
 * Never used anywhere → removed. Used in any record → archived: out of use, hidden from every list, history intact.
 */
export async function deleteRoom(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${id} FOR UPDATE`;
    const before = await tx.room.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw new NotFoundError('Room');
    const ahead = await tx.roomReservation.count({ where: { roomId: id, OR: [{ status: 'ACTIVE', endAt: { gt: new Date() } }, { status: 'AWAITING_CLEAN' }] } });
    if (ahead) throw new ConflictError('ROOM_HAS_BOOKINGS', `Room ${before.code} mein aage ${ahead} booking(s) hain — pehle unhein doosre room / waqt par le jayein.`);
    if (await tx.roomAssignment.count({ where: { roomId: id, date: clinicDate(new Date()), unassignedAt: null } }))
      throw new ConflictError('ROOM_ASSIGNED_TODAY', `Room ${before.code} aaj Assistant ko assigned hai — kal delete karein ya pehle assignment hatayein.`);
    await tx.doctorProfile.updateMany({ where: { defaultRoomId: id }, data: { defaultRoomId: null } });
    const used = (
      await Promise.all([
        tx.roomReservation.count({ where: { roomId: id } }),
        tx.appointment.count({ where: { roomId: id } }),
        tx.treatmentPlanItem.count({ where: { roomId: id } }),
        tx.procedureTask.count({ where: { roomId: id } }),
        tx.workflowTask.count({ where: { roomId: id } }),
        tx.roomAssignment.count({ where: { roomId: id } }),
        tx.roomChecklistReport.count({ where: { roomId: id } }),
      ])
    ).some((n) => n > 0);
    if (used) await tx.room.update({ where: { id }, data: { active: false, deletedAt: new Date(), deletedById: actor.id } });
    else await tx.room.delete({ where: { id } });
    await audit(tx, actor, { action: 'ROOM_DELETED', recordType: 'Room', recordId: id, before, after: { archived: used } });
    return { id, archived: used };
  });
}
