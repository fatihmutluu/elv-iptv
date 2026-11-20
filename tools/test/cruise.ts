import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise as depCruise, type ICruiseOptions, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';

const here = dirname(fileURLToPath(import.meta.url));
const config = resolve(here, '..', '..', '.dependency-cruiser.cjs');

let cachedOptions: Promise<ICruiseOptions> | undefined;
function loadOptions(): Promise<ICruiseOptions> {
  cachedOptions ??= extractDepcruiseOptions(config);
  return cachedOptions;
}

/** One dependency-cruiser violation. */
export interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}

/** Cruises `cwd` with the repository's real rule set and returns every violation. */
export async function cruise(cwd: string): Promise<Violation[]> {
  const base = await loadOptions();
  const result = await depCruise(['.'], {
    ...base,
    baseDir: cwd,
    cache: false,
  });
  const report =
    typeof result.output === 'string'
      ? (JSON.parse(result.output) as ICruiseResult)
      : result.output;
  return report.summary.violations;
}
