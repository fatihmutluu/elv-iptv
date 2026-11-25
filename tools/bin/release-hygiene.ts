import { parseArgs } from 'node:util';
import { runReleaseHygiene } from '../src/release-hygiene.ts';

const USAGE =
  'usage: node tools/bin/release-hygiene.ts [--gradle-deps <file>] [--android-manifest <file>] [--apple-plist <file>] [--apple-privacy-manifest <file>] [--artifact <path>] [--tv]';

let parsed: ReturnType<typeof parseCli>;
function parseCli() {
  return parseArgs({
    args: process.argv.slice(2),
    options: {
      'gradle-deps': { type: 'string', multiple: true },
      'android-manifest': { type: 'string', multiple: true },
      'apple-plist': { type: 'string', multiple: true },
      'apple-privacy-manifest': { type: 'string', multiple: true },
      artifact: { type: 'string', multiple: true },
      tv: { type: 'boolean' },
    },
  });
}

try {
  parsed = parseCli();
} catch (error) {
  process.stderr.write(`release-hygiene: ${(error as Error).message}\n${USAGE}\n`);
  process.exit(2);
}

const { values } = parsed;
const gradleDeps = values['gradle-deps'] ?? [];
const androidManifests = values['android-manifest'] ?? [];
const applePlists = values['apple-plist'] ?? [];
const applePrivacyManifests = values['apple-privacy-manifest'] ?? [];
const artifacts = values.artifact ?? [];

if (
  gradleDeps.length === 0 &&
  androidManifests.length === 0 &&
  applePlists.length === 0 &&
  applePrivacyManifests.length === 0 &&
  artifacts.length === 0
) {
  process.stderr.write(`release-hygiene: specify at least one check target.\n${USAGE}\n`);
  process.exit(2);
}

const result = runReleaseHygiene({
  gradleDeps,
  androidManifests,
  applePlists,
  applePrivacyManifests,
  artifacts,
  tv: values.tv === true,
});

if (!result.ok) {
  for (const err of result.errors) {
    process.stderr.write(`FAIL release-hygiene: ${err}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `release-hygiene: passed (${gradleDeps.length} deps, ${androidManifests.length} manifests, ${applePlists.length} plists, ${applePrivacyManifests.length} privacy manifests, ${artifacts.length} artifact targets)\n`,
);
