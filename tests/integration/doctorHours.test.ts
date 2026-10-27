import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { addDaysStr, atClinicMinute, clinicDateStr } from '../../src/lib/time';
import { agentFor, call, ensureRooms, freeRoomsFrom, makeUser, newKey, prisma, uniquePhone } from './helpers';

/** D-049 — Doctor weekly hours + consultation room (Manager); check-in on / off per person (developer). */

let mgr: ReturnType<typeof call>;
let rec: { id: string; api: ReturnType<typeof call> };
const day = addDaysStr(clinicDateStr(new Date()), 6);
const at = (h: number, m = 0) => atClinicMinute(day, h * 60 + m).toISOString();
const ALL_WEEK = (start: string, end: string) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start, end }));

beforeAll(async () => {
  await ensureRooms();
  mgr = call((await agentFor('MANAGER')).agent);
  const r = await agentFor('RECEPTIONIST');
  rec = { id: r.user.id, api: call(r.agent) };
  await freeRoomsFrom(new Date(atClinicMinute(day, 0)));
});

const patient = () => prisma.patient.create({ data: { name: 'Hours Patient', phone: normalizePhone(uniquePhone())!, createdById: rec.id } });
const book = async (doctorId: string, start: string) => rec.api.post('/api/reception/appointments', { patientId: (await patient()).id, doctorId, type: 'CONSULTATION', start }, newKey());

describe('D-049 — weekly hours make a Doctor bookable', () => {
  it('no weekly hours → never bookable; Manager sets hours → bookable inside them only; history kept', async () => {
    const doc = await makeUser('DOCTOR');
    expect((await book(doc.id, at(11))).status).toBe(409);

    const save = await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: clinicDateStr(new Date()), days: ALL_WEEK('10:00', '18:00') });
    expect(save.status).toBe(200);
    expect(save.body.outsideHours).toEqual([]);
    expect((await book(doc.id, at(11))).status).toBe(201);
    expect((await book(doc.id, at(19))).status).toBe(409);

    const list = (await mgr.get('/api/manager/doctor-hours')).body;
    expect(list.doctors.find((d: { id: string }) => d.id === doc.id).current).toHaveLength(7);

    // a later change starts from its date; the booked 11:00 visit is reported as now outside the hours
    const later = await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: addDaysStr(clinicDateStr(new Date()), 2), days: ALL_WEEK('14:00', '20:00') });
    expect(later.body.outsideHours).toHaveLength(1);
    const rows = await prisma.doctorSchedule.findMany({ where: { doctorId: doc.id } });
    expect(rows.filter((r) => r.effectiveTo !== null)).toHaveLength(7); // old hours closed, not deleted
    expect((await book(doc.id, at(15))).status).toBe(201);
    expect(await prisma.auditEvent.count({ where: { action: 'DOCTOR_HOURS_SET', recordId: doc.id } })).toBe(2);
  });

  it('rejects bad hours; only the Manager can set them', async () => {
    const doc = await makeUser('DOCTOR');
    const today = clinicDateStr(new Date());
    expect((await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: today, days: [{ weekday: 1, start: '18:00', end: '10:00' }] })).status).toBe(422);
    expect((await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: today, days: [{ weekday: 1, start: '10:00', end: '14:00' }, { weekday: 1, start: '13:00', end: '16:00' }] })).status).toBe(422);
    expect((await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: addDaysStr(today, -1), days: [] })).status).toBe(422);
    for (const role of ['RECEPTIONIST', 'DOCTOR', 'LEAD_MEMBER'] as const)
      expect((await call((await agentFor(role)).agent).put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: today, days: [] })).status).toBe(403);
  });
});

describe('D-049 — a Doctor’s assigned room is used first; others avoid it', () => {
  it('books the assigned room; another Doctor at the same time gets a different room', async () => {
    const today = clinicDateStr(new Date());
    const a = await makeUser('DOCTOR');
    const b = await makeUser('DOCTOR');
    for (const d of [a, b]) await mgr.put(`/api/manager/doctor-hours/${d.id}`, { effectiveFrom: today, days: ALL_WEEK('09:00', '21:00') });
    const rooms = await prisma.room.findMany({ where: { kind: 'CONSULT', active: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    const last = rooms[rooms.length - 1]!;
    expect((await mgr.put(`/api/manager/doctor-hours/${a.id}/room`, { roomId: last.id })).status).toBe(200);
    expect((await mgr.put(`/api/manager/doctor-hours/${a.id}/room`, { roomId: (await prisma.room.findFirstOrThrow({ where: { kind: 'PROCEDURE' } })).id })).status).toBe(422);

    await freeRoomsFrom(new Date(at(16, 30)));
    const ba = await book(a.id, at(17));
    expect(ba.status).toBe(201);
    expect(ba.body.appointment.roomId).toBe(last.id);
    const bb = await book(b.id, at(17));
    expect(bb.status).toBe(201);
    expect(bb.body.appointment.roomId).not.toBe(last.id);
    expect((await mgr.get('/api/manager/doctor-hours')).body.doctors.find((d: { id: string }) => d.id === a.id).roomCode).toBe(last.code);
    await mgr.put(`/api/manager/doctor-hours/${a.id}/room`, { roomId: null });
  });
});

describe('D-049 — check-in / check-out switched off per person by the developer', () => {
  it('the developer turns it off: no check-in needed or possible, shown on /me and to the Manager; nobody else can switch it', async () => {
    const dev = call((await agentFor('DEVELOPER')).agent);
    const asst = await agentFor('ASSISTANT');
    const aapi = call(asst.agent);
    expect((await call((await agentFor('MD')).agent).patch(`/api/users/${asst.user.id}`, { attendanceRequired: false })).status).toBe(403);
    expect((await dev.patch(`/api/users/${asst.user.id}`, { attendanceRequired: false })).body.attendanceRequired).toBe(false);

    expect((await aapi.get('/api/me')).body.user.attendanceRequired).toBe(false);
    const ci = await aapi.post('/api/attendance/check-in');
    expect(ci.status).toBe(409);
    expect(ci.body.error.code).toBe('ATTENDANCE_OFF');
    const staff = (await mgr.get('/api/manager/staff')).body;
    expect(JSON.stringify(staff)).toContain('"attendanceRequired":false');
    expect((await dev.get('/api/developer/users')).body.items.find((u: { id: string }) => u.id === asst.user.id).attendanceRequired).toBe(false);

    // back on: check-in works again
    await dev.patch(`/api/users/${asst.user.id}`, { attendanceRequired: true });
    expect((await aapi.post('/api/attendance/check-in')).status).toBe(201);
  });
});

describe('D-050 — MD and Manager see who checked in / out and when', () => {
  it('lists every staff member with times, not-in and switched-off; others are refused', async () => {
    const r = await agentFor('RECEPTIONIST');
    await call(r.agent).post('/api/attendance/check-in');
    const off = await makeUser('OFFICE_BOY');
    await prisma.user.update({ where: { id: off.id }, data: { attendanceRequired: false } });
    const absent = await makeUser('ASSISTANT');
    for (const role of ['MD', 'MANAGER'] as const) {
      const res = await call((await agentFor(role)).agent).get('/api/md/attendance');
      expect(res.status, role).toBe(200);
      const by = (id: string) => res.body.items.find((i: { user: { id: string } }) => i.user.id === id);
      expect(by(r.user.id)).toMatchObject({ status: 'IN', checkInAt: expect.any(String) });
      expect(by(off.id).status).toBe('OFF');
      expect(by(absent.id)).toMatchObject({ status: 'NOT_IN', checkInAt: null });
      expect(res.body.items.some((i: { user: { role: string } }) => i.user.role === 'DEVELOPER' || i.user.role === 'MD')).toBe(false);
    }
    for (const role of ['RECEPTIONIST', 'LEAD_MEMBER', 'ASSISTANT'] as const) expect((await call((await agentFor(role)).agent).get('/api/md/attendance')).status).toBe(403);
  });
});

describe('D-051 — the Manager adds and edits rooms', () => {
  it('adds a room that bookings can use; cannot take a room with bookings ahead out of use; others refused', async () => {
    const code = `C${String(Date.now()).slice(-5)}`;
    const add = await mgr.post('/api/manager/rooms-admin', { code: code.toLowerCase(), name: 'Skin room', kind: 'CONSULT' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ code, kind: 'CONSULT', active: true });
    expect((await mgr.post('/api/manager/rooms-admin', { code, kind: 'CONSULT' })).status).toBe(409);
    expect((await mgr.post('/api/manager/rooms-admin', { code: 'bad code!', kind: 'CONSULT' })).status).toBe(422);

    // assign it to a Doctor and book: the new room is used
    const doc = await makeUser('DOCTOR');
    await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: clinicDateStr(new Date()), days: ALL_WEEK('09:00', '21:00') });
    await mgr.put(`/api/manager/doctor-hours/${doc.id}/room`, { roomId: add.body.id });
    const b = await book(doc.id, at(12, 10));
    expect(b.body.appointment.roomId).toBe(add.body.id);

    const busy = await mgr.patch(`/api/manager/rooms-admin/${add.body.id}`, { active: false });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('ROOM_HAS_BOOKINGS');
    expect((await mgr.patch(`/api/manager/rooms-admin/${add.body.id}`, { name: 'Skin room 2' })).body.name).toBe('Skin room 2');
    const listed = (await mgr.get('/api/manager/rooms-admin')).body.items.find((r: { id: string }) => r.id === add.body.id);
    expect(listed).toMatchObject({ bookingsAhead: 1, doctors: [doc.displayName] });

    // once the booking is gone the room can be taken out of use; the Doctor's room is cleared
    await prisma.roomReservation.updateMany({ where: { roomId: add.body.id }, data: { status: 'CANCELLED' } });
    expect((await mgr.patch(`/api/manager/rooms-admin/${add.body.id}`, { active: false })).body.active).toBe(false);
    expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doc.id } })).defaultRoomId).toBeNull();
    expect(await prisma.auditEvent.count({ where: { action: { in: ['ROOM_CREATED', 'ROOM_UPDATED'] }, recordId: add.body.id } })).toBe(3);
    for (const role of ['RECEPTIONIST', 'ASSISTANT'] as const) expect((await call((await agentFor(role)).agent).post('/api/manager/rooms-admin', { code: 'X9', kind: 'CONSULT' })).status).toBe(403);
  });
});

describe('D-053 — the MD opens today’s patients and Doctor leave (read-only)', () => {
  it('reads the day’s appointments, Doctors today and upcoming leave; cannot book', async () => {
    const md = call((await agentFor('MD')).agent);
    const doc = await makeUser('DOCTOR');
    await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: clinicDateStr(new Date()), days: ALL_WEEK('09:00', '21:00') });
    const leaveDay = addDaysStr(clinicDateStr(new Date()), 3);
    await prisma.doctorAvailabilityException.create({ data: { doctorId: doc.id, kind: 'LEAVE', date: new Date(`${leaveDay}T00:00:00Z`), status: 'APPROVED', requestedById: doc.id, reason: 'Family' } });

    const appts = await md.get('/api/reception/appointments');
    expect(appts.status).toBe(200);
    expect((await md.get('/api/reception/doctors-today')).body.items.some((d: { id: string }) => d.id === doc.id)).toBe(true);
    const leaves = await md.get('/api/md/doctor-leaves');
    expect(leaves.body.items.find((l: { date: string; doctor: string }) => l.date === leaveDay && l.doctor === doc.displayName)).toMatchObject({ kind: 'LEAVE', status: 'APPROVED', reason: 'Family' });
    expect((await mgr.get('/api/md/doctor-leaves')).status).toBe(200);
    expect((await md.post('/api/reception/appointments', { patientId: (await patient()).id, doctorId: doc.id, type: 'CONSULTATION', start: at(11) }, newKey())).status).toBe(403);
    expect((await call((await agentFor('LEAD_MEMBER')).agent).get('/api/md/doctor-leaves')).status).toBe(403);
  });
});

describe('D-064 — the Manager adds, edits and removes Doctors', () => {
  it('adds a Doctor who can then be booked; edits the profile; cannot remove with bookings ahead; never deletes', async () => {
    const code = `DR${String(Date.now()).slice(-6)}`;
    const add = await mgr.post('/api/manager/doctors-admin', { displayName: 'Dr Demo Added', specialty: 'Dermatology', memberCode: code, password: 'Doctor123' });
    expect(add.status).toBe(201);
    const id = add.body.id as string;
    expect(await prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true, active: true } })).toEqual({ role: 'DOCTOR', active: true });
    expect((await mgr.post('/api/manager/doctors-admin', { displayName: 'Dr Copy', memberCode: code, password: 'Doctor123' })).status).toBe(409);
    expect((await mgr.post('/api/manager/doctors-admin', { displayName: 'Dr No Login', password: 'Doctor123' })).status).toBe(422);

    const edit = await mgr.patch(`/api/manager/doctors-admin/${id}`, { displayName: 'Dr Demo Edited', specialty: 'Aesthetics' });
    expect(edit.status).toBe(200);
    const row = (await mgr.get('/api/manager/doctors-admin')).body.items.find((d: { id: string }) => d.id === id);
    expect(row).toMatchObject({ displayName: 'Dr Demo Edited', specialty: 'Aesthetics', active: true, bookingsAhead: 0 });

    await mgr.put(`/api/manager/doctor-hours/${id}`, { effectiveFrom: clinicDateStr(new Date()), days: ALL_WEEK('09:00', '21:00') });
    const b = await book(id, at(13, 10));
    expect(b.status).toBe(201);
    const blocked = await mgr.put(`/api/manager/doctors-admin/${id}/active`, { active: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DOCTOR_HAS_BOOKINGS');

    await prisma.appointment.update({ where: { id: b.body.appointment.id }, data: { status: 'CANCELLED' } });
    expect((await mgr.put(`/api/manager/doctors-admin/${id}/active`, { active: false })).body.active).toBe(false);
    expect(await prisma.user.findUniqueOrThrow({ where: { id }, select: { active: true } })).toEqual({ active: false });
    expect((await book(id, at(14, 10))).status).not.toBe(201);
    expect((await mgr.put(`/api/manager/doctors-admin/${id}/active`, { active: true })).body.active).toBe(true);
    expect(await prisma.auditEvent.count({ where: { recordId: id, action: { in: ['USER_CREATED', 'USER_UPDATED', 'USER_ACCESS_CHANGED'] } } })).toBe(4);

    for (const role of ['RECEPTIONIST', 'DOCTOR', 'MD'] as const) expect((await call((await agentFor(role)).agent).post('/api/manager/doctors-admin', { displayName: 'Dr X', memberCode: 'DRX99', password: 'Doctor123' })).status).toBe(403);
  });
});

describe('D-065 — the Manager edits and deletes rooms', () => {
  it('edits code / name / type; an unused room is removed; a used room is archived; bookings ahead block delete', async () => {
    const stamp = String(Date.now()).slice(-5);
    const add = await mgr.post('/api/manager/rooms-admin', { code: `E${stamp}`, kind: 'CONSULT' });
    const id = add.body.id as string;
    const edit = await mgr.patch(`/api/manager/rooms-admin/${id}`, { code: `F${stamp}`, name: 'Laser room', kind: 'CONSULT_PROCEDURE' });
    expect(edit.body).toMatchObject({ code: `F${stamp}`, name: 'Laser room', kind: 'CONSULT_PROCEDURE' });

    // never used → removed outright
    expect((await mgr.delete(`/api/manager/rooms-admin/${id}`)).body).toEqual({ id, archived: false });
    expect(await prisma.room.findUnique({ where: { id } })).toBeNull();
    expect((await mgr.delete(`/api/manager/rooms-admin/${id}`)).status).toBe(404);

    // used by a booking → blocked while ahead, archived once it is gone; code stays reserved for history
    const used = await mgr.post('/api/manager/rooms-admin', { code: `G${stamp}`, kind: 'CONSULT' });
    const doc = await makeUser('DOCTOR');
    await mgr.put(`/api/manager/doctor-hours/${doc.id}`, { effectiveFrom: clinicDateStr(new Date()), days: ALL_WEEK('09:00', '21:00') });
    await mgr.put(`/api/manager/doctor-hours/${doc.id}/room`, { roomId: used.body.id });
    const b = await book(doc.id, at(15, 10));
    expect(b.body.appointment.roomId).toBe(used.body.id);
    expect((await mgr.delete(`/api/manager/rooms-admin/${used.body.id}`)).body.error.code).toBe('ROOM_HAS_BOOKINGS');
    await prisma.roomReservation.updateMany({ where: { roomId: used.body.id }, data: { status: 'CANCELLED' } });
    expect((await mgr.delete(`/api/manager/rooms-admin/${used.body.id}`)).body).toEqual({ id: used.body.id, archived: true });
    expect(await prisma.room.findUniqueOrThrow({ where: { id: used.body.id }, select: { active: true, code: true } })).toEqual({ active: false, code: `G${stamp}` });
    expect((await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doc.id } })).defaultRoomId).toBeNull();
    expect((await mgr.get('/api/manager/rooms-admin')).body.items.some((r: { id: string }) => r.id === used.body.id)).toBe(false);
    expect((await mgr.patch(`/api/manager/rooms-admin/${used.body.id}`, { name: 'x' })).status).toBe(404);
    expect((await mgr.post('/api/manager/rooms-admin', { code: `G${stamp}`, kind: 'CONSULT' })).status).toBe(409);
    expect(await prisma.auditEvent.count({ where: { action: 'ROOM_DELETED', recordId: { in: [id, used.body.id] } } })).toBe(2);
    expect((await call((await agentFor('RECEPTIONIST')).agent).delete(`/api/manager/rooms-admin/${add.body.id}`)).status).toBe(403);
  });
});
