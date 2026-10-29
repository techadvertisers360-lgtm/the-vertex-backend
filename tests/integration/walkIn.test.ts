import { beforeAll, describe, expect, it } from 'vitest';
import { clinicDateStr, dateOnly } from '../../src/lib/time';
import { normalizePhone } from '../../src/lib/phone';
import { daySlots } from '../../src/services/scheduling';
import { agentFor, call, ensureRooms, freeRoomsFrom, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

/** D-075 — Reception walk-in desk: consultation / procedure with the Doctor, or a procedure done by an Assistant. */

let rec: ReturnType<typeof call>;
let receptionistId: string;

/** A Doctor working the whole clinic day, so the test does not depend on the hour it runs. */
async function allDayDoctor() {
  const doctor = await makeUser('DOCTOR');
  for (let weekday = 1; weekday <= 7; weekday++) {
    await prisma.doctorSchedule.create({ data: { doctorId: doctor.id, weekday, startMinute: 0, endMinute: 23 * 60 + 50, effectiveFrom: dateOnly('2026-01-01'), createdById: doctor.id } });
  }
  return doctor;
}

async function newPatient() {
  return prisma.patient.create({ data: { name: 'Walk-in Patient', phone: normalizePhone(uniquePhone())!, createdById: receptionistId } });
}

beforeAll(async () => {
  await ensureRooms();
  const r = await agentFor('RECEPTIONIST');
  rec = call(r.agent);
  receptionistId = r.user.id;
});

describe('D-075 — walk-in desk', () => {
  it('consultation: booked at the earliest free slot today and checked in; a retry replays', async () => {
    await freeRoomsFrom(new Date(Date.now() - 24 * 3600_000));
    const doctor = await allDayDoctor();
    const p = await newPatient();
    const key = newKey();
    const body = { patientId: p.id, intent: 'CONSULTATION', doctorId: doctor.id };
    const res = await rec.post('/api/reception/walk-in', body, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.appointment).toMatchObject({ status: 'CHECKED_IN', type: 'CONSULTATION', doctorId: doctor.id });
    expect(clinicDateStr(new Date(res.body.appointment.startAt))).toBe(clinicDateStr(new Date()));
    expect(res.body.planItemId).toBeNull();
    expect((await rec.post('/api/reception/walk-in', body, key)).body.appointment.id).toBe(res.body.appointment.id);
    expect(await prisma.appointment.count({ where: { patientId: p.id } })).toBe(1);
  });

  it('procedure by an Assistant: patient at Reception, one-line plan at the typed price, Doctor calendar stays free; invoice from it', async () => {
    const doctor = await allDayDoctor();
    const p = await newPatient();
    const svc = await prisma.service.create({ data: { name: `Hydra ${uid()}`, type: 'PROCEDURE', defaultPricePaisa: 500_000n, durationMin: 60 } });
    const before = (await daySlots({ doctorId: doctor.id, type: 'CONSULTATION', date: clinicDateStr(new Date()) })).slots.length;

    const res = await rec.post('/api/reception/walk-in', { patientId: p.id, intent: 'PROCEDURE_ASSISTANT', doctorId: doctor.id, serviceId: svc.id, pricePaisa: 450_000 }, newKey());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.appointment).toMatchObject({ status: 'RECEPTION', type: 'PROCEDURE' });
    expect(res.body.planItemId).toBeTruthy();
    const item = await prisma.treatmentPlanItem.findUniqueOrThrow({ where: { id: res.body.planItemId } });
    expect(item).toMatchObject({ sameDay: true, pricePaisa: 450_000n, procedureName: svc.name, status: 'PLANNED' });

    // waits for an Assistant + room like any same-day procedure
    const pending = await rec.get('/api/reception/procedures/pending');
    expect(pending.body.items.some((i: { planItemId: string }) => i.planItemId === item.id)).toBe(true);
    // the Doctor of record lost no consultation time
    expect((await daySlots({ doctorId: doctor.id, type: 'CONSULTATION', date: clinicDateStr(new Date()) })).slots.length).toBe(before);

    const inv = await rec.post(`/api/reception/appointments/${res.body.appointment.id}/invoice`);
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ totalPaisa: 450_000 });
  });

  it('procedure needs a service; Office Boy cannot use the desk', async () => {
    const doctor = await allDayDoctor();
    const p = await newPatient();
    expect((await rec.post('/api/reception/walk-in', { patientId: p.id, intent: 'PROCEDURE_ASSISTANT', doctorId: doctor.id }, newKey())).status).toBe(400);
    const office = call((await agentFor('OFFICE_BOY')).agent);
    expect((await office.post('/api/reception/walk-in', { patientId: p.id, intent: 'CONSULTATION', doctorId: doctor.id }, newKey())).status).toBe(403);
  });
});
