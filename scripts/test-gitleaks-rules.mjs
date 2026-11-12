// Standalone checks for the Xtream credential shapes in .gitleaks.toml.
// Usage: node scripts/test-gitleaks-rules.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.gitleaks.toml');

if (spawnSync('gitleaks', ['version']).error) {
  console.log('SKIP: gitleaks is not on PATH');
  process.exit(0);
}

const cases = [
  ['port path without /live/', 'http://h.example:8080/zq8sample/Qm47tLw9/12345\n', 1],
  ['query, password first', 'get.php?password=Qm47tLw9&username=zq8sample\n', 1],
  ['query, upper case', 'get.php?USERNAME=zq8sample&PASSWORD=Qm47tLw9\n', 1],
  ['json, username first', '{"username":"zq8sample","password":"Qm47tLw9"}\n', 1],
  ['json, password first', '{"password":"Qm47tLw9","username":"zq8sample"}\n', 1],
  ['live path', 'http://h.example:8080/live/zq8sample/Qm47tLw9/1.ts\n', 1],
  ['placeholder port path', 'http://h.example:8080/username/password/12345\n', 0],
  ['placeholder query', 'get.php?password=example&username=demo\n', 0],
  ['placeholder json', '{"username":"user","password":"pass"}\n', 0],
  ['placeholder json reversed', '{"password":"test","username":"demo"}\n', 0],
  ['documented fake sample', 'http://h.example:8080/realuser1/Xk92pQ7z/12345\n', 0],
  ['ordinary cdn url', 'https://cdn.example.com:443/images/logo/123\n', 0],
  ['ordinary docs url', 'http://localhost:3000/docs/guide/1\n', 0],
  ['ordinary asset url', 'http://localhost:8080/static/assets/2024\n', 0],
  ['versioned api url', 'http://localhost:8080/api/v2/42\n', 0],
];

let failed = 0;
for (const [name, content, expected] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'elv_leaks_'));
  try {
    writeFileSync(join(dir, 'sample.txt'), content);
    const r = spawnSync('gitleaks',
      ['dir', dir, '--config', config, '--no-banner', '--redact', '--exit-code', '1']);
    const ok = r.status === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} (exit ${r.status}, expected ${expected})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
