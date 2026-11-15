import { createRequire } from 'node:module';
import path from 'node:path';
import type { XcodeProject } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';
import {
  AETHER_EMBED_PHASE,
  aetherEmbedScriptPath,
  applyAetherFrameworks,
  applyAetherPodfile,
} from './with-aether-frameworks.ts';

const require = createRequire(import.meta.url);
const xcode = require('xcode') as { project(filePath: string): { parseSync(): XcodeProject } };
const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'tvos.pbxproj');
const APP_ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = '../../../modules/engine-aether/ios/embed-frameworks.sh';
const EXCLUDED = '"EXCLUDED_ARCHS[sdk=appletvsimulator*]"';

type Objects = Record<string, Record<string, unknown>>;

function parse(): XcodeProject {
  return xcode.project(FIXTURE).parseSync() as XcodeProject;
}

function section(project: XcodeProject, isa: string): Objects {
  const objects = (project.hash as { project: { objects: Record<string, Objects> } }).project
    .objects;
  const out: Objects = {};
  for (const [key, value] of Object.entries(objects[isa] ?? {})) {
    if (!key.endsWith('_comment') && typeof value === 'object') out[key] = value;
  }
  return out;
}

function appTarget(project: XcodeProject): {
  buildPhases: { value: string; comment: string }[];
  buildConfigurationList: string;
} {
  const target = project.getFirstTarget().firstTarget as unknown;
  return target as {
    buildPhases: { value: string; comment: string }[];
    buildConfigurationList: string;
  };
}

function appConfigurations(project: XcodeProject): string[] {
  const lists = section(project, 'XCConfigurationList');
  const list = lists[appTarget(project).buildConfigurationList] as {
    buildConfigurations: { value: string }[];
  };
  return list.buildConfigurations.map((c) => c.value);
}

function unquote(value: unknown): string {
  return JSON.parse(String(value)) as string;
}

describe('withAetherFrameworks', () => {
  it('adds one embed phase as the app target last build phase, also when run twice', () => {
    const project = parse();
    applyAetherFrameworks(project, SCRIPT);
    applyAetherFrameworks(project, SCRIPT);
    const phases = appTarget(project).buildPhases;
    const shell = section(project, 'PBXShellScriptBuildPhase');
    const embeds = phases.filter(
      (p) => unquote(shell[p.value]?.name ?? '""') === AETHER_EMBED_PHASE,
    );
    expect(embeds).toHaveLength(1);
    expect(phases.at(-1)?.value).toBe(embeds[0]?.value);
  });

  it('runs the module script relative to SRCROOT on every build without dependency warnings', () => {
    const project = parse();
    applyAetherFrameworks(project, SCRIPT);
    const shell = section(project, 'PBXShellScriptBuildPhase');
    const phase = Object.values(shell).find((p) => unquote(p.name ?? '""') === AETHER_EMBED_PHASE);
    expect(unquote(phase?.shellScript)).toBe(`/bin/sh "\${SRCROOT}/${SCRIPT}"`);
    expect(phase?.alwaysOutOfDate).toBe(1);
    expect(aetherEmbedScriptPath(APP_ROOT).replaceAll('\\', '/')).toMatch(
      /\/modules\/engine-aether\/ios\/embed-frameworks\.sh$/,
    );
  });

  it('excludes x86_64 for the Apple TV simulator in every configuration of the app target', () => {
    const project = parse();
    applyAetherFrameworks(project, SCRIPT);
    const configs = section(project, 'XCBuildConfiguration');
    const app = appConfigurations(project);
    expect(app.length).toBeGreaterThanOrEqual(2);
    for (const id of app) {
      const settings = (configs[id]?.buildSettings ?? {}) as Record<string, unknown>;
      expect(settings[EXCLUDED]).toBe('x86_64');
    }
    for (const [id, config] of Object.entries(configs)) {
      if (app.includes(id)) continue;
      expect(config.buildSettings as Record<string, unknown>).not.toHaveProperty(EXCLUDED);
    }
  });

  it('adds one post_integrate hook to keep the embed phase last after pod install', () => {
    const podfile = "target 'ELVIPTV' do\n  use_expo_modules!\nend\n";
    const once = applyAetherPodfile(podfile);
    const twice = applyAetherPodfile(once);
    expect(twice).toBe(once);
    expect(once).toContain('post_integrate do |installer|');
    expect(once).toContain(AETHER_EMBED_PHASE);
  });
});
