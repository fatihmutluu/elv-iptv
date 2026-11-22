import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where the mpv launcher and its input configuration live. */
export interface MpvRuntimePaths {
  executable: string;
  inputConf: string;
  canvasExecutable?: string;
  ioSurfaceAddon?: string;
}

const MAC_EXECUTABLE = ['ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv'];
const MAC_CANVAS_EXECUTABLE = ['ELV IPTV Player.app', 'Contents', 'MacOS', 'elv-mpv'];
const MAC_IOSURFACE_ADDON = 'elv-iosurface.node';

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
  const inputConf = join(resources, 'mpv-input.conf');
  if (p.platform === 'darwin') {
    const macCanvasExe = join(runtimeDir, ...MAC_CANVAS_EXECUTABLE);
    const macAddon = join(runtimeDir, MAC_IOSURFACE_ADDON);
    if (exists(macCanvasExe) && exists(macAddon)) {
      return { executable, inputConf, canvasExecutable: macCanvasExe, ioSurfaceAddon: macAddon };
    }
  }
  return { executable, inputConf };
}
