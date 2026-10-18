import type { OfficeRoundKind } from '@prisma/client';
import { atClinicMinute, clinicDateStr } from '../../lib/time';

/**
 * Office Boy round timetable for one shift (spec §13): a first clinic check at check-in, a round every
 * `intervalMin` from the anchor (check-in, or the configured shift start — §26 #11), and the final report at
 * `finalTime`. Sequence numbers are deterministic, so the DB unique (attendanceId, seq) makes creation idempotent.
 */
export const FINAL_SEQ = 999;

export interface PlannedRound {
  seq: number;
  kind: OfficeRoundKind;
  dueAt: Date;
}

const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function roundSchedule(opts: { checkInAt: Date; anchor: 'checkin' | 'shiftStart'; shiftStart: string; intervalMin: number; finalTime: string }): PlannedRound[] {
  const day = clinicDateStr(opts.checkInAt);
  const final = atClinicMinute(day, minuteOf(opts.finalTime));
  const anchor = opts.anchor === 'shiftStart' ? atClinicMinute(day, minuteOf(opts.shiftStart)) : opts.checkInAt;
  const out: PlannedRound[] = [{ seq: 1, kind: 'FIRST_CHECK', dueAt: opts.checkInAt }];
  const step = opts.intervalMin * 60_000;
  for (let k = 1; k < 200; k++) {
    const due = new Date(anchor.getTime() + k * step);
    if (due >= final) break;
    if (due <= opts.checkInAt) continue; // shift-start anchor: rounds before arrival are not owed
    out.push({ seq: out.length + 1, kind: 'ROUND', dueAt: due });
  }
  out.push({ seq: FINAL_SEQ, kind: 'FINAL', dueAt: final });
  return out;
}
