/** Money is integer paisa held as bigint (1 Rs = 100 paisa). No floats anywhere in money math. */
export type Paisa = bigint;

export const PAISA_PER_RUPEE = 100n;

export function rupees(r: number | bigint): Paisa {
  if (typeof r === 'number') {
    if (!Number.isSafeInteger(r)) throw new Error('rupees() requires whole rupees');
    return BigInt(r) * PAISA_PER_RUPEE;
  }
  return r * PAISA_PER_RUPEE;
}

/** Parse "1234.50" / "1,234" into paisa without floating point. */
export function fromRupeeString(s: string): Paisa {
  const clean = s.replace(/,/g, '').trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) throw new Error(`Invalid amount: ${s}`);
  const whole = BigInt(m[2]!);
  const frac = BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  const v = whole * PAISA_PER_RUPEE + frac;
  return m[1] ? -v : v;
}

export function formatRs(p: Paisa): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = (abs / PAISA_PER_RUPEE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = abs % PAISA_PER_RUPEE;
  return `${neg ? '-' : ''}Rs ${whole}${frac ? '.' + frac.toString().padStart(2, '0') : ''}`;
}

export function sum(values: Iterable<Paisa>): Paisa {
  let t = 0n;
  for (const v of values) t += v;
  return t;
}

export function max0(p: Paisa): Paisa {
  return p < 0n ? 0n : p;
}

/**
 * Split `total` into `count` installments that sum exactly to `total`:
 * equal whole-rupee parts, remainder (incl. paisa) on the last installment.
 */
export function splitInstallments(total: Paisa, count: number): Paisa[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('installment count must be >= 1');
  if (total < 0n) throw new Error('total must be >= 0');
  const n = BigInt(count);
  const base = (total / PAISA_PER_RUPEE / n) * PAISA_PER_RUPEE;
  const parts: Paisa[] = Array.from({ length: count }, () => base);
  parts[count - 1] = total - base * (n - 1n);
  return parts;
}

/** Money from API input: integer paisa as number or numeric string. */
export function toPaisa(v: number | string | bigint): Paisa {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('paisa must be a safe integer');
    return BigInt(v);
  }
  if (!/^-?\d+$/.test(v)) throw new Error('paisa must be an integer');
  return BigInt(v);
}
