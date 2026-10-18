import { describe, expect, it } from 'vitest';
import { formatRs, fromRupeeString, rupees, splitInstallments, sum, toPaisa } from '../../src/lib/money';
import { normalizePhone, phoneSearchFragment } from '../../src/lib/phone';
import { atClinicMinute, ceilToStep, clinicDateStr, clinicDayBounds, clinicMinuteOfDay, clinicWeekday, overlaps } from '../../src/lib/time';

describe('money (integer paisa, no floats)', () => {
  it('converts rupees and parses decimal strings exactly', () => {
    expect(rupees(20000)).toBe(2_000_000n);
    expect(fromRupeeString('1,234.50')).toBe(123_450n);
    expect(fromRupeeString('0.1')).toBe(10n);
    expect(fromRupeeString('0.07')).toBe(7n);
    expect(() => fromRupeeString('1.234')).toThrow();
    expect(sum([fromRupeeString('0.1'), fromRupeeString('0.2')])).toBe(30n); // 0.1 + 0.2 === 0.3 exactly
  });

  it('formats Rs with grouping', () => {
    expect(formatRs(2_000_000n)).toBe('Rs 20,000');
    expect(formatRs(123_450n)).toBe('Rs 1,234.50');
    expect(formatRs(-500n)).toBe('-Rs 5');
  });

  it('splits installments that always reconcile to the total', () => {
    for (const [total, n] of [
      [1_000_000n, 6],
      [1_000_001n, 5],
      [99n, 3],
      [0n, 4],
      [7_777_777n, 6],
    ] as const) {
      const parts = splitInstallments(total, n);
      expect(parts).toHaveLength(n);
      expect(sum(parts)).toBe(total);
      expect(parts.every((p) => p >= 0n)).toBe(true);
    }
    expect(splitInstallments(1_000_000n, 6).slice(0, 5)).toEqual(Array(5).fill(166_600n));
  });

  it('rejects non-integer paisa input', () => {
    expect(toPaisa(150)).toBe(150n);
    expect(toPaisa('150')).toBe(150n);
    expect(() => toPaisa(1.5)).toThrow();
    expect(() => toPaisa('1.5')).toThrow();
  });
});

describe('phone normalization', () => {
  it.each([
    ['0300-1234567', '923001234567'],
    ['+92 300 1234567', '923001234567'],
    ['0092 300 1234567', '923001234567'],
    ['3001234567', '923001234567'],
    ['923001234567', '923001234567'],
    ['(042) 35550000', '924235550000'],
    ['+44 20 7946 0958', '442079460958'],
  ])('%s → %s', (input, out) => {
    expect(normalizePhone(input)).toBe(out);
  });

  it.each(['', 'abc', '12', '0300-12345', '03001234567890', '+92 300 abc 4567'])('rejects %s', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('builds search fragments', () => {
    expect(phoneSearchFragment('0300 123')).toBe('92300123');
    expect(phoneSearchFragment('4567')).toBe('4567');
    expect(phoneSearchFragment('12')).toBeNull();
  });
});

describe('clinic time (Asia/Karachi, UTC+5, no DST)', () => {
  it('maps clinic-local minutes to UTC instants', () => {
    const d = atClinicMinute('2026-10-19', 14 * 60); // 2 PM PKT
    expect(d.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(clinicMinuteOfDay(d)).toBe(840);
    expect(clinicDateStr(new Date('2026-10-19T20:30:00Z'))).toBe('2026-10-20'); // 01:30 next day PKT
  });

  it('computes weekday and day bounds in clinic time', () => {
    expect(clinicWeekday('2026-10-19')).toBe(1); // Monday
    const b = clinicDayBounds('2026-10-19');
    expect(b.start.toISOString()).toBe('2026-10-18T19:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-10-19T19:00:00.000Z');
  });

  it('rounds up to the slot grid', () => {
    expect(ceilToStep(atClinicMinute('2026-10-19', 845), 10).toISOString()).toBe(atClinicMinute('2026-10-19', 850).toISOString());
    expect(ceilToStep(atClinicMinute('2026-10-19', 850), 10).toISOString()).toBe(atClinicMinute('2026-10-19', 850).toISOString());
    expect(ceilToStep(new Date(atClinicMinute('2026-10-19', 850).getTime() + 1000), 10).toISOString()).toBe(atClinicMinute('2026-10-19', 860).toISOString());
  });

  it('treats intervals as half-open', () => {
    const a = atClinicMinute('2026-10-19', 840);
    const b = atClinicMinute('2026-10-19', 860);
    const c = atClinicMinute('2026-10-19', 880);
    expect(overlaps(a, b, b, c)).toBe(false);
    expect(overlaps(a, c, b, c)).toBe(true);
  });
});
