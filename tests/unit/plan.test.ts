import { describe, expect, it } from 'vitest';
import { computePlanMoney, type PlanMoneyInput } from '../../src/modules/doctor/plan';
import { sum } from '../../src/lib/money';

const LIMITS = { maxItems: 6, maxInstallments: 6 };
const TODAY = '2026-10-19';
const base: PlanMoneyInput = {
  consultationFeePaisa: 200_000n,
  consultationFeeWaived: false,
  consultationDiscountPaisa: 0n,
  items: [],
  totalDiscountPaisa: 0n,
  advanceRequestedPaisa: 0n,
  installmentCount: 0,
};

describe('§25 #11 — plan money reconciles', () => {
  it('2 items: total / discount / advance / balance / installments reconcile exactly', () => {
    const m = computePlanMoney(
      {
        ...base,
        consultationDiscountPaisa: 50_000n,
        items: [
          { pricePaisa: 1_500_000n, discountPaisa: 100_000n },
          { pricePaisa: 1_200_000n, discountPaisa: 0n },
        ],
        totalDiscountPaisa: 33_333n,
        advanceRequestedPaisa: 500_000n,
        installmentCount: 6,
        firstInstallmentDate: '2026-11-19',
        installmentIntervalDays: 30,
      },
      LIMITS,
      TODAY,
    );
    expect(m.consultationNetPaisa).toBe(150_000n);
    expect(m.itemsSubtotalPaisa).toBe(2_700_000n);
    expect(m.itemsDiscountPaisa).toBe(100_000n);
    expect(m.grandTotalPaisa).toBe(150_000n + 2_700_000n - 100_000n - 33_333n); // 2,716,667
    expect(m.balancePaisa).toBe(m.grandTotalPaisa - 500_000n);
    expect(m.installments).toHaveLength(6);
    expect(sum(m.installments.map((x) => x.amountPaisa))).toBe(m.balancePaisa); // exact, no rounding loss
    expect(m.installments.map((x) => x.dueDate)).toEqual(['2026-11-19', '2026-12-19', '2027-01-18', '2027-02-17', '2027-03-19', '2027-04-18']);
  });

  it('waived consultation fee and full payment up front need no installments', () => {
    const m = computePlanMoney({ ...base, consultationFeeWaived: true, items: [{ pricePaisa: 600_000n, discountPaisa: 0n }], advanceRequestedPaisa: 600_000n }, LIMITS, TODAY);
    expect(m.consultationNetPaisa).toBe(0n);
    expect(m.balancePaisa).toBe(0n);
    expect(m.installments).toEqual([]);
  });

  it.each([
    [{ items: Array(7).fill({ pricePaisa: 1n, discountPaisa: 0n }) }, /6 treatment items/],
    [{ items: [{ pricePaisa: 100n, discountPaisa: 101n }] }, /discount price se zyada/],
    [{ consultationDiscountPaisa: 300_000n }, /Consultation discount/],
    [{ totalDiscountPaisa: 300_000n }, /Total discount/],
    [{ advanceRequestedPaisa: 300_000n }, /Advance/],
    [{ installmentCount: 0 }, /kam az kam 1 installment/],
    [{ installmentCount: 7 }, /6 installments/],
    [{ installmentCount: 2, firstInstallmentDate: '2026-10-01' }, /guzri hui/],
  ] as [Partial<PlanMoneyInput>, RegExp][])('rejects invalid input %#', (patch, msg) => {
    expect(() => computePlanMoney({ ...base, ...patch }, LIMITS, TODAY)).toThrow(msg);
  });
});
