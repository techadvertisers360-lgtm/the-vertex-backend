import { addDaysStr } from '../../lib/time';
import { splitInstallments, type Paisa } from '../../lib/money';
import { ValidationError } from '../../lib/errors';

/**
 * Treatment-plan charges (spec §10): computed on the server only, in integer paisa.
 *   consultation net = fee − consultation discount (0 when waived)
 *   items net        = Σ price − Σ item discounts
 *   grand total      = consultation net + items net − total (plan-level) discount
 *   balance          = grand total − advance requested; split into installments that sum exactly to it.
 * Each installment has its own due date (first due date + i × interval days).
 */
export interface PlanMoneyInput {
  consultationFeePaisa: Paisa;
  consultationFeeWaived: boolean;
  consultationDiscountPaisa: Paisa;
  items: { pricePaisa: Paisa; discountPaisa: Paisa }[];
  totalDiscountPaisa: Paisa;
  advanceRequestedPaisa: Paisa;
  installmentCount: number;
  firstInstallmentDate?: string; // clinic date
  installmentIntervalDays?: number;
}

export interface PlanMoney {
  consultationNetPaisa: Paisa;
  itemsSubtotalPaisa: Paisa;
  itemsDiscountPaisa: Paisa;
  totalDiscountPaisa: Paisa;
  grandTotalPaisa: Paisa;
  advanceRequestedPaisa: Paisa;
  balancePaisa: Paisa;
  installments: { seq: number; dueDate: string; amountPaisa: Paisa }[];
}

const neg = (v: Paisa) => v < 0n;

export function computePlanMoney(i: PlanMoneyInput, limits: { maxItems: number; maxInstallments: number }, today: string): PlanMoney {
  if (i.items.length > limits.maxItems) throw new ValidationError(`Zyada se zyada ${limits.maxItems} treatment items.`);
  for (const v of [i.consultationFeePaisa, i.consultationDiscountPaisa, i.totalDiscountPaisa, i.advanceRequestedPaisa]) {
    if (neg(v)) throw new ValidationError('Amounts negative nahi ho sakte.');
  }
  if (!i.consultationFeeWaived && i.consultationDiscountPaisa > i.consultationFeePaisa) throw new ValidationError('Consultation discount fee se zyada nahi ho sakta.');
  i.items.forEach((it, idx) => {
    if (neg(it.pricePaisa) || neg(it.discountPaisa)) throw new ValidationError(`Item ${idx + 1}: amounts negative nahi ho sakte.`);
    if (it.discountPaisa > it.pricePaisa) throw new ValidationError(`Item ${idx + 1}: discount price se zyada nahi ho sakta.`);
  });

  const consultationNetPaisa = i.consultationFeeWaived ? 0n : i.consultationFeePaisa - i.consultationDiscountPaisa;
  const itemsSubtotalPaisa = i.items.reduce((s, it) => s + it.pricePaisa, 0n);
  const itemsDiscountPaisa = i.items.reduce((s, it) => s + it.discountPaisa, 0n);
  const beforeTotalDiscount = consultationNetPaisa + itemsSubtotalPaisa - itemsDiscountPaisa;
  if (i.totalDiscountPaisa > beforeTotalDiscount) throw new ValidationError('Total discount kul raqam se zyada nahi ho sakta.');
  const grandTotalPaisa = beforeTotalDiscount - i.totalDiscountPaisa;
  if (i.advanceRequestedPaisa > grandTotalPaisa) throw new ValidationError('Advance kul raqam se zyada nahi ho sakta.');
  const balancePaisa = grandTotalPaisa - i.advanceRequestedPaisa;

  let installments: PlanMoney['installments'] = [];
  if (balancePaisa > 0n) {
    if (!Number.isInteger(i.installmentCount) || i.installmentCount < 1) throw new ValidationError('Baqi balance ke liye kam az kam 1 installment chahiye.');
    if (i.installmentCount > limits.maxInstallments) throw new ValidationError(`Zyada se zyada ${limits.maxInstallments} installments.`);
    const first = i.firstInstallmentDate ?? addDaysStr(today, 30);
    if (first < today) throw new ValidationError('Pehli installment ki date guzri hui nahi ho sakti.');
    const interval = i.installmentIntervalDays ?? 30;
    if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new ValidationError('Installment interval 1–365 din.');
    installments = splitInstallments(balancePaisa, i.installmentCount).map((amountPaisa, k) => ({ seq: k + 1, dueDate: addDaysStr(first, k * interval), amountPaisa }));
  }

  return { consultationNetPaisa, itemsSubtotalPaisa, itemsDiscountPaisa, totalDiscountPaisa: i.totalDiscountPaisa, grandTotalPaisa, advanceRequestedPaisa: i.advanceRequestedPaisa, balancePaisa, installments };
}
