import type { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { normalizePhone } from '../../lib/phone';
import { audit, type Actor } from '../../services/audit';
import { getSetting } from '../../services/settings';
import { deny } from '../../services/scope';
import { hashPassword, validatePasswordStrength } from '../../auth/service';
import { publish, userRoom } from '../../services/realtime';

/** Roles only the MD may create or modify (leadership accounts). */
const MD_ONLY_TARGETS: Role[] = ['MD', 'MANAGER', 'MARKETING_DIRECTOR', 'MARKETING_LEAD'];

/**
 * Who may create/modify an account with `targetRole`:
 *  - LEAD_MEMBER: Hamza Zafar (MARKETING_DIRECTOR) or Usama Sufain (MD) only — spec §2/§16 (fixed rule).
 *  - Leadership roles: MD only (docs/DECISIONS.md D-007).
 *  - Other staff/Doctor: roles in setting `accounts.creatorRoles` (placeholder, spec §26).
 */
export async function assertCanManageRole(actor: Actor, targetRole: Role): Promise<void> {
  const r = actor.role;
  // The hidden developer account is never created or changed through the app (D-043).
  if (targetRole === 'DEVELOPER') deny('User', undefined, 'users:developer_not_manageable');
  // The developer manages every staff account, leadership included (D-043).
  if (r === 'DEVELOPER') return;
  if (targetRole === 'LEAD_MEMBER') {
    if (r === 'MD' || r === 'MARKETING_DIRECTOR') return;
    deny('User', undefined, 'users:lead_member_admin_hamza_or_usama');
  }
  if (MD_ONLY_TARGETS.includes(targetRole)) {
    if (r === 'MD') return;
    deny('User', undefined, 'users:leadership_md_only');
  }
  const creators = await getSetting('accounts.creatorRoles');
  if (!r || !creators.includes(r)) deny('User', undefined, 'users:creator_roles');
}

const publicUser = {
  id: true,
  displayName: true,
  email: true,
  phone: true,
  memberCode: true,
  role: true,
  title: true,
  active: true,
  isDemo: true,
  mustChangePassword: true,
  createdAt: true,
} as const;

export async function listUsers(actor: Actor, filter: { role?: Role; active?: boolean; q?: string }) {
  const where = {
    // The developer account is hidden from every list (D-043).
    role: filter.role && filter.role !== 'DEVELOPER' ? filter.role : { not: 'DEVELOPER' as Role },
    ...(filter.active !== undefined ? { active: filter.active } : {}),
    ...(filter.q ? { OR: [{ displayName: { contains: filter.q } }, { memberCode: { contains: filter.q.toUpperCase() } }] } : {}),
  };
  // Marketing Director manages Lead members only.
  if (actor.role === 'MARKETING_DIRECTOR') Object.assign(where, { role: 'LEAD_MEMBER' });
  if (filter.role === 'DEVELOPER') return [];
  return prisma.user.findMany({ where, select: publicUser, orderBy: [{ role: 'asc' }, { displayName: 'asc' }] });
}

export interface CreateUserInput {
  displayName: string;
  role: Role;
  email?: string;
  phone?: string;
  memberCode?: string;
  title?: string;
  password: string;
  specialty?: string;
}

export async function createUser(actor: Actor, input: CreateUserInput) {
  await assertCanManageRole(actor, input.role);
  validatePasswordStrength(input.password);
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) throw new ValidationError('Phone number durust nahi hai.');
  if (!input.email && !phone && !input.memberCode) throw new ValidationError('Email, phone ya Member ID mein se kam az kam ek zaroori hai.');
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          displayName: input.displayName.trim(),
          role: input.role,
          email: input.email?.toLowerCase() ?? null,
          phone,
          memberCode: input.memberCode?.toUpperCase() ?? null,
          title: input.title ?? null,
          passwordHash,
          // The admin knows this first password, so the person must choose their own at first sign-in (D-043).
          mustChangePassword: true,
          createdById: actor.id,
        },
        select: publicUser,
      });
      if (input.role === 'DOCTOR') await tx.doctorProfile.create({ data: { userId: user.id, specialty: input.specialty ?? null } });
      if (input.role === 'LEAD_MEMBER') await tx.leadMemberProfile.create({ data: { userId: user.id, createdById: actor.id! } });
      await audit(tx, actor, { action: 'USER_CREATED', recordType: 'User', recordId: user.id, after: user });
      return user;
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new ConflictError('DUPLICATE_USER', 'Yeh email/phone/Member ID pehle se kisi account par hai.');
    throw e;
  }
}

export interface UpdateUserInput {
  displayName?: string;
  role?: Role;
  active?: boolean;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
}

/** Role change or disable bumps tokenVersion and revokes sessions, so it applies on the next API request (spec §2). */
export async function updateUser(actor: Actor, id: string, input: UpdateUserInput) {
  const before = await prisma.user.findUnique({ where: { id }, select: publicUser });
  if (!before) throw new NotFoundError('User');
  if (id === actor.id && (input.role || input.active === false)) {
    deny('User', id, 'users:no_self_role_or_disable');
  }
  await assertCanManageRole(actor, before.role);
  if (input.role && input.role !== before.role) {
    await assertCanManageRole(actor, input.role);
    // Doctor ↔ non-doctor role change would orphan clinical ownership; a separate account is required.
    if (before.role === 'DOCTOR' || input.role === 'DOCTOR') {
      throw new ValidationError('Doctor role change ki ijazat nahi; naya account banayein.');
    }
  }
  const phone = input.phone === undefined ? undefined : input.phone === null ? null : normalizePhone(input.phone);
  if (input.phone && !phone) throw new ValidationError('Phone number durust nahi hai.');
  const securityChange = (input.role && input.role !== before.role) || (input.active !== undefined && input.active !== before.active);

  return prisma.$transaction(async (tx) => {
    const after = await tx.user.update({
      where: { id },
      data: {
        displayName: input.displayName?.trim(),
        role: input.role,
        active: input.active,
        email: input.email === undefined ? undefined : (input.email?.toLowerCase() ?? null),
        phone,
        title: input.title,
        ...(securityChange ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: publicUser,
    });
    if (securityChange) {
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await publish(tx, [userRoom(id)], 'session:revoked', { reason: input.active === false ? 'ACCOUNT_DISABLED' : 'ACCESS_CHANGED' });
    }
    await audit(tx, actor, { action: securityChange ? 'USER_ACCESS_CHANGED' : 'USER_UPDATED', recordType: 'User', recordId: id, before, after });
    return after;
  });
}

/**
 * Admin sets a temporary password (D-043): the person must choose their own at next sign-in; all their sessions end.
 * Same authority as editing the account (assertCanManageRole). The password itself is never stored or audited.
 */
export async function setTemporaryPassword(actor: Actor, id: string, password: string) {
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) throw new NotFoundError('User');
  if (id === actor.id) throw new ValidationError('Apna password "Password badlein" se badlein.');
  await assertCanManageRole(actor, target.role);
  validatePasswordStrength(password);
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true, tokenVersion: { increment: 1 } } });
    await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await publish(tx, [userRoom(id)], 'session:revoked', { reason: 'PASSWORD_RESET' });
    await audit(tx, actor, { action: 'USER_PASSWORD_SET', recordType: 'User', recordId: id, after: { mustChangePassword: true } });
  });
  return { id, mustChangePassword: true };
}
