import type { Role } from '@prisma/client';

/**
 * Static, version-controlled permission matrix (docs/DECISIONS.md D-002).
 * Permissions gate *what kind* of action a role may attempt; services additionally enforce
 * *which records* (object scope) and business locks (spec §4).
 */
export const PERMISSIONS = [
  // shared
  'notifications:own',
  'attendance:own',
  'requests:own', // own leave / complaint
  'files:read', // still scope-checked per attachment
  // leads
  'leads:own', // assigned-sheet leads only
  'leads:admin', // member + sheet administration (Hamza Zafar / Usama Sufain)
  'leads:reports',
  // scheduling
  'appointments:book',
  'appointments:read',
  'appointments:reschedule', // direct atomic reschedule (Lead own bookings, Manager)
  'appointments:reschedule_request', // Reception → Manager
  'appointments:reschedule_approve', // Manager
  'availability:read',
  'availability:own', // Doctor: own leave / alternate hours
  'availability:approve', // Manager
  // reception
  'patients:search',
  'patients:create',
  'reception:checkin',
  'reception:vitals',
  'reception:billing',
  'reception:assign_procedure',
  'reception:feedback',
  'complaints:patient',
  // doctor
  'doctor:queue',
  'doctor:history_own',
  'doctor:history_request',
  'doctor:plan',
  'doctor:aftercare',
  // assistant
  'assistant:tasks',
  'assistant:rooms',
  // office boy
  'officeboy:rounds',
  'stock:demand_create',
  // manager
  'manager:dashboard',
  'manager:staff_review',
  'manager:room_assign',
  'manager:room_verify',
  'manager:followups',
  'manager:approvals', // history access, alternate availability, replacement, reschedule
  'requests:inbox', // complaints/leave addressed to me or my role
  'stock:manage',
  'stock:approve_manager', // ≤ threshold
  'stock:approve_md', // > threshold
  'cash:closing',
  'audit:search',
  'settings:manage',
  'users:manage',
  'messages:log', // WhatsApp message log, retry, opt-out (spec §20)
  // MD
  'md:dashboard',
  'md:approvals',
  'reports:all',
  // marketing
  'marketing:dashboard',
  'marketing:ad_requests',
  'marketing:offers',
  'offers:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SHARED: Permission[] = ['notifications:own', 'attendance:own', 'requests:own', 'files:read'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  LEAD_MEMBER: [
    ...SHARED,
    'leads:own',
    'appointments:book',
    'appointments:read',
    'appointments:reschedule',
    'availability:read',
    'offers:read',
  ],
  RECEPTIONIST: [
    ...SHARED,
    'patients:search',
    'patients:create',
    'appointments:book',
    'appointments:read',
    'appointments:reschedule_request',
    'availability:read',
    'reception:checkin',
    'reception:vitals',
    'reception:billing',
    'reception:assign_procedure',
    'reception:feedback',
    'complaints:patient',
    'offers:read',
  ],
  DOCTOR: [
    ...SHARED,
    'doctor:queue',
    'doctor:history_own',
    'doctor:history_request',
    'doctor:plan',
    'doctor:aftercare',
    'availability:own',
    'availability:read',
  ],
  ASSISTANT: [...SHARED, 'assistant:tasks', 'assistant:rooms', 'stock:demand_create'],
  OFFICE_BOY: [...SHARED, 'officeboy:rounds', 'stock:demand_create'],
  MANAGER: [
    ...SHARED,
    'manager:dashboard',
    'manager:staff_review',
    'manager:room_assign',
    'manager:room_verify',
    'manager:followups',
    'manager:approvals',
    'requests:inbox',
    'patients:search',
    'appointments:book',
    'appointments:read',
    'appointments:reschedule',
    'appointments:reschedule_approve',
    'availability:read',
    'availability:approve',
    'stock:manage',
    'stock:approve_manager',
    'stock:demand_create',
    'cash:closing',
    'audit:search',
    'settings:manage',
    'users:manage',
    'offers:read',
    'leads:reports',
    'messages:log',
  ],
  MD: [
    ...SHARED,
    'md:dashboard',
    'md:approvals',
    'requests:inbox',
    'reports:all',
    'stock:approve_md',
    'leads:admin',
    'leads:reports',
    'audit:search',
    'settings:manage',
    'users:manage',
    'appointments:read',
    'offers:read',
  ],
  MARKETING_DIRECTOR: [
    ...SHARED,
    'leads:admin',
    'leads:reports',
    'marketing:dashboard',
    'marketing:ad_requests',
    'marketing:offers',
    'requests:inbox',
    'offers:read',
  ],
  MARKETING_LEAD: [
    ...SHARED,
    'leads:reports',
    'marketing:dashboard',
    'marketing:ad_requests',
    'marketing:offers',
    'requests:inbox',
    'offers:read',
  ],
};

export function hasPermission(role: Role, p: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(p);
}

export interface NavModule {
  key: string;
  label: string;
  path: string;
  permission: Permission;
}

/** Left-nav modules. The frontend renders only what `GET /api/me` returns (spec §3). */
export const NAV_MODULES: Record<Role, NavModule[]> = {
  LEAD_MEMBER: [
    { key: 'sheets', label: 'My Sheets', path: '/lead', permission: 'leads:own' },
    { key: 'leads', label: 'Leads', path: '/lead/leads', permission: 'leads:own' },
    { key: 'callbacks', label: 'Reminder Queue', path: '/lead/callbacks', permission: 'leads:own' },
    { key: 'appointments', label: 'Appointments', path: '/lead/appointments', permission: 'appointments:read' },
    { key: 'requests', label: 'Requests', path: '/lead/requests', permission: 'requests:own' },
    { key: 'performance', label: 'My Performance', path: '/lead/performance', permission: 'leads:own' },
  ],
  RECEPTIONIST: [
    { key: 'dashboard', label: 'Dashboard', path: '/reception', permission: 'reception:checkin' },
    { key: 'patients', label: 'Patients', path: '/reception/patients', permission: 'patients:search' },
    { key: 'tracker', label: 'Active Tracker', path: '/reception/tracker', permission: 'reception:checkin' },
    { key: 'procedures', label: 'Procedures', path: '/reception/procedures', permission: 'reception:assign_procedure' },
    { key: 'upcoming', label: 'Upcoming Procedures', path: '/reception/upcoming', permission: 'reception:assign_procedure' },
    { key: 'billing', label: 'Billing', path: '/reception/billing', permission: 'reception:billing' },
    { key: 'done', label: 'Patient Done', path: '/reception/done', permission: 'reception:checkin' },
    { key: 'staff', label: 'Staff Actions', path: '/reception/staff', permission: 'attendance:own' },
  ],
  DOCTOR: [
    { key: 'queue', label: 'My Queue', path: '/doctor', permission: 'doctor:queue' },
    { key: 'patients', label: 'My Patients', path: '/doctor/patients', permission: 'doctor:history_own' },
    { key: 'history-requests', label: 'History Requests', path: '/doctor/history-requests', permission: 'doctor:history_request' },
    { key: 'availability', label: 'Leave & Availability', path: '/doctor/availability', permission: 'availability:own' },
    { key: 'aftercare', label: 'Aftercare', path: '/doctor/aftercare', permission: 'doctor:aftercare' },
  ],
  ASSISTANT: [
    { key: 'tasks', label: 'My Tasks', path: '/assistant', permission: 'assistant:tasks' },
    { key: 'rooms', label: 'My Rooms', path: '/assistant/rooms', permission: 'assistant:rooms' },
    { key: 'demands', label: 'Stock Demand', path: '/assistant/demands', permission: 'stock:demand_create' },
    { key: 'staff', label: 'Staff Actions', path: '/assistant/staff', permission: 'attendance:own' },
  ],
  OFFICE_BOY: [
    { key: 'duties', label: 'My Duties', path: '/office', permission: 'officeboy:rounds' },
    { key: 'demands', label: 'Stock Demand', path: '/office/demands', permission: 'stock:demand_create' },
    { key: 'staff', label: 'Staff Actions', path: '/office/staff', permission: 'attendance:own' },
  ],
  MANAGER: [
    { key: 'dashboard', label: 'Dashboard', path: '/manager', permission: 'manager:dashboard' },
    { key: 'tracker', label: 'Patient Tracker', path: '/manager/tracker', permission: 'appointments:read' },
    { key: 'schedule', label: 'Doctors & Rooms', path: '/manager/schedule', permission: 'availability:approve' },
    { key: 'staff', label: 'Staff', path: '/manager/staff', permission: 'manager:staff_review' },
    { key: 'rooms', label: 'Room Verification', path: '/manager/rooms', permission: 'manager:room_verify' },
    { key: 'followups', label: 'Follow-ups', path: '/manager/followups', permission: 'manager:followups' },
    { key: 'requests', label: 'Complaints & Leave', path: '/manager/requests', permission: 'requests:inbox' },
    { key: 'approvals', label: 'Approvals', path: '/manager/approvals', permission: 'manager:approvals' },
    { key: 'stock', label: 'Stock & Vendors', path: '/manager/stock', permission: 'stock:manage' },
    { key: 'cash', label: 'Cash Closing', path: '/manager/cash', permission: 'cash:closing' },
    { key: 'messages', label: 'Message Log', path: '/manager/messages', permission: 'messages:log' },
    { key: 'audit', label: 'Audit & History', path: '/manager/audit', permission: 'audit:search' },
    { key: 'settings', label: 'Settings', path: '/manager/settings', permission: 'settings:manage' },
  ],
  MD: [
    { key: 'dashboard', label: 'Overview', path: '/md', permission: 'md:dashboard' },
    { key: 'approvals', label: 'Approval Center', path: '/md/approvals', permission: 'md:approvals' },
    { key: 'escalations', label: 'Complaints & Escalations', path: '/md/escalations', permission: 'requests:inbox' },
    { key: 'reports', label: 'Reports', path: '/md/reports', permission: 'reports:all' },
    { key: 'lead-admin', label: 'Lead Team Admin', path: '/md/lead-admin', permission: 'leads:admin' },
    { key: 'audit', label: 'Audit & History', path: '/md/audit', permission: 'audit:search' },
    { key: 'settings', label: 'Settings', path: '/md/settings', permission: 'settings:manage' },
  ],
  MARKETING_DIRECTOR: [
    { key: 'dashboard', label: 'Dashboard', path: '/marketing/hamza', permission: 'marketing:dashboard' },
    { key: 'members', label: 'Lead Team Members', path: '/marketing/hamza/members', permission: 'leads:admin' },
    { key: 'sheets', label: 'Meta Sheets', path: '/marketing/hamza/sheets', permission: 'leads:admin' },
    { key: 'performance', label: 'Performance', path: '/marketing/hamza/performance', permission: 'leads:reports' },
    { key: 'requests', label: 'Ad / Issue Requests', path: '/marketing/hamza/requests', permission: 'marketing:ad_requests' },
    { key: 'escalations', label: 'Complaints & Escalations', path: '/marketing/hamza/escalations', permission: 'requests:inbox' },
    { key: 'my-requests', label: 'My Leave & Complaints', path: '/marketing/hamza/my-requests', permission: 'requests:own' },
  ],
  MARKETING_LEAD: [
    { key: 'dashboard', label: 'Dashboard', path: '/marketing/muaz', permission: 'marketing:dashboard' },
    { key: 'requests', label: 'Ad Requests', path: '/marketing/muaz/requests', permission: 'marketing:ad_requests' },
    { key: 'offers', label: 'Creatives & Offers', path: '/marketing/muaz/offers', permission: 'marketing:offers' },
    { key: 'performance', label: 'Performance', path: '/marketing/muaz/performance', permission: 'leads:reports' },
    { key: 'complaints', label: 'Complaints', path: '/marketing/muaz/complaints', permission: 'requests:inbox' },
    { key: 'my-requests', label: 'My Leave & Complaints', path: '/marketing/muaz/my-requests', permission: 'requests:own' },
  ],
};

export const ROLE_HOME: Record<Role, string> = {
  LEAD_MEMBER: '/lead',
  RECEPTIONIST: '/reception',
  DOCTOR: '/doctor',
  ASSISTANT: '/assistant',
  OFFICE_BOY: '/office',
  MANAGER: '/manager',
  MD: '/md',
  MARKETING_DIRECTOR: '/marketing/hamza',
  MARKETING_LEAD: '/marketing/muaz',
};
