import { parseArgs } from 'node:util';
import { findRepoRoot } from '../src/root.ts';
import { type PackageKind, writeScaffold } from '../src/scaffold.ts';

const usage = 'usage: pnpm scaffold <pure|rn|module> <name>\n';
const { positionals } = parseArgs({ allowPositionals: true });
const [kind, name] = positionals;

if (!kind || !name) {
  process.stderr.write(usage);
  process.exit(2);
}

try {
  const written = writeScaffold(findRepoRoot(process.cwd()), { kind: kind as PackageKind, name });
  process.stdout.write(`${written.join('\n')}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
  process.exit(1);
}
