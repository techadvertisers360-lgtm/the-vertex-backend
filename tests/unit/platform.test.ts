import { describe, expect, it } from 'vitest';
import { withCaCert } from '../../src/lib/prisma';

describe('D-042 — Aiven CA from an environment variable', () => {
  it('points sslcert at the written CA file and forces strict verification, keeping other params', () => {
    expect(withCaCert('mysql://u:p@h:13889/db', '/tmp/ca.pem')).toBe('mysql://u:p@h:13889/db?sslcert=/tmp/ca.pem&sslaccept=strict');
    expect(withCaCert('mysql://u:p@h/db?sslcert=../secrets/aiven-ca.pem&sslaccept=accept_invalid_certs&connection_limit=5', '/tmp/ca.pem')).toBe(
      'mysql://u:p@h/db?connection_limit=5&sslcert=/tmp/ca.pem&sslaccept=strict',
    );
  });
});
