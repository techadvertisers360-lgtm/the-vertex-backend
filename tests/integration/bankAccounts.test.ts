import { describe, expect, it } from 'vitest';
import { agentFor, call, uid } from './helpers';

/** D-080 — Manager / MD manage clinic bank accounts; Reception sees only the active ones. */
describe('D-080 — bank accounts', () => {
  it('Manager adds and edits, MD turns one off; Reception lists only active accounts and cannot manage them', async () => {
    const manager = call((await agentFor('MANAGER')).agent);
    const md = call((await agentFor('MD')).agent);
    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const title = `Vertex ${uid()}`;

    expect((await manager.post('/api/bank-accounts', { name: title, bankName: 'Meezan', accountNo: '12' })).status).toBe(400);
    const created = await manager.post('/api/bank-accounts', { name: title, bankName: 'Meezan Bank', accountNo: 'PK36MEZN0001' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;
    expect((await manager.patch(`/api/bank-accounts/${id}`, { bankName: 'Meezan Bank Ltd' })).body).toMatchObject({ bankName: 'Meezan Bank Ltd', active: true });
    expect((await rec.get('/api/reception/bank-accounts')).body.items.some((b: { id: string }) => b.id === id)).toBe(true);

    expect((await md.patch(`/api/bank-accounts/${id}`, { active: false })).body).toMatchObject({ active: false });
    expect((await rec.get('/api/reception/bank-accounts')).body.items.some((b: { id: string }) => b.id === id)).toBe(false);
    expect((await md.get('/api/bank-accounts')).body.items.some((b: { id: string }) => b.id === id)).toBe(true);

    expect((await rec.get('/api/bank-accounts')).status).toBe(403);
    expect((await rec.post('/api/bank-accounts', { name: 'X Y', bankName: 'HBL', accountNo: '123456' })).status).toBe(403);
  });
});
