/**
 * Internal WhatsApp templates (spec §20). Each internal key maps to a clinic-approved provider template through the
 * `whatsapp.templates` setting; the variables below are what the provider adapter fills in, in order.
 * `render` gives the readable text for the console provider and the Manager message log — real providers send the
 * approved template, not this text. `sensitive` templates (password reset links) are never shown in the message log.
 */

type Payload = Record<string, unknown>;

export interface TemplateDef {
  label: string;
  audience: 'patient' | 'staff' | 'patient_or_doctor';
  variables: string[];
  sensitive?: boolean;
  render: (p: Payload) => string;
}

const s = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(v));
const rs = (paisa: unknown) => `Rs ${(Number(paisa ?? 0) / 100).toLocaleString('en-PK')}`;

function appointmentText(event: string, p: Payload) {
  const what = `${s(p.type)}${p.service ? ` (${s(p.service)})` : ''}`;
  const room = p.room ? `, Room ${s(p.room)}` : '';
  if (event === 'cancelled') return `${s(p.patientName)}, aap ki ${what} appointment (${s(p.when)}, ${s(p.doctorName)}) cancel ho gayi hai.${p.reason ? ` Wajah: ${s(p.reason)}.` : ''} — ${s(p.location)}`;
  if (event === 'rescheduled')
    return `${s(p.patientName)}, aap ki ${what} appointment ${p.previousWhen ? `${s(p.previousWhen)} se ` : ''}${s(p.when)} par shift ho gayi hai — ${s(p.doctorName)}${room}. ${s(p.location)}`;
  return `${s(p.patientName)}, aap ki ${what} appointment confirm hai: ${s(p.when)} — ${s(p.doctorName)}${room}. ${s(p.location)}`;
}

const APPT_VARS = ['patientName', 'doctorName', 'when', 'type', 'service', 'room', 'location'];

export const TEMPLATES: Record<string, TemplateDef> = {
  appointment_confirmed: { label: 'Appointment confirmed', audience: 'patient_or_doctor', variables: APPT_VARS, render: (p) => appointmentText('confirmed', p) },
  appointment_rescheduled: { label: 'Appointment rescheduled', audience: 'patient_or_doctor', variables: [...APPT_VARS, 'previousWhen'], render: (p) => appointmentText('rescheduled', p) },
  appointment_cancelled: { label: 'Appointment cancelled', audience: 'patient_or_doctor', variables: [...APPT_VARS, 'reason'], render: (p) => appointmentText('cancelled', p) },
  procedure_reminder: {
    label: 'Procedure reminder (2 days before)',
    audience: 'patient_or_doctor',
    variables: ['patientName', 'procedure', 'session', 'when', 'doctorName', 'room', 'location'],
    render: (p) =>
      `Yaad-dihani: ${s(p.patientName)} — ${s(p.procedure)}${p.session ? ` (session ${s(p.session)})` : ''} ${s(p.when)} ko, ${s(p.doctorName)}${p.room ? `, Room ${s(p.room)}` : ''}. ${s(p.location)}`,
  },
  installment_reminder: {
    label: 'Installment reminder',
    audience: 'patient',
    variables: ['patientName', 'invoice', 'installment', 'dueDate', 'amount'],
    render: (p) => `${s(p.patientName)}, invoice ${s(p.invoice)} ki installment #${s(p.installment)} (${rs(p.amountPaisa)}) ${s(p.dueDate)} ko due hai. — The Vertex Health`,
  },
  aftercare: { label: 'Aftercare guidance', audience: 'patient', variables: ['patientName', 'doctorName', 'guidance'], render: (p) => `${s(p.patientName)}, ${s(p.doctorName)} ki hidayat: ${s(p.guidance)}` },
  visit_thanks: {
    label: 'Thank you + feedback',
    audience: 'patient',
    variables: ['patientName', 'feedbackLink'],
    render: (p) => `${s(p.patientName)}, The Vertex Health aane ka shukriya.${p.feedbackLink ? ` Apna feedback dein: ${s(p.feedbackLink)}` : ''}`,
  },
  password_reset: { label: 'Staff password reset', audience: 'staff', variables: ['name', 'link'], sensitive: true, render: (p) => `${s(p.name)}, password reset link (30 min): ${s(p.link)}` },
};

export function templateLabel(key: string): string {
  return TEMPLATES[key]?.label ?? key;
}

/** Readable text of a message, or null for sensitive templates (never shown). */
export function renderMessage(key: string, payload: unknown): string | null {
  const t = TEMPLATES[key];
  if (!t) return null;
  if (t.sensitive) return null;
  return t.render((payload ?? {}) as Payload);
}

/** Variables in the template's declared order, for provider adapters that fill positional template parameters. */
export function templateVariables(key: string, payload: unknown): string[] {
  const t = TEMPLATES[key];
  const p = (payload ?? {}) as Payload;
  return (t?.variables ?? []).map((v) => (v === 'amount' ? rs(p.amountPaisa) : s(p[v])));
}
