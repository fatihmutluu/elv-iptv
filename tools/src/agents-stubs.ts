import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const MAX_AGENTS_LINES = 50;
const MAX_ROOT_AGENTS_LINES = 150;
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'android', 'ios']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name))
      continue;
    const full = join(dir, entry.name);
    yield full;
    yield* walk(full);
  }
}

const rel = (root: string, path: string) => relative(root, path).replace(/\\/g, '/') || '.';

/**
 * Verifies the AGENTS.md convention under `rootDir`: every `AGENTS.md` has a `CLAUDE.md`
 * beside it; in sub-folders that file is exactly `@AGENTS.md` and `AGENTS.md` stays within
 * 50 lines (150 at the root); the root `CLAUDE.md` must import `@AGENTS.md`. Returns one message per problem.
 */
export function checkAgentsStubs(rootDir: string): string[] {
  const problems: string[] = [];
  for (const dir of [rootDir, ...walk(rootDir)]) {
    const isRoot = dir === rootDir;
    const where = (name: string) => (isRoot ? name : `${rel(rootDir, dir)}/${name}`);
    const agents = join(dir, 'AGENTS.md');
    const claude = join(dir, 'CLAUDE.md');
    const hasAgents = existsSync(agents);
    const hasClaude = existsSync(claude);

    if (hasClaude && !hasAgents && !isRoot) {
      problems.push(`${where('CLAUDE.md')} has no ${where('AGENTS.md')} next to it`);
      continue;
    }
    if (!hasAgents) continue;
    const agentsLines = readFileSync(agents, 'utf8').split(/\r?\n/);
    if (agentsLines.at(-1) === '') agentsLines.pop();
    const cap = isRoot ? MAX_ROOT_AGENTS_LINES : MAX_AGENTS_LINES;
    if (agentsLines.length > cap) {
      problems.push(`${where('AGENTS.md')} has ${agentsLines.length} lines (max ${cap})`);
    }
    if (!hasClaude) {
      problems.push(`${where('CLAUDE.md')} is missing; it must import @AGENTS.md`);
      continue;
    }
    const claudeLines = readFileSync(claude, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim());
    if (isRoot) {
      if (!claudeLines.includes('@AGENTS.md')) {
        problems.push(`${where('CLAUDE.md')} must contain a line "@AGENTS.md"`);
      }
    } else if (claudeLines.filter((l) => l !== '').join('\n') !== '@AGENTS.md') {
      problems.push(`${where('CLAUDE.md')} must contain only "@AGENTS.md"`);
    }
  }
  return problems;
}
