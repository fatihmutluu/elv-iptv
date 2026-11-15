import { parseArgs } from 'node:util';
import {
  NOTICES_OUTPUT_REL,
  verifyNoticesFile,
  writeNoticesFile,
} from '../src/notices/generate.ts';
import { findRepoRoot } from '../src/root.ts';

const USAGE = 'usage: node tools/bin/notices.ts [--write] [--check]';

let values: { write?: boolean | undefined; check?: boolean | undefined };
try {
  ({ values } = parseArgs({
    options: {
      write: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const root = findRepoRoot(process.cwd());

if (values.write) {
  writeNoticesFile(root);
  process.stdout.write(`notices: wrote ${NOTICES_OUTPUT_REL}\n`);
} else {
  const result = verifyNoticesFile(root);
  if (!result.ok) {
    for (const err of result.errors) {
      process.stderr.write(`FAIL notices: ${err}\n`);
    }
    process.exitCode = 1;
  } else if (values.check) {
    process.stdout.write(`notices: ${NOTICES_OUTPUT_REL} is up to date\n`);
  }
}
