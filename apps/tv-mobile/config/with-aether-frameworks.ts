import { createRequire } from 'node:module';
import path from 'node:path';
import {
  type ConfigPlugin,
  withPodfile,
  withXcodeProject,
  type XcodeProject,
} from 'expo/config-plugins';

/** Name of the app target's script phase that copies AetherEngine's dynamic FFmpeg frameworks into the app. */
export const AETHER_EMBED_PHASE = '[ELV] Embed AetherEngine frameworks';

const EXCLUDED_ARCHS_TVOS_SIM = '"EXCLUDED_ARCHS[sdk=appletvsimulator*]"';

type PbxObject = Record<string, unknown>;
interface PhaseRef {
  value: string;
  comment?: string;
}
interface NativeTarget {
  buildPhases: PhaseRef[];
  buildConfigurationList: string;
}

/** Absolute path of `@elv/engine-aether`'s `ios/embed-frameworks.sh`, resolved from the app's project root. */
export function aetherEmbedScriptPath(projectRoot: string): string {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  const pkg = require.resolve('@elv/engine-aether/package.json');
  return path.join(path.dirname(pkg), 'ios', 'embed-frameworks.sh');
}

function objects(project: XcodeProject, isa: string): Record<string, unknown> {
  const all = (project.hash as { project: { objects: Record<string, Record<string, unknown>> } })
    .project.objects;
  all[isa] ??= {};
  return all[isa] as Record<string, unknown>;
}

function removeEmbedPhases(project: XcodeProject, target: NativeTarget): void {
  const shell = objects(project, 'PBXShellScriptBuildPhase');
  target.buildPhases = target.buildPhases.filter((ref) => {
    const phase = shell[ref.value] as PbxObject | undefined;
    const name = typeof phase?.name === 'string' ? phase.name.replaceAll('"', '') : ref.comment;
    if (name !== AETHER_EMBED_PHASE) return true;
    delete shell[ref.value];
    delete shell[`${ref.value}_comment`];
    return false;
  });
}

function excludeTvSimulatorX86(project: XcodeProject, target: NativeTarget): void {
  const lists = objects(project, 'XCConfigurationList');
  const configs = objects(project, 'XCBuildConfiguration');
  const list = lists[target.buildConfigurationList] as { buildConfigurations: PhaseRef[] };
  for (const ref of list.buildConfigurations) {
    const config = configs[ref.value] as { buildSettings: PbxObject };
    config.buildSettings[EXCLUDED_ARCHS_TVOS_SIM] = 'x86_64';
  }
}

/**
 * Makes the app target embed and sign AetherEngine's dynamic frameworks (React Native's `spm_dependency` links them
 * but embeds nothing) through one script phase, appended last and replaced when run again, and excludes x86_64 from
 * Apple TV simulator builds (LibDovi ships no x86_64 tvOS simulator slice). `scriptFromSrcRoot` is relative to `ios/`.
 */
export function applyAetherFrameworks(project: XcodeProject, scriptFromSrcRoot: string): void {
  const { uuid, firstTarget } = project.getFirstTarget();
  const target = firstTarget as unknown as NativeTarget;
  removeEmbedPhases(project, target);
  const added = project.addBuildPhase([], 'PBXShellScriptBuildPhase', AETHER_EMBED_PHASE, uuid, {
    shellPath: '/bin/sh',
    shellScript: `/bin/sh "\${SRCROOT}/${scriptFromSrcRoot}"`,
    inputPaths: [],
    outputPaths: [],
  }) as { uuid: string };
  const shell = objects(project, 'PBXShellScriptBuildPhase');
  const phase = shell[added.uuid] as PbxObject | undefined;
  if (phase !== undefined) {
    phase.alwaysOutOfDate = 1;
  }
  excludeTvSimulatorX86(project, target);
}

const PODFILE_MARKER = '# [ELV] AetherEngine post_integrate';
const PODFILE_SNIPPET = `${PODFILE_MARKER}
post_integrate do |installer|
  installer.aggregate_targets.map(&:user_project).compact.uniq.each do |project|
    project.native_targets.each do |target|
      phase = target.shell_script_build_phases.find { |p| p.name == '${AETHER_EMBED_PHASE}' }
      next unless phase && target.build_phases.last != phase
      target.build_phases.delete(phase)
      target.build_phases << phase
    end
    project.save
  end
end
`;

/** Appends a `post_integrate` hook so `pod install` (which adds `[CP] Embed Pods Frameworks`) leaves our phase last. */
export function applyAetherPodfile(contents: string): string {
  if (contents.includes(PODFILE_MARKER)) return contents;
  const trimmed = contents.endsWith('\n') ? contents : `${contents}\n`;
  return `${trimmed}\n${PODFILE_SNIPPET}`;
}

/** Expo config plugin: {@link applyAetherFrameworks} with the module script located from the project root. */
export const withAetherFrameworks: ConfigPlugin = (config) => {
  const withProject = withXcodeProject(config, (cfg) => {
    const { projectRoot, platformProjectRoot } = cfg.modRequest;
    const script = path.relative(platformProjectRoot, aetherEmbedScriptPath(projectRoot));
    applyAetherFrameworks(cfg.modResults, script.split(path.sep).join('/'));
    return cfg;
  });
  return withPodfile(withProject, (cfg) => {
    cfg.modResults.contents = applyAetherPodfile(cfg.modResults.contents);
    return cfg;
  });
};
