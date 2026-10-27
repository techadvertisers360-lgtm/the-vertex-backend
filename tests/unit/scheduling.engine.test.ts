import { describe, expect, it } from 'vitest';
import type { AppointmentType } from '@prisma/client';
import {
  buildDoctorDay,
  checkSlot,
  listDaySlots,
  roomKindsFor,
  suggest,
  type DoctorBusy,
  type EngineData,
  type ExceptionRow,
  type RoomBusy,
  type RoomInfo,
  type ScheduleRow,
} from '../../src/services/scheduling/engine';
import { addDaysStr, atClinicMinute, clinicMinuteOfDay, clinicDateStr } from '../../src/lib/time';

// Monday 2026-10-19, Doctor works Mon–Sat 14:00–21:00 clinic time (Asia/Karachi).
const D = '2026-10-19';
const at = (hhmm: string, date = D) => atClinicMinute(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const hm = (d: Date) => {
  const m = clinicMinuteOfDay(d);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const CONSULT_ROOMS: RoomInfo[] = ['C01', 'C02', 'C03'].map((code) => ({ id: code, code, kind: 'CONSULT' }));
const PROC_ROOMS: RoomInfo[] = ['P01', 'P02', 'P03'].map((code) => ({ id: code, code, kind: 'PROCEDURE' }));

const SCHEDULE: ScheduleRow[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 14 * 60,
  endMinute: 21 * 60,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  active: true,
}));

function data(opts: {
  type?: AppointmentType;
  busy?: DoctorBusy[];
  roomBusy?: RoomBusy[];
  exceptions?: ExceptionRow[];
  now?: Date;
  schedules?: ScheduleRow[];
} = {}): EngineData {
  const days = new Map();
  for (let i = -1; i <= 14; i++) {
    const date = addDaysStr(D, i);
    days.set(date, buildDoctorDay(date, opts.schedules ?? SCHEDULE, opts.exceptions ?? []));
  }
  return {
    now: opts.now ?? at('10:00', '2026-10-18'),
    doctorId: 'dr1',
    days,
    doctorBusy: opts.busy ?? [],
    rooms: (opts.type ?? 'CONSULTATION') === 'PROCEDURE' ? PROC_ROOMS : CONSULT_ROOMS,
    roomBusy: opts.roomBusy ?? [],
    config: { consultBufferMin: 10, procedureBufferMin: 20, slotStepMin: 10, horizonDays: 14, pastGraceMin: 10 },
  };
}

const consult = (start: string, end: string, id = 'a1', source: DoctorBusy['source'] = 'appointment'): DoctorBusy => ({
  id, start: at(start), end: at(end), type: 'CONSULTATION', source,
});
const procedure = (start: string, end: string, id = 'p1', source: DoctorBusy['source'] = 'appointment'): DoctorBusy => ({
  id, start: at(start), end: at(end), type: 'PROCEDURE', source,
});
const roomBusy = (roomId: string, start: string, end: string, refId = 'x'): RoomBusy => ({
  roomId, start: at(start), end: at(end), source: 'appointment', refId,
});

describe('§6 row 1 — Doctor available in approved regular hours', () => {
  it('slot is bookable and the first free compatible room is chosen', () => {
    const r = checkSlot(data(), { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.roomId).toBe('C01');
  });

  it('slot must fit fully inside working hours', () => {
    const r = checkSlot(data(), { type: 'CONSULTATION', start: at('20:50'), durationMin: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts.map((c) => c.code)).toContain('OUTSIDE_HOURS');
  });

  it('booking form lists only free grid slots', () => {
    const d = listDaySlots(data({ busy: [consult('14:00', '14:20')] }), D, 'CONSULTATION', 20);
    expect(hm(d.slots[0]!.start)).toBe('14:30'); // 14:00 busy, buffer till 14:30
    expect(hm(d.slots[d.slots.length - 1]!.start)).toBe('20:40');
  });
});

describe('§6 row 2 — Doctor on leave', () => {
  const leave: ExceptionRow[] = [{ kind: 'LEAVE', status: 'APPROVED', date: D, startMinute: null, endMinute: null }];

  it('no slot on the leave date can be saved (§25: Lead tries Doctor leave date)', () => {
    const d = data({ exceptions: leave });
    for (const t of ['14:00', '16:00', '20:00']) {
      const r = checkSlot(d, { type: 'CONSULTATION', start: at(t), durationMin: 20 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.conflicts[0]!.code).toBe('DOCTOR_ON_LEAVE');
    }
    expect(listDaySlots(d, D, 'CONSULTATION', 20).slots).toHaveLength(0);
  });

  it('suggests the next available date/time', () => {
    const s = suggest(data({ exceptions: leave }), { type: 'CONSULTATION', start: at('16:00'), durationMin: 20 });
    expect(s.length).toBeGreaterThan(0);
    expect(clinicDateStr(s[0]!.start)).toBe(addDaysStr(D, 1));
    expect(hm(s[0]!.start)).toBe('14:00');
    expect(s[0]!.reason.code).toBe('NEXT_AVAILABLE_DATE');
  });

  it('partial-day leave resumes after the leave ends', () => {
    const d = data({ exceptions: [{ kind: 'ABSENT', status: 'APPROVED', date: D, startMinute: 16 * 60, endMinute: 18 * 60 }] });
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 }).ok).toBe(true);
    const s = suggest(d, { type: 'CONSULTATION', start: at('16:30'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('18:00');
  });

  it('a leave still in draft (PENDING) does not block — only confirmed leave does', () => {
    const d = data({ exceptions: [{ kind: 'LEAVE', status: 'PENDING', date: D, startMinute: null, endMinute: null }] });
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 }).ok).toBe(true);
  });
});

describe('§6 row 3 — alternate availability pending Manager approval', () => {
  const sunday = '2026-10-25';
  it('pending alternate hours are not bookable and are labelled', () => {
    const d = data({ exceptions: [{ kind: 'ALTERNATE_HOURS', status: 'PENDING', date: sunday, startMinute: 10 * 60, endMinute: 13 * 60 }] });
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('11:00', sunday), durationMin: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts[0]!.code).toBe('ALTERNATE_PENDING');
    const day = listDaySlots(d, sunday, 'CONSULTATION', 20);
    expect(day.slots).toHaveLength(0);
    expect(day.pendingAlternate[0]!.label).toBe('Manager approval pending');
  });

  it('once approved, alternate hours become bookable and replace regular hours for that date', () => {
    const d = data({ exceptions: [{ kind: 'ALTERNATE_HOURS', status: 'APPROVED', date: D, startMinute: 10 * 60, endMinute: 13 * 60 }] });
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('11:00'), durationMin: 20 }).ok).toBe(true);
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 }).ok).toBe(false);
  });
});

describe('§6 row 4 — Doctor already has a consultation (§25: +10 min)', () => {
  it('rejects the same time and suggests 10 minutes after the consultation ends', () => {
    const d = data({ busy: [consult('15:00', '15:20')] });
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts).toContainEqual(expect.objectContaining({ code: 'DOCTOR_BUSY', source: 'appointment', busyType: 'CONSULTATION' }));
    const s = suggest(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('15:30');
    expect(s[0]!.reason).toMatchObject({ code: 'AFTER_CONSULTATION', bufferMin: 10 });
  });

  it('buffer is enforced at save: booking at the exact end time is rejected; end+10 is accepted', () => {
    const d = data({ busy: [consult('15:00', '15:20')] });
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('15:20'), durationMin: 20 }).ok).toBe(false);
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('15:30'), durationMin: 20 }).ok).toBe(true);
  });

  it("the new booking's own buffer must clear the next appointment", () => {
    const d = data({ busy: [consult('15:00', '15:20')] });
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('14:40'), durationMin: 20 }).ok).toBe(false); // ends 15:00, +10 overlaps
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('14:30'), durationMin: 20 }).ok).toBe(true); // ends 14:50, +10 = 15:00
  });

  it('chains when end+10 lands on another consultation', () => {
    const d = data({ busy: [consult('15:00', '15:20', 'a1'), consult('15:30', '15:50', 'a2')] });
    const s = suggest(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('16:00');
  });

  it('suggested slot requires Doctor and room both free', () => {
    const d = data({ busy: [consult('15:00', '15:20')], roomBusy: ['C01', 'C02', 'C03'].map((r) => roomBusy(r, '15:20', '16:00')) });
    const s = suggest(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('16:00');
    for (const x of s) expect(checkSlot(d, { type: 'CONSULTATION', start: x.start, durationMin: 20 }).ok).toBe(true);
  });
});

describe('§6 row 5 — Doctor is in a procedure (§25: +20 min)', () => {
  it('suggests the next consult slot 20 minutes after the procedure ends, with the reason', () => {
    const d = data({ busy: [procedure('15:00', '16:00')] });
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('15:30'), durationMin: 20 });
    expect(r.ok).toBe(false);
    const s = suggest(d, { type: 'CONSULTATION', start: at('15:30'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('16:20');
    expect(s[0]!.reason).toMatchObject({ code: 'AFTER_PROCEDURE', bufferMin: 20 });
    if (s[0]!.reason.code === 'AFTER_PROCEDURE') expect(hm(s[0]!.reason.refEnd)).toBe('16:00');
  });
});

describe('§6 rows 6–8 — rooms (§25: all three compatible rooms busy)', () => {
  it('consult room busy → another free consult room is used', () => {
    const d = data({ roomBusy: [roomBusy('C01', '15:00', '15:30'), roomBusy('C02', '15:00', '15:30')] });
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(r.ok && r.roomId).toBe('C03');
  });

  it('all three consult rooms busy blocks booking and suggests the earliest free room/time', () => {
    const d = data({ roomBusy: [roomBusy('C01', '15:00', '16:00'), roomBusy('C02', '15:00', '15:40'), roomBusy('C03', '14:50', '16:30')] });
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts[0]!.code).toBe('NO_ROOM');
    const s = suggest(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('15:40');
    expect(s[0]!.roomId).toBe('C02');
    expect(s[0]!.reason.code).toBe('NEXT_FREE_ROOM');
  });

  it('all three procedure rooms busy blocks a procedure booking', () => {
    const d = data({ type: 'PROCEDURE', roomBusy: ['P01', 'P02', 'P03'].map((r) => roomBusy(r, '15:00', '16:00')) });
    const r = checkSlot(d, { type: 'PROCEDURE', start: at('15:00'), durationMin: 60 });
    expect(r.ok).toBe(false);
    const s = suggest(d, { type: 'PROCEDURE', start: at('15:00'), durationMin: 60 });
    expect(hm(s[0]!.start)).toBe('16:00');
    expect(['P01', 'P02', 'P03']).toContain(s[0]!.roomId);
  });

  it('procedure rooms are never used for consultations (room type must match)', () => {
    const d = data();
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20, roomId: 'P01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts[0]!.code).toBe('ROOM_TYPE_MISMATCH');
  });

  it('a Consultation + Procedure room hosts either type and is shared between them (D-063)', () => {
    const shared: RoomInfo = { id: 'X01', code: 'X01', kind: 'CONSULT_PROCEDURE' };
    expect(roomKindsFor('CONSULTATION')).toEqual(['CONSULT', 'CONSULT_PROCEDURE']);
    expect(roomKindsFor('PROCEDURE')).toEqual(['PROCEDURE', 'CONSULT_PROCEDURE']);
    const c = { ...data(), rooms: [shared] };
    expect(checkSlot(c, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20, roomId: 'X01' }).ok).toBe(true);
    const p = { ...data({ type: 'PROCEDURE', roomBusy: [roomBusy('X01', '15:00', '15:20')] }), rooms: [shared] };
    const r = checkSlot(p, { type: 'PROCEDURE', start: at('15:00'), durationMin: 60 });
    expect(r.ok).toBe(false);
  });

  it('a specifically requested busy room is rejected with when it frees up', () => {
    const d = data({ roomBusy: [roomBusy('C02', '15:00', '15:45')] });
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('15:10'), durationMin: 20, roomId: 'C02' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts[0]).toMatchObject({ code: 'ROOM_BUSY', roomId: 'C02' });
  });
});

describe('§6 row 9 — future treatment-plan procedures occupy the calendar (§25)', () => {
  it('conflict carries the source label "planned_procedure"', () => {
    const d = data({ busy: [procedure('17:00', '18:00', 'plan-item-1', 'planned_procedure')] });
    const r = checkSlot(d, { type: 'CONSULTATION', start: at('17:30'), durationMin: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts).toContainEqual(expect.objectContaining({ code: 'DOCTOR_BUSY', source: 'planned_procedure', refId: 'plan-item-1' }));
    const s = suggest(d, { type: 'CONSULTATION', start: at('17:30'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('18:20');
    expect(s[0]!.reason).toMatchObject({ code: 'AFTER_PROCEDURE', source: 'planned_procedure' });
  });
});

describe('misc rules', () => {
  it('past slots are rejected (with walk-in grace)', () => {
    const now = at('15:05');
    const d = data({ now });
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('14:00'), durationMin: 20 }).ok).toBe(false);
    expect(checkSlot(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 }).ok).toBe(true); // within 10-min grace
    const s = suggest(d, { type: 'CONSULTATION', start: at('14:00'), durationMin: 20 });
    expect(hm(s[0]!.start)).toBe('15:10');
  });

  it('outside hours suggests the next working window', () => {
    const s = suggest(data(), { type: 'CONSULTATION', start: at('21:30'), durationMin: 20 });
    expect(clinicDateStr(s[0]!.start)).toBe(addDaysStr(D, 1));
    expect(hm(s[0]!.start)).toBe('14:00');
  });

  it('Sunday (no regular hours) rolls to Monday', () => {
    const sunday = '2026-10-25';
    const s = suggest(data(), { type: 'CONSULTATION', start: at('15:00', sunday), durationMin: 20 });
    expect(clinicDateStr(s[0]!.start)).toBe('2026-10-26');
  });

  it('every suggestion is itself a valid slot, distinct and in order', () => {
    const d = data({
      busy: [consult('14:00', '14:20'), procedure('14:30', '15:30'), consult('15:50', '16:10', 'a3', 'appointment')],
      roomBusy: [roomBusy('C01', '16:20', '17:00'), roomBusy('C02', '16:20', '17:00'), roomBusy('C03', '16:20', '16:40')],
    });
    const s = suggest(d, { type: 'CONSULTATION', start: at('14:00'), durationMin: 20 }, 5);
    expect(s.length).toBe(5);
    const times = s.map((x) => x.start.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    for (const x of s) expect(checkSlot(d, { type: 'CONSULTATION', start: x.start, durationMin: 20 }).ok).toBe(true);
  });

  it('nothing available within the horizon returns no suggestions (no infinite loop)', () => {
    const d = data({ schedules: [] });
    expect(suggest(d, { type: 'CONSULTATION', start: at('15:00'), durationMin: 20 })).toEqual([]);
  });
});

describe('buildDoctorDay', () => {
  it('respects effective date ranges', () => {
    const rows: ScheduleRow[] = [{ weekday: 1, startMinute: 600, endMinute: 720, effectiveFrom: '2026-11-01', effectiveTo: null, active: true }];
    expect(buildDoctorDay(D, rows, []).windows).toHaveLength(0);
    expect(buildDoctorDay('2026-11-02', rows, []).windows).toHaveLength(1);
  });
  it('merges overlapping windows and ignores inactive rows', () => {
    const rows: ScheduleRow[] = [
      { weekday: 1, startMinute: 600, endMinute: 720, effectiveFrom: '2026-01-01', effectiveTo: null, active: true },
      { weekday: 1, startMinute: 700, endMinute: 800, effectiveFrom: '2026-01-01', effectiveTo: null, active: true },
      { weekday: 1, startMinute: 900, endMinute: 1000, effectiveFrom: '2026-01-01', effectiveTo: null, active: false },
    ];
    const day = buildDoctorDay(D, rows, []);
    expect(day.windows).toHaveLength(1);
    expect(hm(day.windows[0]!.end)).toBe('13:20');
  });
});
