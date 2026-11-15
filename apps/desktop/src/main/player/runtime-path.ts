import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where the mpv launcher and its input configuration live. */
export interface MpvRuntimePaths {
  executable: string;
  inputConf: string;
}

const MAC_EXECUTABLE = ['ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv'];

/**
 * Locates the bundled mpv runtime: packaged next to the app under `resources/` (outside the asar), in development
 * under `apps/desktop/resources/`. Returns null when the executable is missing or the platform has no runtime yet.
 */
export function mpvRuntimePaths(
  p: {
    isPackaged: boolean;
    resourcesPath: string;
    appPath: string;
    platform: string;
    arch: string;
  },
  exists: (path: string) => boolean = existsSync,
): MpvRuntimePaths | null {
  const resources = p.isPackaged ? p.resourcesPath : join(p.appPath, 'resources');
  const runtimeDir = p.isPackaged
    ? join(resources, 'mpv')
    : join(resources, 'mpv', `${p.platform}-${p.arch}`);
  let executable: string;
  if (p.platform === 'win32') executable = join(runtimeDir, 'elv-mpv.exe');
  else if (p.platform === 'darwin') executable = join(runtimeDir, ...MAC_EXECUTABLE);
  else return null;
  if (!exists(executable)) return null;
  return { executable, inputConf: join(resources, 'mpv-input.conf') };
}
