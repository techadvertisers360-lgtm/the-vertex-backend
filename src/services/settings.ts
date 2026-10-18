import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { ValidationError } from '../lib/errors';
import { audit, type Actor } from './audit';

/**
 * Admin-editable configuration. Items from spec §26 are seeded with `placeholder: true` defaults and
 * listed in docs/CONFIG_TO_CONFIRM.md. Values fixed by the spec itself are seeded `placeholder: false`.
 */
const minutes = z.number().int().min(0).max(24 * 60);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const roleList = z.array(z.string());

export const SETTING_DEFS = {
  'clinic.timezone': { schema: z.literal('Asia/Karachi'), default: 'Asia/Karachi', placeholder: false, description: 'Clinic timezone (spec §19). Fixed.' },
  'scheduling.consultDurationMin': { schema: minutes.min(5), default: 20, placeholder: true, description: 'Default consultation duration (minutes) when the service has none. §26 #1' },
  'scheduling.procedureDurationMin': { schema: minutes.min(5), default: 60, placeholder: true, description: 'Default procedure duration (minutes) when the service has none. §26 #1' },
  'scheduling.consultBufferMin': { schema: minutes, default: 10, placeholder: false, description: 'Suggest next slot this many minutes after a conflicting consultation ends (spec §6).' },
  'scheduling.procedureBufferMin': { schema: minutes, default: 20, placeholder: false, description: 'Suggest next consult slot this many minutes after a conflicting procedure ends (spec §6).' },
  'scheduling.slotStepMin': { schema: minutes.min(5), default: 10, placeholder: true, description: 'Booking slot grid (minutes).' },
  'scheduling.searchHorizonDays': { schema: z.number().int().min(1).max(90), default: 14, placeholder: true, description: 'How many days ahead the engine searches for suggestions.' },
  'accounts.creatorRoles': { schema: roleList, default: ['MD', 'MANAGER'], placeholder: true, description: 'Roles allowed to create/disable staff & Doctor accounts. §26 #3 (Lead members: Hamza/Usama only — fixed).' },
  'rooms.maxPerAssistant': { schema: z.number().int().min(1).max(6), default: 4, placeholder: false, description: 'Max rooms assigned to one Assistant (spec §6 current rule).' },
  'whatsapp.provider': { schema: z.string(), default: 'console', placeholder: true, description: 'WhatsApp Business provider id. §26 #4' },
  'whatsapp.senderNumber': { schema: z.string(), default: '', placeholder: true, description: 'Clinic WhatsApp sender number. §26 #4' },
  'whatsapp.templates': { schema: z.record(z.string()), default: {}, placeholder: true, description: 'Internal template → approved provider template name mapping. §26 #4' },
  'meta.syncMethod': { schema: z.enum(['manual', 'csv', 'api', 'google_sheets']), default: 'google_sheets', placeholder: false, description: 'Meta lead sheet integration method. §26 #5 — client chose Google Sheets sync (2026-10-18, D-039); "manual" pauses the scheduled sync.' },
  'meta.syncIntervalMin': { schema: z.number().int().min(1).max(24 * 60), default: 3, placeholder: false, description: 'Minutes between scheduled Google Sheets syncs per assigned sheet (client 2026-10-18, D-039).' },
  'meta.syncFailureAlertAfter': { schema: z.number().int().min(1).max(50), default: 3, placeholder: false, description: 'Alert Hamza Zafar and Muaz Tahir after this many failed syncs in a row on one sheet (client 2026-10-18, D-039).' },
  'stock.allowNegative': { schema: z.boolean(), default: false, placeholder: true, description: 'Allow usage below zero stock. §26 #7' },
  'stock.nearExpiryUsable': { schema: z.boolean(), default: true, placeholder: true, description: 'Near-expiry (within alert window) batches count as usable. §26 #7' },
  'stock.expiryAlertMonths': { schema: z.number().int().min(1).max(12), default: 2, placeholder: false, description: 'Expiry alert lead time (spec §18: two months).' },
  'stock.managerApprovalLimitPaisa': { schema: z.number().int().positive(), default: 2_000_000, placeholder: false, description: 'Manager demand approval limit, inclusive (spec: Rs 20,000).' },
  'invoice.numberPrefix': { schema: z.string().min(1).max(10), default: 'VH-INV', placeholder: true, description: 'Invoice number prefix. §26 #8' },
  'invoice.taxBasisPoints': { schema: z.number().int().min(0).max(10000), default: 0, placeholder: true, description: 'Tax rate in basis points (0 = no tax). §26 #8' },
  'notify.quietHoursStart': { schema: hhmm.nullable(), default: null, placeholder: true, description: 'Patient message quiet hours start (null = none). §26 #9' },
  'notify.quietHoursEnd': { schema: hhmm.nullable(), default: null, placeholder: true, description: 'Patient message quiet hours end. §26 #9' },
  'notify.maxRetries': { schema: z.number().int().min(0).max(20), default: 5, placeholder: true, description: 'Message send retries before terminal failure. §26 #9' },
  'notify.retryBaseSec': { schema: z.number().int().min(5), default: 60, placeholder: true, description: 'Exponential backoff base (seconds). §26 #9' },
  'notify.terminalFailureRoles': { schema: roleList, default: ['MANAGER'], placeholder: true, description: 'Who is alerted on terminal message failure. §26 #9' },
  'feedback.fields': { schema: z.array(z.string()), default: ['doctorRating', 'staffRating', 'clinicRating', 'suggestion'], placeholder: true, description: 'Feedback form fields (1–5 stars). §26 #10' },
  'complaint.slaHours': { schema: z.number().int().min(1), default: 24, placeholder: true, description: 'Complaint response target (hours). §26 #10' },
  'officeBoy.roundIntervalMin': { schema: minutes.min(15), default: 120, placeholder: false, description: 'Office Boy round interval (spec §13: 2 hours).' },
  'officeBoy.roundAnchor': { schema: z.enum(['checkin', 'shiftStart']), default: 'checkin', placeholder: true, description: 'First-round anchor. §26 #11' },
  'officeBoy.shiftStart': { schema: hhmm, default: '10:00', placeholder: true, description: 'Office Boy shift start when anchor = shiftStart. §26 #11' },
  'officeBoy.areas': {
    schema: z.array(z.string().trim().min(1).max(80)).min(1).max(40),
    default: ['Entrance/Stairs', 'Reception & Waiting', 'Washroom (Male)', 'Washroom (Female)', 'C01', 'C02', 'C03', 'P01', 'P02', 'P03', 'Corridor', 'Store Room', 'Pantry/Kitchen', 'Staff Room'],
    placeholder: false,
    description: 'Clinic areas on every Office Boy round; the Manager edits this list (client confirmed 2026-10-18).',
  },
  'officeBoy.photoRequiredOnIssue': { schema: z.boolean(), default: true, placeholder: false, description: 'A photo is required when an Office Boy round reports a problem (client confirmed 2026-10-18).' },
  'officeBoy.finalReportTime': { schema: hhmm, default: '21:40', placeholder: false, description: 'Final report time (spec §13: 9:40 PM).' },
  'retention.policy': { schema: z.string(), default: 'retain_all', placeholder: true, description: 'Clinical record/photo retention policy. §26 #12' },
  'sla.consentMinutes': { schema: minutes.min(1), default: 8, placeholder: false, description: 'Consent missing alert after assignment (spec §12).' },
  'procedure.autoSendToReceptionMinutes': { schema: minutes.min(1).max(30), default: 2, placeholder: false, description: 'Auto-send the patient to Reception this many minutes after items used if the Assistant has not pressed Send to Reception (client decision 2026-10-18, D-034).' },
  'sla.roomCleanMinutes': { schema: minutes.min(1), default: 7, placeholder: false, description: 'Room-clean overdue alert after procedure end (spec §12).' },
  'procedure.reminderDaysBefore': { schema: z.number().int().min(1).max(14), default: 2, placeholder: false, description: 'Procedure reminder lead time (spec §19).' },
  'procedure.taskReleaseTime': { schema: hhmm, default: '08:00', placeholder: true, description: 'Clinic-local time procedure-day Assistant tasks are released.' },
  'plan.maxItems': { schema: z.number().int().min(1).max(12), default: 6, placeholder: false, description: 'Max treatment items per plan (spec §10: 1–6).' },
  'plan.maxInstallments': { schema: z.number().int().min(1).max(12), default: 6, placeholder: true, description: 'Max installments (spec says 5–6; confirm).' },
  'callbacks.twoHourMin': { schema: minutes.min(1), default: 120, placeholder: false, description: 'Quick follow-up option: 2 hours (spec §7).' },
  'callbacks.onTimeGraceMin': { schema: minutes, default: 30, placeholder: true, description: 'A callback completed within this many minutes after its due time counts as on time (follow-up compliance, spec §8).' },
  'installments.reminderDaysBefore': { schema: z.number().int().min(0).max(30), default: 2, placeholder: true, description: 'Patient installment reminder lead time in days (also reminded on the due date). Q7.' },
  'history.accessHours': { schema: z.number().int().min(1), default: 24, placeholder: true, description: 'How long an approved other-Doctor history access stays valid.' },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFS)[K]['schema']>;

const cache = new Map<string, { v: unknown; at: number }>();
const TTL_MS = 15_000;

export function clearSettingsCache(): void {
  cache.clear();
}

export async function getSetting<K extends SettingKey>(key: K, db: Db = prisma): Promise<SettingValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as SettingValue<K>;
  const def = SETTING_DEFS[key];
  const row = await db.setting.findUnique({ where: { key } });
  const parsed = def.schema.safeParse(row?.value ?? def.default);
  const v = (parsed.success ? parsed.data : def.default) as SettingValue<K>;
  cache.set(key, { v, at: Date.now() });
  return v;
}

export async function listSettings() {
  const rows = await prisma.setting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return (Object.keys(SETTING_DEFS) as SettingKey[]).map((key) => {
    const def = SETTING_DEFS[key];
    const row = byKey.get(key);
    return {
      key,
      value: row?.value ?? def.default,
      isPlaceholder: row?.isPlaceholder ?? def.placeholder,
      description: def.description,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export async function updateSetting(actor: Actor, key: string, value: unknown, confirm: boolean): Promise<void> {
  if (!(key in SETTING_DEFS)) throw new ValidationError(`Unknown setting ${key}`);
  const def = SETTING_DEFS[key as SettingKey];
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`Invalid value for ${key}`, parsed.error.flatten());
  await prisma.$transaction(async (tx) => {
    const before = await tx.setting.findUnique({ where: { key } });
    const data = {
      value: parsed.data as Prisma.InputJsonValue,
      isPlaceholder: confirm ? false : (before?.isPlaceholder ?? def.placeholder),
      description: def.description,
      updatedById: actor.id,
    };
    await tx.setting.upsert({ where: { key }, create: { key, ...data }, update: data });
    await audit(tx, actor, {
      action: 'SETTING_UPDATED',
      recordType: 'Setting',
      recordId: key,
      before: before ? { value: before.value, isPlaceholder: before.isPlaceholder } : null,
      after: { value: parsed.data, isPlaceholder: data.isPlaceholder },
    });
  });
  cache.delete(key);
}

/** Seed helper: insert defaults for missing keys only. */
export async function seedSettingDefaults(db: Db = prisma): Promise<void> {
  for (const key of Object.keys(SETTING_DEFS) as SettingKey[]) {
    const def = SETTING_DEFS[key];
    await db.setting.upsert({
      where: { key },
      create: { key, value: def.default as Prisma.InputJsonValue, isPlaceholder: def.placeholder, description: def.description },
      update: {},
    });
  }
}
