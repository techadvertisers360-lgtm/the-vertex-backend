import { describe, expect, it } from 'vitest';
import { agentFor, call, prisma, uid } from './helpers';

/** D-060 — procedure / service list: developer CSV import, Reception views, adds, edits and hides. */

describe('D-060 — Procedures & Services list', () => {
  it('developer imports the CSV; entries join the booking catalogue; re-import changes nothing', async () => {
    const dev = call((await agentFor('DEVELOPER')).agent);
    const t = uid();
    const csv = `Category,Procedure / Service,Source,Note\nFacials,Glow Facial ${t},In-house,45 min\nLaser,Laser Hair ${t},Partner,`;
    const preview = await dev.post('/api/developer/stock-import', { kind: 'SERVICE', csv, dryRun: true });
    expect(preview.body.products).toEqual({ new: 2, updated: 0, same: 0 });
    expect(await prisma.service.count({ where: { name: `Glow Facial ${t}` } })).toBe(0);
    expect((await dev.post('/api/developer/stock-import', { kind: 'SERVICE', csv, dryRun: false })).status).toBe(200);
    expect(await prisma.service.findUniqueOrThrow({ where: { name: `Glow Facial ${t}` } })).toMatchObject({ type: 'PROCEDURE', category: 'Facials', source: 'In-house', note: '45 min', active: true });
    expect((await dev.post('/api/developer/stock-import', { kind: 'SERVICE', csv, dryRun: false })).body.products).toEqual({ new: 0, updated: 0, same: 2 });
  });

  it('Reception lists, adds, edits, hides and restores; other roles cannot', async () => {
    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const t = uid();
    const add = await rec.post('/api/reception/services', { name: `PRP ${t}`, category: 'Hair', source: 'In-house', note: null });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await rec.post('/api/reception/services', { name: `PRP ${t}` })).status).toBe(409);
    const id = add.body.id as string;
    expect((await rec.patch(`/api/reception/services/${id}`, { note: '3 sessions', source: null })).status).toBe(200);
    const list = await rec.get('/api/reception/services');
    expect(list.body.items.find((s: { id: string }) => s.id === id)).toMatchObject({ name: `PRP ${t}`, category: 'Hair', source: null, note: '3 sessions' });
    expect((await rec.patch(`/api/reception/services/${id}`, { active: false })).status).toBe(200);
    expect((await prisma.service.findUniqueOrThrow({ where: { id } })).active).toBe(false);
    expect((await rec.patch(`/api/reception/services/${id}`, { active: true })).status).toBe(200);
    for (const role of ['DOCTOR', 'ASSISTANT', 'OFFICE_BOY'] as const) expect((await call((await agentFor(role)).agent).get('/api/reception/services')).status).toBe(403);
  });
});
