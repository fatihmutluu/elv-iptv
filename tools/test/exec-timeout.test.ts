import { describe, expect, it } from 'vitest';
import { exec } from '../src/exec.ts';

describe('exec timeout', () => {
  it('kills a hung command and reports the timeout', async () => {
    const started = Date.now();
    const result = await exec('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: process.cwd(),
      timeoutMs: 400,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.output).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('leaves a command that finishes in time alone', async () => {
    const result = await exec('node', ['-e', 'console.log("hi")'], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.timedOut).toBeUndefined();
    expect(result.output).toContain('hi');
  });
});
