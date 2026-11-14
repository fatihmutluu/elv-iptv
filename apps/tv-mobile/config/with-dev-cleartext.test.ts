import { describe, expect, it } from 'vitest';
import {
  DEV_CLEARTEXT_HOSTS,
  networkSecurityConfigXml,
  setNetworkSecurityConfig,
} from './with-dev-cleartext';

describe('networkSecurityConfigXml', () => {
  it('allows cleartext for the listed hosts only', () => {
    const xml = networkSecurityConfigXml(['10.0.2.2', 'localhost']);
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false"');
    expect(xml).toContain('<domain includeSubdomains="false">10.0.2.2</domain>');
    expect(xml).toContain('<domain includeSubdomains="false">localhost</domain>');
    expect(xml.match(/cleartextTrafficPermitted="true"/g)).toHaveLength(1);
  });

  it('escapes markup in a host', () => {
    expect(networkSecurityConfigXml(['a<b'])).toContain('a&lt;b');
  });
});

describe('DEV_CLEARTEXT_HOSTS', () => {
  it('is the emulator host alias and the loopbacks', () => {
    expect(DEV_CLEARTEXT_HOSTS).toEqual(['10.0.2.2', '127.0.0.1', 'localhost']);
  });
});

describe('setNetworkSecurityConfig', () => {
  it('points the application at the xml resource', () => {
    const manifest = { manifest: { application: [{ $: { 'android:name': '.Main' } }] } };
    setNetworkSecurityConfig(manifest as unknown as Parameters<typeof setNetworkSecurityConfig>[0]);
    expect(manifest.manifest.application[0]?.$).toEqual({
      'android:name': '.Main',
      'android:networkSecurityConfig': '@xml/network_security_config',
    });
  });
});
