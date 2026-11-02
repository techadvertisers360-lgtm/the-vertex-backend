/**
 * Methods money can actually arrive or leave by. `ADVANCE` is deliberately absent: it marks a payment settled from a
 * patient's advance balance, is set only by the server, and must never be accepted from a client.
 */
export const MONEY_METHODS = ['CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE'] as const;
export type MoneyMethod = (typeof MONEY_METHODS)[number];
