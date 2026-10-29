import { describe, expect, it } from 'vitest';
import { agentFor, call, makeUser, prisma, uid } from './helpers';

/** D-072 — the developer sees every uploaded photo and may open / download each one; nobody else gets the list. */
describe('D-072 — developer photo gallery', () => {
  it('lists images only (newest first, filter by type), opens any of them; other roles are refused', async () => {
    const assistant = await makeUser('ASSISTANT');
    const t = uid();
    const before = await prisma.attachment.create({
      data: { fileKey: `dev_${t}_1`, route: 'beforePhoto', fileName: `before-${t}.jpg`, mime: 'image/jpeg', size: 100, isPrivate: true, uploadedById: assistant.id, recordType: 'ProcedureTask', recordId: `task-${t}` },
    });
    const room = await prisma.attachment.create({
      data: { fileKey: `dev_${t}_2`, route: 'roomCleanPhoto', fileName: `room-${t}.png`, mime: 'image/png', size: 100, isPrivate: true, uploadedById: assistant.id, recordType: 'RoomAssignment', recordId: `room-${t}` },
    });
    const pdf = await prisma.attachment.create({
      data: { fileKey: `dev_${t}_3`, route: 'consentForm', fileName: `consent-${t}.pdf`, mime: 'application/pdf', size: 100, isPrivate: true, uploadedById: assistant.id, recordType: 'ProcedureTask', recordId: `task-${t}` },
    });

    const dev = call((await agentFor('DEVELOPER')).agent);
    const all = await dev.get('/api/developer/photos?limit=200');
    expect(all.status).toBe(200);
    const ids = all.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([before.id, room.id]));
    expect(ids).not.toContain(pdf.id);
    expect(ids.indexOf(room.id)).toBeLessThan(ids.indexOf(before.id));
    expect(all.body.items.find((i: { id: string }) => i.id === room.id)).toMatchObject({ uploadedBy: assistant.displayName, uploadedByRole: 'ASSISTANT' });

    const onlyBefore = await dev.get('/api/developer/photos?route=beforePhoto&limit=200');
    expect(onlyBefore.body.items.every((i: { route: string }) => i.route === 'beforePhoto')).toBe(true);

    // a clinical photo outside every other scope is readable by the developer (dev stub → no bytes, but authorized)
    expect((await dev.get(`/api/files/${before.id}/url`)).body).toMatchObject({ mode: 'stub' });

    const mgr = call((await agentFor('MANAGER')).agent);
    expect((await mgr.get('/api/developer/photos')).status).toBe(403);
  });
});
