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
  'bank:manage', // Manager / MD: clinic bank accounts for online payments (D-080)
  'patients:records', // Manager / MD: every patient's full history, view only (D-078), and correct details (D-079)
  'patients:history', // Reception: read the patient list and full history, no corrections (D-087)
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
  'stock:reception', // Reception "Stock & batches": procedure + pharmacy products (D-048)
  'services:reception', // Reception "Procedures & Services" list: view, add, edit, hide (D-060)
  'stock:approve_manager', // ≤ threshold
  'stock:approve_md', // > threshold
  'cash:closing',
  'audit:search',
  'settings:manage',
  'users:manage',
  // invoice module (D-084): change who may do what in INVOICE_DESK / INVOICE_MANAGER / INVOICE_OWNER below
  'invoice:view', // list and search, one invoice
  'invoice:create', // direct invoice, patient search / add, form options
  'invoice:pay', // later payments, use an advance
  'invoice:advance', // record advance payments
  'invoice:print',
  'invoice:view_discount', // discount columns and totals in the list and on an invoice
  'invoice:totals', // rupee totals of the filtered rows
  'invoice:export', // Excel / PDF of the filtered rows
  'invoice:cancel', // cancel an invoice, refund an advance
  'invoice:export_all', // every invoice as Excel / CSV
  'invoice:settings', // invoice Settings, Payment Modes, Invoice Categories
  'invoice:audit', // invoice audit history
  // clinic operations from the client's demo (D-089)
  'ops:desk', // Reception and Manager: part payment and correction requests, cash handover, sale returns, packages, documents
  'ops:manage', // Manager and MD: decide those, purchase orders, kits, room holds, clinic now
  'finance:owner', // MD and Hamza Zafar: expenses, profit and loss, payroll, doctor ledger, costs, data check
  'doctor:share', // Doctor: own share of the bill, no cost fields
  'office:purchase', // Office Boy and Manager: ask for office purchases
  'chat:use',
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
  // developer (D-043)
  'developer:console', // hidden developer: staff accounts, passwords, "view as" any staff user (read-only)
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SHARED: Permission[] = ['notifications:own', 'attendance:own', 'requests:own', 'files:read', 'chat:use'];

/** Invoice permissions by level. Moving a permission between these lists is all it takes to change who can do it. */
const INVOICE_DESK: Permission[] = ['invoice:view', 'invoice:create', 'invoice:pay', 'invoice:advance', 'invoice:print', 'invoice:view_discount'];
const INVOICE_MANAGER: Permission[] = [...INVOICE_DESK, 'invoice:totals', 'invoice:export', 'invoice:cancel'];
const INVOICE_OWNER: Permission[] = [...INVOICE_MANAGER, 'invoice:export_all', 'invoice:settings', 'invoice:audit'];

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
    'patients:history',
    'ops:desk',
    'appointments:book',
    'appointments:read',
    'appointments:reschedule_request',
    'availability:read',
    'reception:checkin',
    'reception:vitals',
    'reception:billing',
    'reception:assign_procedure',
    'reception:feedback',
    'stock:reception',
    'services:reception',
    'complaints:patient',
    'offers:read',
    ...INVOICE_DESK,
  ],
  DOCTOR: [
    ...SHARED,
    'doctor:queue',
    'doctor:history_own',
    'doctor:history_request',
    'doctor:plan',
    'doctor:aftercare',
    'doctor:share',
    'availability:own',
    'availability:read',
  ],
  ASSISTANT: [...SHARED, 'assistant:tasks', 'assistant:rooms', 'stock:demand_create'],
  OFFICE_BOY: [...SHARED, 'officeboy:rounds', 'stock:demand_create', 'office:purchase'],
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
    'patients:records',
    'ops:desk',
    'ops:manage',
    'office:purchase',
    'bank:manage',
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
    ...INVOICE_MANAGER,
  ],
  MD: [
    ...SHARED,
    'md:dashboard',
    'md:approvals',
    'requests:inbox',
    'patients:records',
    'ops:manage',
    'finance:owner',
    'stock:manage',
    'bank:manage',
    'reports:all',
    'stock:approve_md',
    'leads:admin',
    'leads:reports',
    'audit:search',
    'settings:manage',
    'users:manage',
    'appointments:read',
    'offers:read',
    ...INVOICE_OWNER,
  ],
  // The client's demo treats Hamza Zafar as an owner (D-092). Muaz Tahir stays marketing only.
  MARKETING_DIRECTOR: [
    ...SHARED,
    'finance:owner',
    'patients:records',
    'stock:manage',
    'reports:all',
    'audit:search',
    'bank:manage',
    ...INVOICE_OWNER,
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
  /** Hidden system developer (D-043): manages every account; never checks in, raises requests or appears in lists. */
  DEVELOPER: ['notifications:own', 'files:read', 'developer:console', 'users:manage', 'settings:manage', 'audit:search'],
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
    { key: 'connection', label: 'Connection Booking', path: '/lead/connection', permission: 'appointments:book' },
    { key: 'requests', label: 'Requests', path: '/lead/requests', permission: 'requests:own' },
    { key: 'chat', label: 'Chat', path: '/lead/chat', permission: 'chat:use' },
    { key: 'performance', label: 'My Performance', path: '/lead/performance', permission: 'leads:own' },
  ],
  RECEPTIONIST: [
    { key: 'dashboard', label: 'Dashboard', path: '/reception', permission: 'reception:checkin' },
    { key: 'walk-in', label: 'Walk-in / Create Invoice', path: '/reception/walk-in', permission: 'reception:checkin' },
    { key: 'patients', label: 'Patients', path: '/reception/patients', permission: 'patients:search' },
    { key: 'tracker', label: 'Active Tracker', path: '/reception/tracker', permission: 'reception:checkin' },
    { key: 'procedures', label: 'Procedures', path: '/reception/procedures', permission: 'reception:assign_procedure' },
    { key: 'upcoming-appointments', label: 'Upcoming Appointments', path: '/reception/appointments', permission: 'reception:checkin' },
    { key: 'upcoming', label: 'Upcoming Procedures', path: '/reception/upcoming', permission: 'reception:assign_procedure' },
    { key: 'billing', label: 'Billing', path: '/reception/billing', permission: 'reception:billing' },
    { key: 'invoices', label: 'Invoices', path: '/reception/invoices', permission: 'invoice:view' },
    { key: 'plans', label: 'Treatment Plans', path: '/reception/plans', permission: 'ops:desk' },
    { key: 'ops-money', label: 'Requests & Returns', path: '/reception/requests', permission: 'ops:desk' },
    { key: 'handover', label: 'Cash Handover', path: '/reception/handover', permission: 'ops:desk' },
    { key: 'packages', label: 'Packages', path: '/reception/packages', permission: 'ops:desk' },
    { key: 'orders', label: 'Purchase Orders', path: '/reception/orders', permission: 'ops:desk' },
    { key: 'office-purchases', label: 'Office Purchases', path: '/reception/office-purchases', permission: 'ops:desk' },
    { key: 'documents', label: 'Documents', path: '/reception/documents', permission: 'ops:desk' },
    { key: 'chat', label: 'Chat', path: '/reception/chat', permission: 'chat:use' },
    { key: 'counter-sale', label: 'Counter Sale (Pharmacy)', path: '/reception/counter-sale', permission: 'reception:billing' },
    { key: 'stock', label: 'Stock & batches', path: '/reception/stock', permission: 'stock:reception' },
    { key: 'services', label: 'Procedures & Services', path: '/reception/services', permission: 'services:reception' },
    { key: 'done', label: 'Patient Done', path: '/reception/done', permission: 'reception:checkin' },
    { key: 'staff', label: 'Staff Actions', path: '/reception/staff', permission: 'attendance:own' },
  ],
  DOCTOR: [
    { key: 'queue', label: 'My Queue', path: '/doctor', permission: 'doctor:queue' },
    { key: 'upcoming', label: 'Upcoming Appointments', path: '/doctor/upcoming', permission: 'doctor:queue' },
    { key: 'patients', label: 'My Patients', path: '/doctor/patients', permission: 'doctor:history_own' },
    { key: 'history-requests', label: 'History Requests', path: '/doctor/history-requests', permission: 'doctor:history_request' },
    { key: 'availability', label: 'Leave & Availability', path: '/doctor/availability', permission: 'availability:own' },
    { key: 'plans', label: 'Treatment Plans', path: '/doctor/plans', permission: 'doctor:share' },
    { key: 'share', label: 'My Share', path: '/doctor/share', permission: 'doctor:share' },
    { key: 'requests', label: 'Part Payment Requests', path: '/doctor/requests', permission: 'doctor:share' },
    { key: 'chat', label: 'Chat', path: '/doctor/chat', permission: 'chat:use' },
    { key: 'aftercare', label: 'Aftercare', path: '/doctor/aftercare', permission: 'doctor:aftercare' },
  ],
  ASSISTANT: [
    { key: 'tasks', label: 'My Tasks', path: '/assistant', permission: 'assistant:tasks' },
    { key: 'rooms', label: 'My Rooms', path: '/assistant/rooms', permission: 'assistant:rooms' },
    { key: 'demands', label: 'Stock Demand', path: '/assistant/demands', permission: 'stock:demand_create' },
    { key: 'staff', label: 'Staff Actions', path: '/assistant/staff', permission: 'attendance:own' },
    { key: 'chat', label: 'Chat', path: '/assistant/chat', permission: 'chat:use' },
  ],
  OFFICE_BOY: [
    { key: 'duties', label: 'My Duties', path: '/office', permission: 'officeboy:rounds' },
    { key: 'demands', label: 'Stock Demand', path: '/office/demands', permission: 'stock:demand_create' },
    { key: 'staff', label: 'Staff Actions', path: '/office/staff', permission: 'attendance:own' },
    { key: 'purchases', label: 'Things I Need', path: '/office/purchases', permission: 'office:purchase' },
    { key: 'chat', label: 'Chat', path: '/office/chat', permission: 'chat:use' },
  ],
  MANAGER: [
    { key: 'dashboard', label: 'Dashboard', path: '/manager', permission: 'manager:dashboard' },
    { key: 'tracker', label: 'Patient Tracker', path: '/manager/tracker', permission: 'appointments:read' },
    { key: 'patient-records', label: 'Patient Records', path: '/manager/patients', permission: 'patients:records' },
    { key: 'schedule', label: 'Doctors, Timing & Rooms', path: '/manager/schedule', permission: 'availability:approve' },
    { key: 'staff', label: 'Staff', path: '/manager/staff', permission: 'manager:staff_review' },
    { key: 'rooms', label: 'Room Verification', path: '/manager/rooms', permission: 'manager:room_verify' },
    { key: 'followups', label: 'Follow-ups', path: '/manager/followups', permission: 'manager:followups' },
    { key: 'requests', label: 'Complaints & Leave', path: '/manager/requests', permission: 'requests:inbox' },
    { key: 'approvals', label: 'Approvals', path: '/manager/approvals', permission: 'manager:approvals' },
    { key: 'stock', label: 'Stock & Vendors', path: '/manager/stock', permission: 'stock:manage' },
    { key: 'invoices', label: 'Invoices', path: '/manager/invoices', permission: 'invoice:view' },
    { key: 'clinic-now', label: 'Clinic Now', path: '/manager/clinic-now', permission: 'ops:manage' },
    { key: 'plans', label: 'Treatment Plans', path: '/manager/plans', permission: 'ops:desk' },
    { key: 'doctors', label: 'Doctors', path: '/manager/doctors', permission: 'ops:manage' },
    { key: 'feedback', label: 'Patient Feedback', path: '/manager/feedback', permission: 'ops:manage' },
    { key: 'ops-money', label: 'Requests & Returns', path: '/manager/requests-returns', permission: 'ops:manage' },
    { key: 'handover', label: 'Cash Handover', path: '/manager/handover', permission: 'ops:desk' },
    { key: 'packages', label: 'Packages', path: '/manager/packages', permission: 'ops:desk' },
    { key: 'orders', label: 'Purchase Orders', path: '/manager/orders', permission: 'ops:manage' },
    { key: 'office-purchases', label: 'Office Purchases', path: '/manager/office-purchases', permission: 'ops:manage' },
    { key: 'kits', label: 'Kits, Rooms & Departments', path: '/manager/kits', permission: 'ops:manage' },
    { key: 'documents', label: 'Documents', path: '/manager/documents', permission: 'ops:desk' },
    { key: 'chat', label: 'Chat', path: '/manager/chat', permission: 'chat:use' },
    { key: 'cash', label: 'Cash Closing', path: '/manager/cash', permission: 'cash:closing' },
    { key: 'bank-accounts', label: 'Bank Accounts', path: '/manager/bank-accounts', permission: 'bank:manage' },
    { key: 'messages', label: 'Message Log', path: '/manager/messages', permission: 'messages:log' },
    { key: 'audit', label: 'Audit & History', path: '/manager/audit', permission: 'audit:search' },
    { key: 'settings', label: 'Settings', path: '/manager/settings', permission: 'settings:manage' },
  ],
  MD: [
    { key: 'dashboard', label: 'Overview', path: '/md', permission: 'md:dashboard' },
    { key: 'patient-records', label: 'Patient Records', path: '/md/patients', permission: 'patients:records' },
    { key: 'approvals', label: 'Approval Center', path: '/md/approvals', permission: 'md:approvals' },
    { key: 'escalations', label: 'Complaints & Escalations', path: '/md/escalations', permission: 'requests:inbox' },
    { key: 'invoices', label: 'Invoices', path: '/md/invoices', permission: 'invoice:view' },
    { key: 'clinic-now', label: 'Clinic Now', path: '/md/clinic-now', permission: 'ops:manage' },
    { key: 'finance', label: 'Finance', path: '/md/finance', permission: 'finance:owner' },
    { key: 'cash', label: 'Cash Closing', path: '/md/cash', permission: 'reports:all' },
    { key: 'stock', label: 'Stock & Vendors', path: '/md/stock', permission: 'stock:manage' },
    { key: 'orders', label: 'Purchase Orders', path: '/md/orders', permission: 'ops:manage' },
    { key: 'plans', label: 'Treatment Plans', path: '/md/plans', permission: 'finance:owner' },
    { key: 'ops-money', label: 'Requests & Returns', path: '/md/requests-returns', permission: 'ops:manage' },
    { key: 'packages', label: 'Packages', path: '/md/packages', permission: 'finance:owner' },
    { key: 'office-purchases', label: 'Office Purchases', path: '/md/office-purchases', permission: 'ops:manage' },
    { key: 'documents', label: 'Documents', path: '/md/documents', permission: 'finance:owner' },
    { key: 'chat', label: 'Chat', path: '/md/chat', permission: 'chat:use' },
    { key: 'reports', label: 'Reports', path: '/md/reports', permission: 'reports:all' },
    { key: 'bank-accounts', label: 'Bank Accounts', path: '/md/bank-accounts', permission: 'bank:manage' },
    { key: 'lead-admin', label: 'Lead Team Admin', path: '/md/lead-admin', permission: 'leads:admin' },
    { key: 'audit', label: 'Audit & History', path: '/md/audit', permission: 'audit:search' },
    { key: 'settings', label: 'Settings', path: '/md/settings', permission: 'settings:manage' },
  ],
  MARKETING_DIRECTOR: [
    { key: 'dashboard', label: 'Dashboard', path: '/marketing/hamza', permission: 'marketing:dashboard' },
    { key: 'finance', label: 'Finance', path: '/marketing/hamza/finance', permission: 'finance:owner' },
    { key: 'patient-records', label: 'Patient Records', path: '/marketing/hamza/patients', permission: 'patients:records' },
    { key: 'invoices', label: 'Invoices', path: '/marketing/hamza/invoices', permission: 'invoice:view' },
    { key: 'cash', label: 'Cash Closing', path: '/marketing/hamza/cash', permission: 'reports:all' },
    { key: 'stock', label: 'Stock & Vendors', path: '/marketing/hamza/stock', permission: 'stock:manage' },
    { key: 'reports', label: 'Reports', path: '/marketing/hamza/reports', permission: 'reports:all' },
    { key: 'audit', label: 'Audit & History', path: '/marketing/hamza/audit', permission: 'audit:search' },
    { key: 'clinic-now', label: 'Clinic Now', path: '/marketing/hamza/clinic-now', permission: 'finance:owner' },
    { key: 'plans', label: 'Treatment Plans', path: '/marketing/hamza/plans', permission: 'finance:owner' },
    { key: 'ops-money', label: 'Requests & Returns', path: '/marketing/hamza/requests-returns', permission: 'finance:owner' },
    { key: 'packages', label: 'Packages', path: '/marketing/hamza/packages', permission: 'finance:owner' },
    { key: 'office-purchases', label: 'Office Purchases', path: '/marketing/hamza/office-purchases', permission: 'finance:owner' },
    { key: 'documents', label: 'Documents', path: '/marketing/hamza/documents', permission: 'finance:owner' },
    { key: 'chat', label: 'Chat', path: '/marketing/hamza/chat', permission: 'chat:use' },
    { key: 'members', label: 'Lead Team Members', path: '/marketing/hamza/members', permission: 'leads:admin' },
    { key: 'sheets', label: 'Meta Sheets', path: '/marketing/hamza/sheets', permission: 'leads:admin' },
    { key: 'performance', label: 'Performance', path: '/marketing/hamza/performance', permission: 'leads:reports' },
    { key: 'requests', label: 'Ad / Issue Requests', path: '/marketing/hamza/requests', permission: 'marketing:ad_requests' },
    { key: 'escalations', label: 'Complaints & Escalations', path: '/marketing/hamza/escalations', permission: 'requests:inbox' },
    { key: 'my-requests', label: 'My Leave & Complaints', path: '/marketing/hamza/my-requests', permission: 'requests:own' },
  ],
  MARKETING_LEAD: [
    { key: 'dashboard', label: 'Dashboard', path: '/marketing/muaz', permission: 'marketing:dashboard' },
    { key: 'campaigns', label: 'Campaign Performance', path: '/marketing/muaz/campaigns', permission: 'marketing:dashboard' },
    { key: 'chat', label: 'Chat', path: '/marketing/muaz/chat', permission: 'chat:use' },
    { key: 'requests', label: 'Ad Requests', path: '/marketing/muaz/requests', permission: 'marketing:ad_requests' },
    { key: 'offers', label: 'Creatives & Offers', path: '/marketing/muaz/offers', permission: 'marketing:offers' },
    { key: 'performance', label: 'Performance', path: '/marketing/muaz/performance', permission: 'leads:reports' },
    { key: 'complaints', label: 'Complaints', path: '/marketing/muaz/complaints', permission: 'requests:inbox' },
    { key: 'my-requests', label: 'My Leave & Complaints', path: '/marketing/muaz/my-requests', permission: 'requests:own' },
  ],
  DEVELOPER: [
    { key: 'accounts', label: 'Staff Accounts', path: '/developer', permission: 'developer:console' },
    { key: 'issues', label: 'Problems', path: '/developer/issues', permission: 'developer:console' },
    { key: 'stock-import', label: 'Stock CSV import', path: '/developer/stock-import', permission: 'developer:console' },
    { key: 'service-import', label: 'Procedures / Services import', path: '/developer/service-import', permission: 'developer:console' },
    { key: 'geofence', label: 'Clinic location', path: '/developer/geofence', permission: 'developer:console' },
    { key: 'photos', label: 'Photos', path: '/developer/photos', permission: 'developer:console' },
    { key: 'audit', label: 'Audit & History', path: '/developer/audit', permission: 'audit:search' },
    { key: 'settings', label: 'Settings', path: '/developer/settings', permission: 'settings:manage' },
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
  DEVELOPER: '/developer',
};
