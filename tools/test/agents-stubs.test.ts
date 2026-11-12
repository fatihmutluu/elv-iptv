import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAgentsStubs } from '../src/agents-stubs.ts';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'elv_stubs_'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('checkAgentsStubs', () => {
  it('passes when every AGENTS.md has an exact CLAUDE.md stub', () => {
    const root = tree({
      'AGENTS.md': '# root\n',
      'CLAUDE.md': '@AGENTS.md\n',
      'tools/AGENTS.md': '# tools\n',
      'tools/CLAUDE.md': '@AGENTS.md\r\n',
    });
    expect(checkAgentsStubs(root)).toEqual([]);
  });

  it('reports a missing CLAUDE.md', () => {
    const root = tree({ 'tools/AGENTS.md': '# tools\n' });
    expect(checkAgentsStubs(root)).toEqual([expect.stringContaining('tools/CLAUDE.md')]);
  });

  it('reports a stub with extra content', () => {
    const root = tree({ 'tools/AGENTS.md': '# t\n', 'tools/CLAUDE.md': '@AGENTS.md\nmore\n' });
    expect(checkAgentsStubs(root)).toHaveLength(1);
  });

  it('allows the root CLAUDE.md to hold more as long as it imports AGENTS.md', () => {
    const ok = tree({ 'AGENTS.md': '# r\n', 'CLAUDE.md': '@AGENTS.md\n\n## Claude\nextra\n' });
    expect(checkAgentsStubs(ok)).toEqual([]);
    const bad = tree({ 'AGENTS.md': '# r\n', 'CLAUDE.md': 'no import here\n' });
    expect(checkAgentsStubs(bad)).toEqual([expect.stringContaining('CLAUDE.md')]);
  });

  it('reports a CLAUDE.md without an AGENTS.md next to it', () => {
    const root = tree({ 'packages/x/CLAUDE.md': '@AGENTS.md\n' });
    expect(checkAgentsStubs(root)).toEqual([expect.stringContaining('packages/x/AGENTS.md')]);
  });

  it('ignores node_modules and hidden tool folders', () => {
    const root = tree({
      'node_modules/p/AGENTS.md': '# x\n',
      '.git/AGENTS.md': '# x\n',
      '.claude/worktrees/w/AGENTS.md': '# x\n',
    });
    expect(checkAgentsStubs(root)).toEqual([]);
  });

  it('enforces the 50 line cap on non-root AGENTS.md files', () => {
    const root = tree({
      'tools/AGENTS.md': `${Array(51).fill('l').join('\n')}\n`,
      'tools/CLAUDE.md': '@AGENTS.md\n',
    });
    expect(checkAgentsStubs(root)).toEqual([expect.stringContaining('50')]);
  });
});
