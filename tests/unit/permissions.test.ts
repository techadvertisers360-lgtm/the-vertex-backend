import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import { hasPermission, NAV_MODULES, ROLE_PERMISSIONS } from '../../src/auth/permissions';
import { SETTING_DEFS } from '../../src/services/settings';
import { UPLOAD_RULES } from '../../src/services/files';

const ALL_ROLES = Object.values(Role);

describe('permission matrix (spec §4)', () => {
  it('every nav module is backed by a permission the role holds', () => {
    for (const role of ALL_ROLES) {
      for (const m of NAV_MODULES[role]) expect(hasPermission(role, m.permission), `${role} → ${m.key}`).toBe(true);
    }
  });

  it('only Hamza Zafar (MARKETING_DIRECTOR) and Usama (MD) administer lead members/sheets', () => {
    const admins = ALL_ROLES.filter((r) => hasPermission(r, 'leads:admin'));
    expect(admins.sort()).toEqual(['MARKETING_DIRECTOR', 'MD']);
  });

  it('Manager approves ≤ threshold; only MD approves above it', () => {
    expect(ALL_ROLES.filter((r) => hasPermission(r, 'stock:approve_md'))).toEqual(['MD']);
    expect(ALL_ROLES.filter((r) => hasPermission(r, 'stock:approve_manager'))).toEqual(['MANAGER']);
  });

  it('Office Boy has no patient-facing permission', () => {
    const patientPerms = ['patients:search', 'appointments:read', 'doctor:history_own', 'reception:checkin', 'assistant:tasks'] as const;
    for (const p of patientPerms) expect(hasPermission('OFFICE_BOY', p)).toBe(false);
  });

  it('marketing roles have no clinical / financial permissions', () => {
    for (const role of ['MARKETING_DIRECTOR', 'MARKETING_LEAD'] as const) {
      for (const p of ['doctor:history_own', 'reception:billing', 'stock:manage', 'cash:closing', 'patients:search'] as const) {
        expect(hasPermission(role, p), `${role} ${p}`).toBe(false);
      }
    }
  });

  it('Doctor cannot manage stock, approve, or bill', () => {
    for (const p of ['stock:manage', 'manager:approvals', 'reception:billing', 'availability:approve'] as const) {
      expect(hasPermission('DOCTOR', p)).toBe(false);
    }
  });

  it('every role has at least one nav module and the shared permissions', () => {
    for (const role of ALL_ROLES) {
      expect(NAV_MODULES[role].length).toBeGreaterThan(0);
      expect(ROLE_PERMISSIONS[role]).toContain('notifications:own');
    }
  });
});

describe('settings registry (spec §26)', () => {
  it('every default satisfies its own schema', () => {
    for (const [key, def] of Object.entries(SETTING_DEFS)) {
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
    }
  });

  it('spec-fixed values are not placeholders; open clinic decisions are', () => {
    expect(SETTING_DEFS['stock.managerApprovalLimitPaisa'].default).toBe(2_000_000);
    expect(SETTING_DEFS['stock.managerApprovalLimitPaisa'].placeholder).toBe(false);
    expect(SETTING_DEFS['scheduling.consultBufferMin'].default).toBe(10);
    expect(SETTING_DEFS['scheduling.procedureBufferMin'].default).toBe(20);
    expect(SETTING_DEFS['sla.consentMinutes'].default).toBe(8);
    expect(SETTING_DEFS['sla.roomCleanMinutes'].default).toBe(7);
    expect(SETTING_DEFS['scheduling.consultDurationMin'].placeholder).toBe(true);
    expect(SETTING_DEFS['whatsapp.provider'].placeholder).toBe(true);
  });
});

describe('upload routes', () => {
  it('clinical files are private; only ad creatives are public', () => {
    const publicRoutes = Object.entries(UPLOAD_RULES).filter(([, r]) => !r.isPrivate).map(([k]) => k);
    expect(publicRoutes).toEqual(['adCreative']);
  });
  it('Office Boy can never upload clinical files', () => {
    for (const r of ['consentForm', 'prescriptionPhoto', 'beforePhoto', 'afterPhoto'] as const) {
      expect(UPLOAD_RULES[r].uploaders).not.toContain('OFFICE_BOY');
    }
  });
});
