import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { agentFor, call, makeUser, prisma, uid, uniquePhone } from './helpers';

/** D-078 — Patient Records: Manager and MD see every patient and the full history; nobody else. */
let manager: ReturnType<typeof call>;
let md: ReturnType<typeof call>;
let patientId: string;
let name: string;

beforeAll(async () => {
  const m = await agentFor('MANAGER');
  manager = call(m.agent);
  md = call((await agentFor('MD')).agent);
  const doctor = await makeUser('DOCTOR');
  name = `Record Patient ${uid()}`;
  const p = await prisma.patient.create({ data: { name, phone: normalizePhone(uniquePhone())!, createdById: m.user.id } });
  patientId = p.id;
  const start = new Date(Date.now() - 3 * 86_400_000);
  for (const [i, status] of (['DONE', 'CANCELLED'] as const).entries()) {
    await prisma.appointment.create({
      data: { patientId: p.id, doctorId: doctor.id, type: 'CONSULTATION', startAt: new Date(start.getTime() + i * 86_400_000), endAt: new Date(start.getTime() + i * 86_400_000 + 1_200_000), status, source: 'RECEPTION', createdById: m.user.id },
    });
  }
});

describe('D-078 — patient records', () => {
  it('Manager searches every patient and opens the full history (cancelled visits included); the view is audited', async () => {
    const list = await manager.get(`/api/patient-records?q=${encodeURIComponent(name)}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: patientId, visits: 1 })]);

    const rec = await manager.get(`/api/patient-records/${patientId}`);
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.visits).toHaveLength(2);
    expect(rec.body.summary).toMatchObject({ visits: 1, cancelled: 1 });
    expect(rec.body.visits[0].doctorName).toBeTruthy();
    expect(await prisma.auditEvent.count({ where: { action: 'PATIENT_RECORD_VIEWED', recordId: patientId } })).toBeGreaterThan(0);
  });

  it('MD can open it; Reception, Doctor and Office Boy cannot', async () => {
    expect((await md.get(`/api/patient-records/${patientId}`)).status).toBe(200);
    for (const role of ['RECEPTIONIST', 'DOCTOR', 'OFFICE_BOY'] as const) {
      const c = call((await agentFor(role)).agent);
      expect((await c.get('/api/patient-records')).status).toBe(403);
      expect((await c.get(`/api/patient-records/${patientId}`)).status).toBe(403);
    }
  });
});
