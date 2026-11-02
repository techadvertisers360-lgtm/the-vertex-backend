import { moneyTx, prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { formatNumber, nextSequence } from '../../lib/misc';
import { clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr, local } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles } from '../../services/notifications';

/**
 * Owner money views from the client's demo (D-089): doctor share, procedure costs, payroll, profit and loss.
 * Everything is worked out on the server from bills, stock used, slips and expenses; nothing here is stored as a total.
 */

export function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start: clinicDayBounds(`${month}-01`).start, end: clinicDayBounds(next).start };
}

const pct = (amount: bigint, bp: number) => (amount * BigInt(bp) + 5_000n) / 10_000n;

/** What stock each procedure used, at the cost of the batch it came from. */
async function usageCostByAppointment(appointmentIds: string[]) {
  const tasks = await prisma.procedureTask.findMany({ where: { appointmentId: { in: appointmentIds } }, select: { id: true, appointmentId: true } });
  const used = await prisma.stockTransaction.findMany({ where: { procedureTaskId: { in: tasks.map((t) => t.id) }, type: 'USAGE' }, select: { procedureTaskId: true, quantity: true, unitCostPaisa: true, batchId: true, item: { select: { name: true, fallbackCostPaisa: true } } } });
  const batches = await prisma.stockBatch.findMany({ where: { id: { in: used.map((u) => u.batchId).filter((x): x is string => !!x) } }, select: { id: true, unitCostPaisa: true } });
  const out = new Map<string, { costPaisa: bigint; items: string[] }>();
  for (const u of used) {
    const appointmentId = tasks.find((t) => t.id === u.procedureTaskId)?.appointmentId;
    if (!appointmentId) continue;
    const unit = u.unitCostPaisa ?? batches.find((b) => b.id === u.batchId)?.unitCostPaisa ?? u.item.fallbackCostPaisa ?? 0n;
    const row = out.get(appointmentId) ?? { costPaisa: 0n, items: [] };
    row.costPaisa += unit * BigInt(-u.quantity);
    row.items.push(`${u.item.name} × ${-u.quantity}`);
    out.set(appointmentId, row);
  }
  return out;
}

// ───────────── Doctor share ─────────────

export async function setShareRule(actor: Actor, doctorId: string, input: { ownConsultBp: number; ownProcedureBp: number; clinicConsultBp: number; clinicProcedureBp: number; fixedCostPaisa: number }) {
  const doctor = await prisma.user.findFirst({ where: { id: doctorId, role: 'DOCTOR' }, select: { id: true } });
  if (!doctor) throw new NotFoundError('Doctor');
  return prisma.$transaction(async (tx) => {
    const before = await tx.doctorShareRule.findUnique({ where: { doctorId } });
    const data = { ...input, fixedCostPaisa: BigInt(input.fixedCostPaisa), updatedById: actor.id! };
    const after = await tx.doctorShareRule.upsert({ where: { doctorId }, update: data, create: { doctorId, ...data } });
    await audit(tx, actor, { action: 'DOCTOR_SHARE_RULE_SET', recordType: 'DoctorShareRule', recordId: doctorId, before, after });
    return after;
  });
}

export async function setOwnPatient(actor: Actor, doctorId: string, patientId: string, own: boolean) {
  return prisma.$transaction(async (tx) => {
    if (own) await tx.doctorOwnPatient.upsert({ where: { doctorId_patientId: { doctorId, patientId } }, update: {}, create: { doctorId, patientId, createdById: actor.id! } });
    else await tx.doctorOwnPatient.deleteMany({ where: { doctorId, patientId } });
    await audit(tx, actor, { action: 'DOCTOR_OWN_PATIENT_SET', recordType: 'Patient', recordId: patientId, after: { doctorId, own } });
    return { doctorId, patientId, own };
  });
}

/** One doctor's billed visits in a month and the share of each. `withCost` is false for the Doctor: spec §4 lock 7. */
async function doctorRows(doctorId: string, start: Date, end: Date) {
  const visits = await prisma.appointment.findMany({ where: { doctorId, startAt: { gte: new Date(start.getTime() - 400 * 86_400_000) } }, select: { id: true, type: true } });
  const invoices = await prisma.invoice.findMany({
    where: { status: { not: 'VOID' }, kind: { not: 'COUNTER' }, createdAt: { gte: start, lt: end }, OR: [{ doctorId }, { appointmentId: { in: visits.map((v) => v.id) } }] },
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true, totalPaisa: true, createdAt: true, patientId: true, appointmentId: true, patient: { select: { name: true } } },
  });
  const [rule, own, costs] = await Promise.all([
    prisma.doctorShareRule.findUnique({ where: { doctorId } }),
    prisma.doctorOwnPatient.findMany({ where: { doctorId }, select: { patientId: true } }),
    usageCostByAppointment(invoices.map((i) => i.appointmentId).filter((x): x is string => !!x)),
  ]);
  return invoices.map((i) => {
    const isOwn = own.some((o) => o.patientId === i.patientId);
    const procedure = visits.find((v) => v.id === i.appointmentId)?.type === 'PROCEDURE';
    const bp = procedure ? (isOwn ? rule?.ownProcedureBp : rule?.clinicProcedureBp) : isOwn ? rule?.ownConsultBp : rule?.clinicConsultBp;
    const cost = procedure && i.appointmentId ? (costs.get(i.appointmentId)?.costPaisa ?? 0n) : 0n;
    const fixed = procedure ? (rule?.fixedCostPaisa ?? 0n) : 0n;
    const base = i.totalPaisa - cost - fixed;
    return { invoiceId: i.id, patientId: i.patientId, number: i.number, date: i.createdAt, patient: i.patient?.name ?? null, own: isOwn, type: procedure ? 'Procedure' : 'Consultation', billPaisa: i.totalPaisa, itemCostPaisa: cost, fixedCostPaisa: fixed, bp: bp ?? 0, sharePaisa: base > 0n ? pct(base, bp ?? 0) : 0n };
  });
}

export async function doctorLedger(month: string, doctorId?: string) {
  const { start, end } = monthBounds(month);
  const doctors = await prisma.user.findMany({ where: { role: 'DOCTOR', active: true, ...(doctorId ? { id: doctorId } : {}) }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } });
  const rules = await prisma.doctorShareRule.findMany({ where: { doctorId: { in: doctors.map((d) => d.id) } } });
  const out = [];
  for (const d of doctors) {
    const rows = await doctorRows(d.id, start, end);
    const earned = await allTimeEarned(d.id);
    const paid = await prisma.doctorPayout.aggregate({ where: { doctorId: d.id }, _sum: { amountPaisa: true } });
    const payouts = await prisma.doctorPayout.findMany({ where: { doctorId: d.id }, orderBy: { paidAt: 'desc' }, take: 20 });
    out.push({ doctorId: d.id, name: d.displayName, rule: rules.find((r) => r.doctorId === d.id) ?? null, rows, monthSharePaisa: rows.reduce((s, r) => s + r.sharePaisa, 0n), earnedPaisa: earned, paidPaisa: paid._sum.amountPaisa ?? 0n, balancePaisa: earned - (paid._sum.amountPaisa ?? 0n), payouts });
  }
  return { month, doctors: out };
}

/** The Manager's view: bills, percentages and shares, without item cost, extra cost or the percentages' setup (client demo). */
export async function doctorLedgerForManager(month: string) {
  const { doctors } = await doctorLedger(month);
  return {
    month,
    doctors: doctors.map((d) => ({
      doctorId: d.doctorId,
      name: d.name,
      monthSharePaisa: d.monthSharePaisa,
      earnedPaisa: d.earnedPaisa,
      paidPaisa: d.paidPaisa,
      balancePaisa: d.balancePaisa,
      rows: d.rows.map(({ invoiceId, patient, own, type, billPaisa, bp, sharePaisa }) => ({ invoiceId, patient, own, type, billPaisa, bp, sharePaisa })),
    })),
  };
}

async function allTimeEarned(doctorId: string) {
  const rows = await doctorRows(doctorId, new Date(0), new Date('2999-01-01'));
  return rows.reduce((s, r) => s + r.sharePaisa, 0n);
}

/** The Doctor's own view: the bill, the percentage and the share. Never item cost or extra cost (spec §4 lock 7). */
export async function myShare(actor: Actor, month: string) {
  const { start, end } = monthBounds(month);
  const rows = await doctorRows(actor.id!, start, end);
  const earned = await allTimeEarned(actor.id!);
  const paid = await prisma.doctorPayout.aggregate({ where: { doctorId: actor.id! }, _sum: { amountPaisa: true } });
  return {
    month,
    rows: rows.map(({ invoiceId, number, date, patient, own, type, billPaisa, bp, sharePaisa }) => ({ invoiceId, number, date, patient, own, type, billPaisa, bp, sharePaisa })),
    monthSharePaisa: rows.reduce((s, r) => s + r.sharePaisa, 0n),
    earnedPaisa: earned,
    paidPaisa: paid._sum.amountPaisa ?? 0n,
    balancePaisa: earned - (paid._sum.amountPaisa ?? 0n),
  };
}

export async function payDoctor(actor: Actor, doctorId: string, input: { amountPaisa: number; method: string; reference?: string; note?: string }) {
  const doctor = await prisma.user.findFirst({ where: { id: doctorId, role: 'DOCTOR' }, select: { id: true, displayName: true } });
  if (!doctor) throw new NotFoundError('Doctor');
  return prisma.$transaction(async (tx) => {
    const p = await tx.doctorPayout.create({ data: { doctorId, amountPaisa: BigInt(input.amountPaisa), method: input.method, reference: input.reference?.trim() || null, note: input.note?.trim() || null, paidById: actor.id! } });
    await audit(tx, actor, { action: 'DOCTOR_PAID', recordType: 'DoctorPayout', recordId: p.id, after: { doctor: doctor.displayName, amount: p.amountPaisa, method: p.method } });
    return p;
  });
}

// ───────────── Procedure costs ─────────────

export async function procedureCosts(month: string) {
  const { start, end } = monthBounds(month);
  const invoices = await prisma.invoice.findMany({
    where: { status: { not: 'VOID' }, appointmentId: { not: null }, createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: 'desc' },
    select: { number: true, totalPaisa: true, appointmentId: true, patient: { select: { name: true } }, createdAt: true },
  });
  const costs = await usageCostByAppointment(invoices.map((i) => i.appointmentId!));
  const rows = invoices.filter((i) => costs.has(i.appointmentId!)).map((i) => {
    const c = costs.get(i.appointmentId!)!;
    return { number: i.number, date: i.createdAt, patient: i.patient?.name ?? null, items: c.items, costPaisa: c.costPaisa, billedPaisa: i.totalPaisa, leftPaisa: i.totalPaisa - c.costPaisa };
  });
  return { month, costPaisa: rows.reduce((s, r) => s + r.costPaisa, 0n), billedPaisa: rows.reduce((s, r) => s + r.billedPaisa, 0n), rows };
}

// ───────────── Payroll ─────────────

const PAYROLL_ROLES = ['LEAD_MEMBER', 'RECEPTIONIST', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MARKETING_LEAD'] as const;

export async function staffList(month: string) {
  const users = await prisma.user.findMany({ where: { active: true, isDemo: false, role: { in: [...PAYROLL_ROLES] } }, select: { id: true, displayName: true, role: true, phone: true, email: true }, orderBy: { displayName: 'asc' } });
  const ids = users.map((u) => u.id);
  const [profiles, marks, advances, slips] = await Promise.all([
    prisma.staffProfile.findMany({ where: { userId: { in: ids } } }),
    prisma.staffMark.findMany({ where: { userId: { in: ids }, month }, orderBy: { createdAt: 'desc' } }),
    prisma.salaryAdvance.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _sum: { amountPaisa: true } }),
    prisma.salarySlip.findMany({ where: { userId: { in: ids }, month } }),
  ]);
  return {
    month,
    items: users.map((u) => {
      const p = profiles.find((x) => x.userId === u.id);
      const mine = marks.filter((m) => m.userId === u.id);
      const absences = mine.filter((m) => m.kind === 'ABSENCE').length;
      const salary = p?.salaryPaisa ?? 0n;
      const days = BigInt(p?.workingDays || 24);
      const balance = advances.find((a) => a.userId === u.id)?._sum.amountPaisa ?? 0n;
      return {
        ...u,
        salaryPaisa: salary,
        workingDays: p?.workingDays ?? 24,
        startDate: p?.startDate ? dateOnlyStr(p.startDate) : null,
        emergencyContact: p?.emergencyContact ?? null,
        personalEmail: p?.personalEmail ?? null,
        absences,
        lates: mine.filter((m) => m.kind === 'LATE').length,
        uniformNotes: mine.filter((m) => m.kind === 'UNIFORM').length,
        warnings: mine.filter((m) => m.kind === 'WARNING').length,
        points: mine.filter((m) => m.kind === 'POINTS').reduce((s, m) => s + (m.points ?? 0), 0),
        absenceDeductionPaisa: (salary * BigInt(absences) + days / 2n) / days,
        advanceBalancePaisa: balance,
        slip: slips.find((s) => s.userId === u.id) ?? null,
      };
    }),
  };
}

export async function saveStaffProfile(actor: Actor, userId: string, input: { salaryPaisa?: number; workingDays?: number; startDate?: string | null; emergencyContact?: string | null; personalEmail?: string | null }) {
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw new NotFoundError('Staff');
  return prisma.$transaction(async (tx) => {
    const before = await tx.staffProfile.findUnique({ where: { userId } });
    const data = {
      ...(input.salaryPaisa !== undefined ? { salaryPaisa: BigInt(input.salaryPaisa) } : {}),
      ...(input.workingDays !== undefined ? { workingDays: input.workingDays } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate ? dateOnly(input.startDate) : null } : {}),
      ...(input.emergencyContact !== undefined ? { emergencyContact: input.emergencyContact?.trim() || null } : {}),
      ...(input.personalEmail !== undefined ? { personalEmail: input.personalEmail?.trim() || null } : {}),
      updatedById: actor.id!,
    };
    const after = await tx.staffProfile.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    await audit(tx, actor, { action: 'STAFF_PROFILE_SAVED', recordType: 'StaffProfile', recordId: userId, before, after });
    return after;
  });
}

export async function addStaffMark(actor: Actor, userId: string, input: { month: string; kind: 'ABSENCE' | 'LATE' | 'UNIFORM' | 'WARNING' | 'POINTS'; points?: number; note?: string }) {
  return prisma.$transaction(async (tx) => {
    const m = await tx.staffMark.create({ data: { userId, month: input.month, kind: input.kind, points: input.kind === 'POINTS' ? (input.points ?? null) : null, note: input.note?.trim() || null, createdById: actor.id! } });
    await audit(tx, actor, { action: 'STAFF_MARK_ADDED', recordType: 'StaffMark', recordId: m.id, after: { userId, month: m.month, kind: m.kind, note: m.note } });
    return m;
  });
}

export async function giveAdvance(actor: Actor, userId: string, input: { amountPaisa: number; note?: string }) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.salaryAdvance.create({ data: { userId, amountPaisa: BigInt(input.amountPaisa), note: input.note?.trim() || null, actorId: actor.id! } });
    await audit(tx, actor, { action: 'SALARY_ADVANCE_GIVEN', recordType: 'SalaryAdvance', recordId: a.id, after: { userId, amount: a.amountPaisa } });
    return a;
  });
}

export async function paySalary(actor: Actor, userId: string, input: { month: string; advanceCutPaisa: number; bonusPaisa?: number }) {
  return moneyTx(async (tx) => {
    if (await tx.salarySlip.findUnique({ where: { userId_month: { userId, month: input.month } }, select: { id: true } })) throw new ConflictError('ALREADY_PAID', 'Is mahine ki salary ban chuki hai.');
    const p = await tx.staffProfile.findUnique({ where: { userId } });
    if (!p || p.salaryPaisa <= 0n) throw new ValidationError('Pehle salary likhein.');
    const absences = await tx.staffMark.count({ where: { userId, month: input.month, kind: 'ABSENCE' } });
    const days = BigInt(p.workingDays || 24);
    const deduction = (p.salaryPaisa * BigInt(absences) + days / 2n) / days;
    const bal = await tx.salaryAdvance.aggregate({ where: { userId }, _sum: { amountPaisa: true } });
    const cut = BigInt(input.advanceCutPaisa);
    if (cut > (bal._sum.amountPaisa ?? 0n)) throw new ValidationError('Katoti advance ke balance se zyada nahi ho sakti.');
    const bonus = BigInt(input.bonusPaisa ?? 0);
    const net = p.salaryPaisa - deduction - cut + bonus;
    if (net < 0n) throw new ValidationError('Katoti salary se zyada hai.');
    const year = local(new Date()).year;
    const slip = await tx.salarySlip.create({ data: { number: formatNumber('VH-SAL', year, await nextSequence(tx, `salary:${year}`)), userId, month: input.month, salaryPaisa: p.salaryPaisa, extraAbsences: absences, absenceDeductionPaisa: deduction, advanceCutPaisa: cut, bonusPaisa: bonus, netPaisa: net, paidById: actor.id! } });
    if (cut > 0n) await tx.salaryAdvance.create({ data: { userId, amountPaisa: -cut, note: `Katoti ${input.month}`, slipId: slip.id, actorId: actor.id! } });
    await audit(tx, actor, { action: 'SALARY_PAID', recordType: 'SalarySlip', recordId: slip.id, after: { userId, month: input.month, net, deduction, cut, bonus } });
    return slip;
  });
}

// ───────────── Profit and loss ─────────────

export async function profitAndLoss(month: string) {
  const { start, end } = monthBounds(month);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const dayEnd = dateOnly(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`);
  const [billed, packages, received, balance, slips, expenses, stockRows, doctors] = await Promise.all([
    prisma.invoice.aggregate({ where: { status: { not: 'VOID' }, createdAt: { gte: start, lt: end } }, _sum: { totalPaisa: true }, _count: { _all: true } }),
    prisma.packageSale.aggregate({ where: { createdAt: { gte: start, lt: end } }, _sum: { pricePaisa: true } }),
    prisma.payment.aggregate({ where: { method: { not: 'ADVANCE' }, receivedAt: { gte: start, lt: end } }, _sum: { amountPaisa: true } }),
    prisma.invoice.aggregate({ where: { status: { not: 'VOID' }, createdAt: { gte: start, lt: end } }, _sum: { balancePaisa: true } }),
    prisma.salarySlip.aggregate({ where: { month }, _sum: { netPaisa: true } }),
    prisma.expense.findMany({ where: { date: { gte: dateOnly(`${month}-01`), lt: dayEnd } }, orderBy: { date: 'desc' } }),
    prisma.stockTransaction.findMany({ where: { type: { in: ['USAGE', 'SALE'] }, createdAt: { gte: start, lt: end } }, select: { type: true, quantity: true, unitCostPaisa: true, batchId: true, item: { select: { fallbackCostPaisa: true } } } }),
    prisma.user.findMany({ where: { role: 'DOCTOR' }, select: { id: true } }),
  ]);
  const batches = await prisma.stockBatch.findMany({ where: { id: { in: stockRows.map((s) => s.batchId).filter((x): x is string => !!x) } }, select: { id: true, unitCostPaisa: true } });
  const cost = (type: 'USAGE' | 'SALE') => stockRows.filter((s) => s.type === type).reduce((sum, s) => sum + (s.unitCostPaisa ?? batches.find((b) => b.id === s.batchId)?.unitCostPaisa ?? s.item.fallbackCostPaisa ?? 0n) * BigInt(-s.quantity), 0n);
  let doctorShare = 0n;
  for (const d of doctors) for (const r of await doctorRows(d.id, start, end)) doctorShare += r.sharePaisa;
  const expenseTotal = expenses.reduce((s, e) => s + e.amountPaisa, 0n);
  const procedureStock = cost('USAGE');
  const pharmacyStock = cost('SALE');
  const salaries = slips._sum.netPaisa ?? 0n;
  const billedTotal = billed._sum.totalPaisa ?? 0n;
  const totalCosts = doctorShare + procedureStock + pharmacyStock + salaries + expenseTotal;
  const profit = billedTotal - totalCosts;
  return {
    month,
    invoices: billed._count._all,
    billedPaisa: billedTotal,
    packagesPaisa: packages._sum.pricePaisa ?? 0n,
    receivedPaisa: received._sum.amountPaisa ?? 0n,
    toReceivePaisa: balance._sum.balancePaisa ?? 0n,
    doctorSharePaisa: doctorShare,
    procedureStockPaisa: procedureStock,
    pharmacyStockPaisa: pharmacyStock,
    salariesPaisa: salaries,
    expensesPaisa: expenseTotal,
    totalCostsPaisa: totalCosts,
    profitPaisa: profit,
    marginBp: billedTotal > 0n ? Number((profit * 10_000n) / billedTotal) : 0,
    expenses: expenses.map((e) => ({ ...e, date: dateOnlyStr(e.date) })),
  };
}

/** First day of the month: tell MD and Hamza how last month ended (client demo, D-090). The dedupe key sends it once. */
export async function runMonthEndNotice(now: Date): Promise<number> {
  const today = clinicDateStr(now);
  if (!today.endsWith('-01')) return 0;
  const [y, m] = today.split('-').map(Number) as [number, number];
  const month = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const owners = await prisma.user.count({ where: { role: { in: ['MD', 'MARKETING_DIRECTOR'] }, active: true } });
  if (!owners) return 0;
  const already = await prisma.notification.count({ where: { dedupeKey: { startsWith: `month-end:${month}:` } } });
  if (already) return 0;
  const r = await profitAndLoss(month);
  const profit = r.profitPaisa >= 0n;
  const amount = (r.profitPaisa < 0n ? -r.profitPaisa : r.profitPaisa) / 100n;
  await notifyRoles(prisma, ['MD', 'MARKETING_DIRECTOR'], { type: 'MONTH_END_RESULT', subject: `${month}: ${profit ? 'PROFIT' : 'LOSS'} of Rs ${amount.toLocaleString('en-PK')}`, recordType: 'Report', recordId: month, dedupeKey: `month-end:${month}` });
  return 1;
}
