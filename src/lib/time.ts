import { DateTime } from 'luxon';

/** Clinic timezone (spec §19, §26). All clinic-day logic goes through these helpers. */
export const CLINIC_TZ = process.env.APP_TIMEZONE || 'Asia/Karachi';

/** Clinic-local DateTime for a UTC instant. */
export function local(d: Date): DateTime {
  return DateTime.fromJSDate(d, { zone: CLINIC_TZ });
}

/** 'YYYY-MM-DD' clinic-local calendar date for an instant. */
export function clinicDateStr(d: Date): string {
  return local(d).toISODate()!;
}

/** The @db.Date value Prisma uses for a calendar date (midnight UTC of that date). */
export function dateOnly(isoDate: string): Date {
  const dt = DateTime.fromISO(isoDate, { zone: 'utc' });
  if (!dt.isValid) throw new Error(`Invalid date ${isoDate}`);
  return dt.startOf('day').toJSDate();
}

/** @db.Date value for the clinic-local calendar date of an instant. */
export function clinicDate(d: Date): Date {
  return dateOnly(clinicDateStr(d));
}

/** 'YYYY-MM-DD' of a @db.Date value. */
export function dateOnlyStr(d: Date): string {
  return DateTime.fromJSDate(d, { zone: 'utc' }).toISODate()!;
}

/** UTC instant for clinic-local date + minutes from midnight. */
export function atClinicMinute(isoDate: string, minute: number): Date {
  return DateTime.fromISO(isoDate, { zone: CLINIC_TZ }).startOf('day').plus({ minutes: minute }).toUTC().toJSDate();
}

/** Minutes from clinic-local midnight. */
export function clinicMinuteOfDay(d: Date): number {
  const l = local(d);
  return l.hour * 60 + l.minute;
}

/** ISO weekday (1=Mon..7=Sun) of a clinic-local date. */
export function clinicWeekday(isoDate: string): number {
  return DateTime.fromISO(isoDate, { zone: CLINIC_TZ }).weekday;
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

export function addDaysStr(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: 'utc' }).plus({ days }).toISODate()!;
}

/** UTC start/end instants of a clinic-local day. */
/** Calendar months later, clinic-local ('2026-10-18' + 2 → '2026-12-18'; month ends clamp). */
export function addMonthsStr(isoDate: string, months: number): string {
  return DateTime.fromISO(isoDate, { zone: CLINIC_TZ }).plus({ months }).toISODate()!;
}

export function clinicDayBounds(isoDate: string): { start: Date; end: Date } {
  const s = DateTime.fromISO(isoDate, { zone: CLINIC_TZ }).startOf('day');
  return { start: s.toUTC().toJSDate(), end: s.plus({ days: 1 }).toUTC().toJSDate() };
}

/** Round an instant up to the next multiple of `step` minutes (clinic-local grid). */
export function ceilToStep(d: Date, step: number): Date {
  const l = local(d);
  const hasSeconds = l.second > 0 || l.millisecond > 0;
  const mins = l.hour * 60 + l.minute + (hasSeconds ? 1 : 0);
  const rounded = Math.ceil(mins / step) * step;
  return l.startOf('day').plus({ minutes: rounded }).toUTC().toJSDate();
}

/** Half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export function formatClinic(d: Date, fmt = 'dd LLL yyyy, h:mm a'): string {
  return local(d).toFormat(fmt);
}
