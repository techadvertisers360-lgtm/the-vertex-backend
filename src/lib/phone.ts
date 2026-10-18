/**
 * Normalize phone numbers to digits with country code, no plus (Pakistan → `92XXXXXXXXXX`).
 * Accepts 03xx-xxxxxxx, +92 3xx…, 0092…, 3xx…, PK landlines, and other international numbers.
 * Returns null when the input cannot be a valid phone.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(d)) return null;
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (/^03\d{9}$/.test(d)) return '92' + d.slice(1);
  if (/^3\d{9}$/.test(d)) return '92' + d;
  if (/^923\d{9}$/.test(d)) return d;
  if (/^0[1-9]\d{8,9}$/.test(d)) return '92' + d.slice(1); // PK landline e.g. 042-XXXXXXXX
  if (/^92[1-9]\d{8,9}$/.test(d)) return d;
  if (/^[1-9]\d{7,14}$/.test(d) && !d.startsWith('92')) return d; // other international
  return null;
}

/** For search boxes: a normalized full number, or a normalized digit fragment (min 4 digits) for LIKE matching. */
export function phoneSearchFragment(input: string): string | null {
  const full = normalizePhone(input);
  if (full) return full;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 4) return null;
  if (digits.startsWith('0')) return '92' + digits.slice(1);
  return digits;
}

export function maskPhone(p: string): string {
  return p.length > 6 ? p.slice(0, 4) + '•••' + p.slice(-3) : '•••';
}
