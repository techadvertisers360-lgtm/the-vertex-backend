import { isIP } from 'node:net';
import type { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';
import { getConfig, normalizeIp } from '../../services/geofence';

/**
 * Developer controls for the clinic location restriction (D-062): the global switch, clinic point, radius and allowed
 * clinic IPs, and a per-user "Sirf clinic par chale" switch (default off; no role or person is exempt by code).
 * Every change clears the affected on-site claims so it applies on the next request. Audited.
 */

export async function overview() {
  const [config, users] = await Promise.all([
    getConfig(),
    prisma.user.findMany({
      select: { id: true, displayName: true, role: true, memberCode: true, active: true, geofenceRequired: true, geoLastCheckAt: true, geoLastInside: true, geoLastDistanceM: true },
      orderBy: [{ active: 'desc' }, { role: 'asc' }, { displayName: 'asc' }],
    }),
  ]);
  return { config, users };
}

export interface ConfigInput {
  enabled: boolean;
  latitude: number;
  longitude: number;
  radiusM: number;
  allowedIps: string[];
}

export async function saveConfig(actor: Actor, input: ConfigInput) {
  const ips = [...new Set(input.allowedIps.map(normalizeIp).filter(Boolean))];
  const bad = ips.filter((ip) => !isIP(ip));
  if (bad.length) throw new ValidationError(`Yeh IP sahi nahi: ${bad.join(', ')}`);
  return prisma.$transaction(async (tx) => {
    const before = await getConfig(tx);
    const data = { enabled: input.enabled, latitude: input.latitude, longitude: input.longitude, radiusM: input.radiusM, allowedIps: ips.join('\n') || null, updatedById: actor.id };
    await tx.geofenceConfig.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    // A changed point / radius / IP list must not ride on claims given under the old one.
    await tx.session.updateMany({ where: { geoClaimUntil: { not: null } }, data: { geoClaimUntil: null } });
    const after = await getConfig(tx);
    await audit(tx, actor, { action: 'GEOFENCE_CONFIG_UPDATED', recordType: 'GeofenceConfig', recordId: '1', before, after });
    return after;
  });
}

export async function setUser(actor: Actor, userId: string, required: boolean) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, geofenceRequired: true } });
    if (!before) throw new NotFoundError('User');
    await tx.user.update({ where: { id: userId }, data: { geofenceRequired: required } });
    await tx.session.updateMany({ where: { userId, geoClaimUntil: { not: null } }, data: { geoClaimUntil: null } });
    await audit(tx, actor, { action: 'GEOFENCE_USER_SET', recordType: 'User', recordId: userId, before: { geofenceRequired: before.geofenceRequired }, after: { geofenceRequired: required } });
    return { id: userId, geofenceRequired: required };
  });
}

/** Convenience: set the switch for everyone currently in a role. The result is still one switch per user. */
export async function setRole(actor: Actor, role: Role, required: boolean) {
  return prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({ where: { role }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const { count } = await tx.user.updateMany({ where: { id: { in: ids } }, data: { geofenceRequired: required } });
    await tx.session.updateMany({ where: { userId: { in: ids }, geoClaimUntil: { not: null } }, data: { geoClaimUntil: null } });
    await audit(tx, actor, { action: 'GEOFENCE_ROLE_SET', recordType: 'User', after: { role, geofenceRequired: required, users: ids } });
    return { role, geofenceRequired: required, count };
  });
}
