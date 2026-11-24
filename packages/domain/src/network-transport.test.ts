import { describe, expect, it } from 'vitest';
import {
  ipLiteralFamily,
  isValidIpv4Literal,
  isValidIpv6Literal,
  normalizeDnsFamily,
  validateHostOverride,
} from './network-transport';

describe('network-transport (#172)', () => {
  it('normalizes DNS family preferences case-insensitively and drops invalid values', () => {
    expect(normalizeDnsFamily('system')).toBe('system');
    expect(normalizeDnsFamily(' IPv4 ')).toBe('ipv4');
    expect(normalizeDnsFamily('IPV6')).toBe('ipv6');
    expect(normalizeDnsFamily('auto')).toBeUndefined();
    expect(normalizeDnsFamily('')).toBeUndefined();
    expect(normalizeDnsFamily(4)).toBeUndefined();
  });

  it('validates IPv4 literals strictly', () => {
    expect(isValidIpv4Literal('203.0.113.10')).toBe(true);
    expect(isValidIpv4Literal('0.0.0.0')).toBe(true);
    expect(isValidIpv4Literal('255.255.255.255')).toBe(true);
    expect(isValidIpv4Literal('256.0.0.1')).toBe(false);
    expect(isValidIpv4Literal('01.2.3.4')).toBe(false);
    expect(isValidIpv4Literal('1.2.3')).toBe(false);
    expect(isValidIpv4Literal('1.2.3.4:8080')).toBe(false);
    expect(isValidIpv4Literal('example.com')).toBe(false);
  });

  it('validates IPv6 literals strictly including compressed and IPv4-mapped forms', () => {
    expect(isValidIpv6Literal('::1')).toBe(true);
    expect(isValidIpv6Literal('::')).toBe(true);
    expect(isValidIpv6Literal('2001:db8::1')).toBe(true);
    expect(isValidIpv6Literal('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
    expect(isValidIpv6Literal('::ffff:192.0.2.128')).toBe(true);
    expect(isValidIpv6Literal('2001:db8:::1')).toBe(false);
    expect(isValidIpv6Literal('2001:db8::1::2')).toBe(false);
    expect(isValidIpv6Literal('fe80::1%eth0')).toBe(false);
    expect(isValidIpv6Literal('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isValidIpv6Literal('1:2:3:4:5:6:7')).toBe(false);
    expect(isValidIpv6Literal('2001:db8::g1')).toBe(false);
    expect(isValidIpv6Literal('1:2:3:4:5:6:7::8')).toBe(false);
  });

  it('validates and normalizes hostOverride values safely', () => {
    expect(validateHostOverride(undefined)).toEqual({ ok: true, value: undefined });
    expect(validateHostOverride('')).toEqual({ ok: true, value: undefined });
    expect(validateHostOverride('   ')).toEqual({ ok: true, value: undefined });
    expect(validateHostOverride(' 198.51.100.42 ')).toEqual({ ok: true, value: '198.51.100.42' });
    expect(validateHostOverride('[2001:DB8::1]')).toEqual({ ok: true, value: '2001:db8::1' });
    expect(validateHostOverride('2001:DB8::CAFE')).toEqual({ ok: true, value: '2001:db8::cafe' });

    for (const bad of [
      'panel.example.test',
      'https://198.51.100.42',
      '198.51.100.42:8080',
      '198.51.100.42/live',
      '198.51.100.42\r\nHost: evil',
      'fe80::1%lo0',
      123,
    ]) {
      const r = validateHostOverride(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.category).toBe('source-format');
        expect(r.error.code).toBe('invalid-host-override');
      }
    }
  });

  it('identifies IP literal family accurately', () => {
    expect(ipLiteralFamily('198.51.100.1')).toBe(4);
    expect(ipLiteralFamily('2001:db8::1')).toBe(6);
    expect(ipLiteralFamily('example.test')).toBeUndefined();
  });
});
