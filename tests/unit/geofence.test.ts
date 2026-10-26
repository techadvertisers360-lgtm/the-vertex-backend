import { describe, expect, it } from 'vitest';
import { distanceM, normalizeIp, parseIps } from '../../src/services/geofence';

describe('Clinic geofence — pure helpers (D-062)', () => {
  const clinic = { lat: 31.5020747, lng: 74.4335575 };

  it('measures distance in metres', () => {
    expect(distanceM(clinic, clinic)).toBe(0);
    // 0.001 degrees of latitude is about 111 m
    const d = distanceM(clinic, { lat: clinic.lat + 0.001, lng: clinic.lng });
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(115);
    // Lahore to Karachi is roughly 1,030 km
    expect(distanceM(clinic, { lat: 24.8607, lng: 67.0011 }) / 1000).toBeGreaterThan(1000);
  });

  it('parses the allowed IP list and treats IPv4-mapped IPv6 as IPv4', () => {
    expect(parseIps(' 203.0.113.5,\n::ffff:198.51.100.7  203.0.113.5 ')).toEqual(['203.0.113.5', '198.51.100.7']);
    expect(parseIps(null)).toEqual([]);
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });
});
