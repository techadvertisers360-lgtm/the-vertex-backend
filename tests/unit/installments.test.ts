import { describe, expect, it } from 'vitest';
import { balanceCovered, installmentViews } from '../../src/services/installments';

const inst = (seq: number, due: string, amount: bigint) => ({ id: `i${seq}`, seq, dueDate: new Date(`${due}T00:00:00Z`), amountPaisa: amount });
// Total Rs 10,000: Rs 4,000 up front + 3 installments of Rs 2,000
const schedule = [inst(1, '2026-11-01', 200_000n), inst(2, '2026-12-01', 200_000n), inst(3, '2027-01-01', 200_000n)];
const total = 1_000_000n;

describe('installment status (Q7)', () => {
  it('payments cover the up-front part first, then installments in order', () => {
    const v = installmentViews({ totalPaisa: total, paidPaisa: 550_000n }, schedule, '2026-10-20');
    expect(v.map((x) => [x.paidPaisa, x.outstandingPaisa, x.state])).toEqual([
      [150_000n, 50_000n, 'PARTIAL'],
      [0n, 200_000n, 'UPCOMING'],
      [0n, 200_000n, 'UPCOMING'],
    ]);
  });

  it('marks due-today and overdue installments', () => {
    const v = installmentViews({ totalPaisa: total, paidPaisa: 400_000n }, schedule, '2026-12-01');
    expect(v.map((x) => x.state)).toEqual(['OVERDUE', 'DUE', 'UPCOMING']);
  });

  it('fully paid → all PAID', () => {
    expect(installmentViews({ totalPaisa: total, paidPaisa: total }, schedule, '2027-02-01').every((x) => x.state === 'PAID')).toBe(true);
  });

  it('balance is covered only once the up-front part is paid', () => {
    expect(balanceCovered({ totalPaisa: total, paidPaisa: 0n, balancePaisa: total }, schedule, '2026-10-20')).toBe(false);
    expect(balanceCovered({ totalPaisa: total, paidPaisa: 400_000n, balancePaisa: 600_000n }, schedule, '2026-10-20')).toBe(true);
    expect(balanceCovered({ totalPaisa: total, paidPaisa: total, balancePaisa: 0n }, [], '2026-10-20')).toBe(true);
    expect(balanceCovered({ totalPaisa: total, paidPaisa: 400_000n, balancePaisa: 600_000n }, [], '2026-10-20')).toBe(false);
  });
});
