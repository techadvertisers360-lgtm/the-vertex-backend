import type { GeofenceConfig } from '@prisma/client';
import { prisma, type Db } from '../lib/prisma';
import { audit, type Actor } from './audit';

/**
 * Clinic location restriction (client 2026-10-26, D-062). The developer turns it on globally and per user. A user with
 * the restriction on posts their location (or comes from an allowed clinic IP); when they are inside the radius the
 * server stamps a short on-site claim on their session, and every API call needs a live claim (`requireAuth`).
 * Privacy: coordinates are never stored — only the last check (time, inside, distance) on the user, and blocked
 * attempts in the audit log.
 */

export const CLAIM_TTL_MS = 15 * 60_000;
export const MAX_ACCURACY_M = 500;
export const OUTSIDE_MSG = 'Yeh app sirf clinic par khulti hai';

export type GeofenceView = Omit<GeofenceConfig, 'allowedIps'> & { allowedIps: string[] };

const DEFAULTS: Omit<GeofenceConfig, 'updatedAt'> = { id: 1, enabled: false, latitude: 31.5020747, longitude: 74.4335575, radiusM: 200, allowedIps: null, updatedById: null };

/** The config row, or the placeholder defaults before the developer first saves it. Read fresh: changes apply at once. */
export async function getConfig(db: Db = prisma): Promise<GeofenceView> {
  const row = (await db.geofenceConfig.findUnique({ where: { id: 1 } })) ?? { ...DEFAULTS, updatedAt: new Date(0) };
  return { ...row, allowedIps: parseIps(row.allowedIps) };
}

/** One IP per line / comma; IPv4-mapped IPv6 ("::ffff:1.2.3.4") is reduced to the IPv4 form (pure; unit-tested). */
export function parseIps(text: string | null | undefined): string[] {
  return [...new Set((text ?? '').split(/[\s,]+/).map(normalizeIp).filter(Boolean))];
}

export function normalizeIp(ip: string | null | undefined): string {
  return (ip ?? '').trim().replace(/^::ffff:/i, '').toLowerCase();
}

/** Great-circle distance in metres (haversine; pure, unit-tested). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface LocationInput {
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  /** Why the browser gave no location ("denied", "unavailable", "timeout"), for the blocked-attempt log. */
  error?: string;
}

export type CheckResult =
  | { ok: true; required: false }
  | { ok: true; required: true; by: 'IP' | 'LOCATION'; distanceM: number | null; claimUntil: Date }
  | { ok: false; required: true; reason: 'NO_LOCATION' | 'LOW_ACCURACY' | 'OUTSIDE'; distanceM: number | null; radiusM: number; message: string };

/**
 * Decide on-site for the person holding `sessionId` (the developer's own account while viewing as someone) and
 * stamp / clear the claim. Not required (geofence off, or this user's switch off) → nothing to do.
 */
export async function check(actor: Actor, who: { userId: string; sessionId: string; ip: string | undefined }, input: LocationInput): Promise<CheckResult> {
  const [cfg, user] = await Promise.all([getConfig(), prisma.user.findUnique({ where: { id: who.userId }, select: { geofenceRequired: true } })]);
  if (!cfg.enabled || !user?.geofenceRequired) return { ok: true, required: false };

  const ip = normalizeIp(who.ip);
  const hasFix = typeof input.latitude === 'number' && typeof input.longitude === 'number';
  const distance = hasFix ? Math.round(distanceM({ lat: input.latitude!, lng: input.longitude! }, { lat: cfg.latitude, lng: cfg.longitude })) : null;
  const viaIp = !!ip && cfg.allowedIps.includes(ip);
  let reason: 'NO_LOCATION' | 'LOW_ACCURACY' | 'OUTSIDE' | null = null;
  if (!viaIp) {
    if (!hasFix) reason = 'NO_LOCATION';
    else if (!(typeof input.accuracyM === 'number' && input.accuracyM >= 0 && input.accuracyM <= MAX_ACCURACY_M)) reason = 'LOW_ACCURACY';
    else if (distance! > cfg.radiusM) reason = 'OUTSIDE';
  }
  const now = new Date();
  const inside = reason === null;
  const claimUntil = inside ? new Date(now.getTime() + CLAIM_TTL_MS) : null;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: who.userId }, data: { geoLastCheckAt: now, geoLastInside: inside, geoLastDistanceM: distance } });
    await tx.session.update({ where: { id: who.sessionId }, data: { geoClaimUntil: claimUntil } });
    if (!inside)
      await audit(tx, actor, {
        action: 'GEOFENCE_BLOCKED',
        recordType: 'User',
        recordId: who.userId,
        // distance and accuracy only — never coordinates
        after: { reason, distanceM: distance, accuracyM: input.accuracyM ?? null, radiusM: cfg.radiusM, browserError: input.error?.slice(0, 40) ?? null },
      });
  });
  if (inside) return { ok: true, required: true, by: viaIp ? 'IP' : 'LOCATION', distanceM: distance, claimUntil: claimUntil! };
  const message =
    reason === 'NO_LOCATION'
      ? `${OUTSIDE_MSG} — location nahi mili. Phone / browser mein location allow karein aur dobara try karein.`
      : reason === 'LOW_ACCURACY'
        ? `${OUTSIDE_MSG} — location saaf nahi (accuracy ${Math.round(input.accuracyM ?? 0)} m). GPS on kar ke dobara try karein.`
        : `${OUTSIDE_MSG} — aap clinic se ${distance} m door hain (had ${cfg.radiusM} m).`;
  return { ok: false, required: true, reason: reason!, distanceM: distance, radiusM: cfg.radiusM, message };
}

/** Whether this request may proceed: restriction off, or a live claim on the session. */
export async function requestAllowed(user: { geofenceRequired: boolean; claimUntil: Date | null }, now = new Date()): Promise<boolean> {
  if (!user.geofenceRequired) return true;
  if (user.claimUntil && user.claimUntil > now) return true;
  return !(await getConfig()).enabled;
}
