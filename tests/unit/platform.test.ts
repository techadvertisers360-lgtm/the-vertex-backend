import { describe, expect, it } from 'vitest';
import { withCaCert, withPoolLimit } from '../../src/lib/prisma';

describe('D-042 — Aiven CA from an environment variable', () => {
  it('points sslcert at the written CA file and forces strict verification, keeping other params', () => {
    expect(withCaCert('mysql://u:p@h:13889/db', '/tmp/ca.pem')).toBe('mysql://u:p@h:13889/db?sslcert=/tmp/ca.pem&sslaccept=strict');
    expect(withCaCert('mysql://u:p@h/db?sslcert=../secrets/aiven-ca.pem&sslaccept=accept_invalid_certs&connection_limit=5', '/tmp/ca.pem')).toBe(
      'mysql://u:p@h/db?connection_limit=5&sslcert=/tmp/ca.pem&sslaccept=strict',
    );
  });
});

describe('D-047 — serverless connection pool cap', () => {
  it('adds connection_limit once and keeps an explicit one', () => {
    expect(withPoolLimit('mysql://u:p@h/db', 3)).toBe('mysql://u:p@h/db?connection_limit=3&pool_timeout=20');
    expect(withPoolLimit('mysql://u:p@h/db?ssl-mode=REQUIRED', 3)).toBe('mysql://u:p@h/db?ssl-mode=REQUIRED&connection_limit=3&pool_timeout=20');
    expect(withPoolLimit('mysql://u:p@h/db?connection_limit=7', 3)).toBe('mysql://u:p@h/db?connection_limit=7');
  });
});
