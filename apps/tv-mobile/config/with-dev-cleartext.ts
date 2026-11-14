import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
  withDangerousMod,
} from 'expo/config-plugins';

/** Hosts the development variant may reach over HTTP: the emulator's alias of the host machine and the loopbacks. */
export const DEV_CLEARTEXT_HOSTS: readonly string[] = ['10.0.2.2', '127.0.0.1', 'localhost'];

const RESOURCE = 'network_security_config';

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Android network security config: cleartext only for `hosts`, everything else stays HTTPS-only. */
export function networkSecurityConfigXml(hosts: readonly string[]): string {
  const domains = hosts
    .map((h) => `    <domain includeSubdomains="false">${escapeXml(h)}</domain>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
${domains}
  </domain-config>
</network-security-config>
`;
}

/** Points the `<application>` element of a parsed manifest at the generated resource. */
export function setNetworkSecurityConfig(manifest: AndroidConfig.Manifest.AndroidManifest): void {
  const application = manifest.manifest.application?.[0];
  if (application !== undefined) {
    application.$['android:networkSecurityConfig'] = `@xml/${RESOURCE}`;
  }
}

/** Config plugin for the development variant only (the caller decides): writes and references the config above. */
export const withDevCleartext: ConfigPlugin<{ hosts: readonly string[] }> = (config, { hosts }) => {
  const withManifest = withAndroidManifest(config, (c) => {
    setNetworkSecurityConfig(c.modResults);
    return c;
  });
  return withDangerousMod(withManifest, [
    'android',
    (c) => {
      const dir = join(c.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${RESOURCE}.xml`), networkSecurityConfigXml(hosts));
      return c;
    },
  ]);
};
