import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { agentFor, call, makeUser, prisma, uniquePhone } from './helpers';

/** D-081 — upcoming appointments: Reception sees every Doctor's, a Doctor only their own (no phone). */
describe('D-081 — upcoming appointments', () => {
  it('lists confirmed future bookings; Reception all Doctors with phone, Doctor only own without phone', async () => {
    const r = await agentFor('RECEPTIONIST');
    const rec = call(r.agent);
    const d1 = await agentFor('DOCTOR');
    const d2 = await makeUser('DOCTOR');
    const p = await prisma.patient.create({ data: { name: 'Upcoming Patient', phone: normalizePhone(uniquePhone())!, createdById: r.user.id } });
    const at = (days: number) => new Date(Date.now() + days * 86_400_000);
    const mk = (doctorId: string, days: number, status: 'CONFIRMED' | 'CANCELLED') =>
      prisma.appointment.create({ data: { patientId: p.id, doctorId, type: 'CONSULTATION', startAt: at(days), endAt: new Date(at(days).getTime() + 1_200_000), status, source: 'RECEPTION', createdById: r.user.id } });
    const mine = await mk(d1.user.id, 2, 'CONFIRMED');
    const other = await mk(d2.id, 3, 'CONFIRMED');
    const cancelled = await mk(d1.user.id, 2, 'CANCELLED');
    const far = await mk(d1.user.id, 20, 'CONFIRMED');

    const all = await rec.get('/api/reception/upcoming-appointments?days=7');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const ids = all.body.items.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining([mine.id, other.id]));
    expect(ids).not.toContain(cancelled.id);
    expect(ids).not.toContain(far.id);
    expect(all.body.items.find((a: { id: string }) => a.id === mine.id).patient.phone).toBe(p.phone);

    const doc = await call(d1.agent).get('/api/doctor/upcoming?days=30');
    expect(doc.status).toBe(200);
    const docIds = doc.body.items.map((a: { id: string }) => a.id);
    expect(docIds).toEqual(expect.arrayContaining([mine.id, far.id]));
    expect(docIds).not.toContain(other.id);
    expect(doc.body.items[0].patient.phone).toBeUndefined();

    expect((await call((await agentFor('OFFICE_BOY')).agent).get('/api/reception/upcoming-appointments')).status).toBe(403);
  });
});
