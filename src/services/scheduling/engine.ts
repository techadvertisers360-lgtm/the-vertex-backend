/**
 * Pure scheduling core (spec §6). No DB access: the loader in ./index.ts builds `EngineData`
 * inside a locked transaction and calls these functions, so the exact same rules run for the
 * booking form (options), the final save (authoritative check) and suggestions.
 *
 * Interval rules (docs/DECISIONS.md D-014):
 *  - Every interval is half-open [start, end).
 *  - A Doctor's occupied interval is [start, end + buffer(type)): 10 min after a consultation,
 *    20 min after a procedure (settings). A new booking's own occupied interval must not overlap any.
 *  - Room occupancy is the reservation interval; a room awaiting clean stays blocked (loader extends it).
 */
import type { AppointmentType, RoomKind } from '@prisma/client';
import { addDaysStr, addMinutes, atClinicMinute, ceilToStep, clinicDateStr, clinicWeekday, overlaps } from '../../lib/time';

export interface Interval {
  start: Date;
  end: Date;
}

export interface DoctorDay {
  date: string; // clinic-local YYYY-MM-DD
  windows: Interval[]; // bookable hours (regular, or approved alternate hours replacing them)
  pendingAlternate: Interval[]; // proposed alternate hours awaiting Manager approval — NOT bookable
  leave: Interval[]; // approved leave/absence
}

export type BusySource = 'appointment' | 'planned_procedure';

export interface DoctorBusy {
  id: string;
  start: Date;
  end: Date;
  type: AppointmentType;
  source: BusySource;
}

export interface RoomInfo {
  id: string;
  code: string;
  kind: RoomKind;
}

export interface RoomBusy {
  roomId: string;
  start: Date;
  end: Date;
  source: BusySource | 'awaiting_clean';
  refId: string;
}

export interface EngineConfig {
  consultBufferMin: number;
  procedureBufferMin: number;
  slotStepMin: number;
  horizonDays: number;
  /** Allow booking a slot that started up to this many minutes ago (walk-ins). */
  pastGraceMin: number;
}

export interface EngineData {
  now: Date;
  doctorId: string;
  /** Keyed by clinic-local date; missing date = not loaded / not working. */
  days: Map<string, DoctorDay>;
  doctorBusy: DoctorBusy[];
  /** Only rooms compatible with the requested appointment type, in preference order. */
  rooms: RoomInfo[];
  roomBusy: RoomBusy[];
  config: EngineConfig;
}

export interface SlotRequest {
  type: AppointmentType;
  start: Date;
  durationMin: number;
  /** Specific room requested; otherwise the first free compatible room is chosen. */
  roomId?: string;
}

export type Conflict =
  | { code: 'PAST' }
  | { code: 'DOCTOR_ON_LEAVE'; start: Date; end: Date }
  | { code: 'ALTERNATE_PENDING'; start: Date; end: Date }
  | { code: 'OUTSIDE_HOURS' }
  | { code: 'DOCTOR_BUSY'; source: BusySource; busyType: AppointmentType; refId: string; start: Date; end: Date }
  | { code: 'ROOM_TYPE_MISMATCH'; roomId: string }
  | { code: 'ROOM_BUSY'; roomId: string; until: Date; source: RoomBusy['source'] }
  | { code: 'NO_ROOM'; rooms: { roomId: string; until: Date; source: RoomBusy['source'] }[] };

export type CheckResult =
  | { ok: true; start: Date; end: Date; roomId: string }
  | { ok: false; start: Date; end: Date; conflicts: Conflict[] };

export type SuggestionReason =
  | { code: 'AFTER_CONSULTATION'; refEnd: Date; source: BusySource; bufferMin: number }
  | { code: 'AFTER_PROCEDURE'; refEnd: Date; source: BusySource; bufferMin: number }
  | { code: 'NEXT_FREE_ROOM'; refEnd: Date }
  | { code: 'NEXT_AVAILABLE_DATE'; date: string }
  | { code: 'NEXT_WORKING_HOURS' }
  | { code: 'LATER_SLOT' };

export interface Suggestion {
  start: Date;
  end: Date;
  roomId: string;
  reason: SuggestionReason;
}

export function bufferFor(type: AppointmentType, c: EngineConfig): number {
  return type === 'PROCEDURE' ? c.procedureBufferMin : c.consultBufferMin;
}

export function roomKindFor(type: AppointmentType): RoomKind {
  return type === 'PROCEDURE' ? 'PROCEDURE' : 'CONSULT';
}

/** Room kinds that can host this appointment type: its own kind, plus Consultation + Procedure rooms (D-063). */
export function roomKindsFor(type: AppointmentType): RoomKind[] {
  return [roomKindFor(type), 'CONSULT_PROCEDURE'];
}

/** Authoritative check of one slot. Used both for UI options and at final save. */
export function checkSlot(data: EngineData, req: SlotRequest): CheckResult {
  const { config: c } = data;
  const start = req.start;
  const end = addMinutes(start, req.durationMin);
  const conflicts: Conflict[] = [];

  if (start.getTime() < data.now.getTime() - c.pastGraceMin * 60_000) conflicts.push({ code: 'PAST' });

  // Doctor availability for the day.
  const day = data.days.get(clinicDateStr(start));
  const leave = day?.leave.find((l) => overlaps(start, end, l.start, l.end));
  if (leave) {
    conflicts.push({ code: 'DOCTOR_ON_LEAVE', start: leave.start, end: leave.end });
  } else if (!day || !day.windows.some((w) => w.start <= start && end <= w.end)) {
    const pending = day?.pendingAlternate.find((w) => w.start <= start && end <= w.end);
    conflicts.push(pending ? { code: 'ALTERNATE_PENDING', start: pending.start, end: pending.end } : { code: 'OUTSIDE_HOURS' });
  }

  // Doctor overlap with appointments and planned procedures (incl. buffers on both sides).
  const occEnd = addMinutes(end, bufferFor(req.type, c));
  for (const b of data.doctorBusy) {
    const bEnd = addMinutes(b.end, bufferFor(b.type, c));
    if (overlaps(start, occEnd, b.start, bEnd)) {
      conflicts.push({ code: 'DOCTOR_BUSY', source: b.source, busyType: b.type, refId: b.id, start: b.start, end: b.end });
    }
  }

  // Room: type match and occupancy.
  const blockers = (roomId: string) => data.roomBusy.filter((r) => r.roomId === roomId && overlaps(start, end, r.start, r.end));
  const untilOf = (roomId: string) => {
    const bl = blockers(roomId);
    return bl.reduce((m, r) => (r.end > m ? r.end : m), bl[0]!.end);
  };
  let roomId: string | undefined;
  if (req.roomId) {
    const room = data.rooms.find((r) => r.id === req.roomId);
    if (!room) {
      conflicts.push({ code: 'ROOM_TYPE_MISMATCH', roomId: req.roomId });
    } else if (blockers(room.id).length) {
      conflicts.push({ code: 'ROOM_BUSY', roomId: room.id, until: untilOf(room.id), source: blockers(room.id)[0]!.source });
    } else {
      roomId = room.id;
    }
  } else {
    const free = data.rooms.find((r) => blockers(r.id).length === 0);
    if (free) roomId = free.id;
    else {
      conflicts.push({
        code: 'NO_ROOM',
        rooms: data.rooms.map((r) => ({ roomId: r.id, until: untilOf(r.id), source: blockers(r.id)[0]!.source })),
      });
    }
  }

  if (conflicts.length === 0 && roomId) return { ok: true, start, end, roomId };
  return { ok: false, start, end, conflicts };
}

/**
 * Earliest instant strictly after `t` where a bookable stretch could begin: a window start, or the end
 * of a partial leave inside a window. Scans forward up to the horizon.
 */
function nextWindowStart(data: EngineData, t: Date): { at: Date; date: string } | null {
  const startDate = clinicDateStr(t);
  for (let i = 0; i <= data.config.horizonDays; i++) {
    const date = addDaysStr(startDate, i);
    const day = data.days.get(date);
    if (!day) continue;
    const points: Date[] = [];
    for (const w of day.windows) {
      if (w.start > t) points.push(w.start);
      for (const l of day.leave) if (l.end > t && l.end > w.start && l.end < w.end) points.push(l.end);
    }
    if (points.length) {
      const at = points.reduce((m, p) => (p < m ? p : m));
      return { at, date };
    }
  }
  return null;
}

type Candidate = { at: Date; reason: SuggestionReason };

/**
 * Candidate start times derived from the conflicts of a failed check (spec §6 suggestion rules).
 * Every candidate is strictly later than `res.start`, which guarantees the search makes progress.
 */
function candidatesFrom(data: EngineData, res: Extract<CheckResult, { ok: false }>, requestDate: string): Candidate[] {
  const c = data.config;
  const out: Candidate[] = [];
  let needWindow = false;
  let pastOnly = true;
  for (const k of res.conflicts) {
    if (k.code !== 'PAST') pastOnly = false;
    switch (k.code) {
      case 'DOCTOR_BUSY': {
        // Consultation conflict → end + 10; procedure conflict → end + 20 (settings).
        const buf = bufferFor(k.busyType, c);
        out.push({
          at: addMinutes(k.end, buf),
          reason:
            k.busyType === 'PROCEDURE'
              ? { code: 'AFTER_PROCEDURE', refEnd: k.end, source: k.source, bufferMin: buf }
              : { code: 'AFTER_CONSULTATION', refEnd: k.end, source: k.source, bufferMin: buf },
        });
        break;
      }
      case 'NO_ROOM': {
        // All compatible rooms busy → earliest time any of them frees up.
        const earliest = k.rooms.reduce((m, r) => (r.until < m ? r.until : m), k.rooms[0]?.until ?? res.end);
        out.push({ at: earliest, reason: { code: 'NEXT_FREE_ROOM', refEnd: earliest } });
        break;
      }
      case 'ROOM_BUSY':
        out.push({ at: k.until, reason: { code: 'NEXT_FREE_ROOM', refEnd: k.until } });
        break;
      case 'DOCTOR_ON_LEAVE':
      case 'OUTSIDE_HOURS':
      case 'ALTERNATE_PENDING':
      case 'PAST':
        needWindow = true;
        break;
      case 'ROOM_TYPE_MISMATCH':
        break;
    }
  }
  if (needWindow) {
    let from = res.start;
    if (res.conflicts.some((k) => k.code === 'PAST')) {
      const nowSlot = ceilToStep(data.now, c.slotStepMin);
      if (nowSlot > from) from = nowSlot;
      if (pastOnly && from > res.start) out.push({ at: from, reason: { code: 'NEXT_WORKING_HOURS' } });
    }
    const leave = res.conflicts.find((k): k is Extract<Conflict, { code: 'DOCTOR_ON_LEAVE' }> => k.code === 'DOCTOR_ON_LEAVE');
    if (leave && leave.end.getTime() - 1 > from.getTime()) from = new Date(leave.end.getTime() - 1);
    const nw = nextWindowStart(data, from);
    if (nw) {
      out.push({ at: nw.at, reason: nw.date === requestDate ? { code: 'NEXT_WORKING_HOURS' } : { code: 'NEXT_AVAILABLE_DATE', date: nw.date } });
    }
  }
  return out.filter((x) => x.at > res.start);
}

/**
 * Suggest up to `max` valid alternatives for a rejected request. The first suggestion follows the spec
 * rule for the blocking conflict (e.g. consultation end + 10 min); when that candidate is itself blocked the
 * same rules are applied again until a time with both Doctor and a compatible room free is found.
 */
export function suggest(data: EngineData, req: SlotRequest, max = 3): Suggestion[] {
  const first = checkSlot(data, req);
  if (first.ok) return [];
  const requestDate = clinicDateStr(req.start);
  const step = data.config.slotStepMin;
  const horizonEnd = atClinicMinute(addDaysStr(requestDate, data.config.horizonDays + 1), 0);
  // Keep a specific room only when the caller insisted on it and it has the right type.
  const roomFixed = req.roomId && data.rooms.some((r) => r.id === req.roomId) ? req.roomId : undefined;

  const queue: Candidate[] = candidatesFrom(data, first, requestDate);
  const seen = new Set<number>();
  const out: Suggestion[] = [];
  let guard = 0;
  while (queue.length && out.length < max && guard++ < 2000) {
    queue.sort((a, b) => a.at.getTime() - b.at.getTime());
    const cand = queue.shift()!;
    const key = cand.at.getTime();
    if (seen.has(key) || cand.at >= horizonEnd) continue;
    seen.add(key);
    const res = checkSlot(data, { ...req, start: cand.at, roomId: roomFixed });
    if (res.ok) {
      out.push({ start: res.start, end: res.end, roomId: res.roomId, reason: cand.reason });
      queue.push({ at: ceilToStep(addMinutes(cand.at, step), step), reason: { code: 'LATER_SLOT' } });
    } else {
      queue.push(...candidatesFrom(data, res, requestDate));
    }
  }
  return out;
}


/** All bookable grid slots of one clinic day for the booking form, plus not-bookable pending alternate windows. */
export function listDaySlots(data: EngineData, date: string, type: AppointmentType, durationMin: number) {
  const day = data.days.get(date);
  const slots: { start: Date; end: Date; roomId: string }[] = [];
  const step = data.config.slotStepMin;
  for (const w of day?.windows ?? []) {
    for (let t = ceilToStep(w.start, step); addMinutes(t, durationMin) <= w.end; t = addMinutes(t, step)) {
      const r = checkSlot(data, { type, start: t, durationMin });
      if (r.ok) slots.push({ start: r.start, end: r.end, roomId: r.roomId });
    }
  }
  return {
    date,
    onLeave: (day?.leave ?? []).map((l) => ({ start: l.start, end: l.end })),
    pendingAlternate: (day?.pendingAlternate ?? []).map((p) => ({ start: p.start, end: p.end, label: 'Manager approval pending' })),
    slots,
  };
}

// ───────────── Doctor day construction (pure; unit-tested) ─────────────

export interface ScheduleRow {
  weekday: number;
  startMinute: number;
  endMinute: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  active: boolean;
}

export interface ExceptionRow {
  kind: 'LEAVE' | 'ABSENT' | 'ALTERNATE_HOURS';
  status: string; // RequestStatus
  date: string;
  startMinute: number | null;
  endMinute: number | null;
}

function mergeIntervals(list: Interval[]): Interval[] {
  const s = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/**
 * Bookable windows for one date:
 *  - regular weekly hours effective on that date;
 *  - approved ALTERNATE_HOURS for that date replace regular hours (D-015); pending ones are listed but not bookable;
 *  - approved LEAVE / ABSENT (full day when minutes are null) block time.
 */
export function buildDoctorDay(date: string, schedules: ScheduleRow[], exceptions: ExceptionRow[]): DoctorDay {
  const weekday = clinicWeekday(date);
  const win = (s: number, e: number): Interval => ({ start: atClinicMinute(date, s), end: atClinicMinute(date, e) });
  const regular = schedules
    .filter((s) => s.active && s.weekday === weekday && s.effectiveFrom <= date && (!s.effectiveTo || s.effectiveTo >= date))
    .map((s) => win(s.startMinute, s.endMinute));
  const ex = exceptions.filter((e) => e.date === date);
  const altApproved = ex.filter((e) => e.kind === 'ALTERNATE_HOURS' && e.status === 'APPROVED' && e.startMinute !== null && e.endMinute !== null);
  const altPending = ex.filter((e) => e.kind === 'ALTERNATE_HOURS' && e.status === 'PENDING' && e.startMinute !== null && e.endMinute !== null);
  const leave = ex
    .filter((e) => (e.kind === 'LEAVE' || e.kind === 'ABSENT') && e.status === 'APPROVED')
    .map((e) => (e.startMinute === null || e.endMinute === null ? win(0, 24 * 60) : win(e.startMinute, e.endMinute)));
  return {
    date,
    windows: mergeIntervals(altApproved.length ? altApproved.map((e) => win(e.startMinute!, e.endMinute!)) : regular),
    pendingAlternate: mergeIntervals(altPending.map((e) => win(e.startMinute!, e.endMinute!))),
    leave: mergeIntervals(leave),
  };
}
