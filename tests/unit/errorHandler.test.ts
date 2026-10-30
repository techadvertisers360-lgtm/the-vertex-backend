import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { endpointKey, isDbBusy } from '../../src/middleware/error';

describe('server error alerts', () => {
  it('groups errors raised before a route matched by endpoint, not by record id', () => {
    expect(endpointKey('GET', '/api/files', undefined, '/cmvfg4zm7000kjm07iwonm7bo/url')).toBe('GET /api/files/:id/url');
    expect(endpointKey('GET', '/api/files', undefined, '/cmvh1si7h000al007iuyhgiii/url')).toBe('GET /api/files/:id/url');
    expect(endpointKey('GET', '/api/developer', undefined, '/photos')).toBe('GET /api/developer/photos');
    expect(endpointKey('GET', '/api/files', '/:id/content', '/abc/content')).toBe('GET /api/files/:id/content');
  });

  it('treats "too many connections" / unreachable database as temporary', () => {
    expect(isDbBusy(new Error('Invalid `prisma.session.findUnique()` invocation: Too many database connections opened: ERROR HY000 (1040): Too many connections'))).toBe(true);
    expect(isDbBusy(new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: 'x' }))).toBe(true);
    expect(isDbBusy(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }))).toBe(false);
    expect(isDbBusy(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
