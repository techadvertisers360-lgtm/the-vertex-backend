import { describe, expect, it } from 'vitest';
import { FINAL_SEQ, roundSchedule } from '../../src/modules/office/schedule';
import { atClinicMinute, clinicMinuteOfDay } from '../../src/lib/time';

const D = '2026-10-19';
const at = (hhmm: string) => atClinicMinute(D, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const hm = (d: Date) => {
  const m = clinicMinuteOfDay(d);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

describe('Office Boy round schedule (spec §13)', () => {
  it('check-in anchor: first check at arrival, every 2 h, final at 21:40', () => {
    const s = roundSchedule({ checkInAt: at('10:15'), anchor: 'checkin', shiftStart: '10:00', intervalMin: 120, finalTime: '21:40' });
    expect(s.map((r) => [r.seq, r.kind, hm(r.dueAt)])).toEqual([
      [1, 'FIRST_CHECK', '10:15'],
      [2, 'ROUND', '12:15'],
      [3, 'ROUND', '14:15'],
      [4, 'ROUND', '16:15'],
      [5, 'ROUND', '18:15'],
      [6, 'ROUND', '20:15'],
      [FINAL_SEQ, 'FINAL', '21:40'],
    ]);
  });

  it('no round at or after the final report time', () => {
    const s = roundSchedule({ checkInAt: at('11:40'), anchor: 'checkin', shiftStart: '10:00', intervalMin: 120, finalTime: '21:40' });
    expect(s.filter((r) => r.kind === 'ROUND').map((r) => hm(r.dueAt))).toEqual(['13:40', '15:40', '17:40', '19:40']);
  });

  it('shift-start anchor skips rounds before arrival', () => {
    const s = roundSchedule({ checkInAt: at('12:30'), anchor: 'shiftStart', shiftStart: '10:00', intervalMin: 120, finalTime: '21:40' });
    expect(s.map((r) => hm(r.dueAt))).toEqual(['12:30', '14:00', '16:00', '18:00', '20:00', '21:40']);
  });

  it('late arrival after the final time still has a final report', () => {
    const s = roundSchedule({ checkInAt: at('21:50'), anchor: 'checkin', shiftStart: '10:00', intervalMin: 120, finalTime: '21:40' });
    expect(s.map((r) => r.kind)).toEqual(['FIRST_CHECK', 'FINAL']);
  });
});
