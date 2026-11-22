import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mpvRuntimePaths } from './runtime-path.ts';

const present = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe('mpvRuntimePaths', () => {
  it('finds the packaged Windows runtime in resources/mpv', () => {
    const exe = join('/res', 'mpv', 'elv-mpv.exe');
    const paths = mpvRuntimePaths(
      { isPackaged: true, resourcesPath: '/res', appPath: '/app', platform: 'win32', arch: 'x64' },
      present(exe),
    );
    expect(paths).toEqual({ executable: exe, inputConf: join('/res', 'mpv-input.conf') });
  });

  it('darwin runtime path points into the .app', () => {
    const packagedExe = join('/res', 'mpv', 'ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv');
    const devExe = join(
      '/app',
      'resources',
      'mpv',
      'darwin-arm64',
      'ELV IPTV Player.app',
      'Contents',
      'MacOS',
      'mpv',
    );
    expect(
      mpvRuntimePaths(
        {
          isPackaged: true,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'darwin',
          arch: 'arm64',
        },
        present(packagedExe),
      ),
    ).toEqual({ executable: packagedExe, inputConf: join('/res', 'mpv-input.conf') });
    expect(
      mpvRuntimePaths(
        {
          isPackaged: false,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'darwin',
          arch: 'arm64',
        },
        present(devExe),
      ),
    ).toEqual({ executable: devExe, inputConf: join('/app', 'resources', 'mpv-input.conf') });
  });

  it('exposes macOS canvasExecutable and ioSurfaceAddon only when both are present', () => {
    const packagedExe = join('/res', 'mpv', 'ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv');
    const packagedCanvasExe = join(
      '/res',
      'mpv',
      'ELV IPTV Player.app',
      'Contents',
      'MacOS',
      'elv-mpv',
    );
    const packagedAddon = join('/res', 'mpv', 'elv-iosurface.node');

    expect(
      mpvRuntimePaths(
        {
          isPackaged: true,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'darwin',
          arch: 'arm64',
        },
        present(packagedExe, packagedCanvasExe, packagedAddon),
      ),
    ).toEqual({
      executable: packagedExe,
      inputConf: join('/res', 'mpv-input.conf'),
      canvasExecutable: packagedCanvasExe,
      ioSurfaceAddon: packagedAddon,
    });

    const devDir = join('/app', 'resources', 'mpv', 'darwin-arm64');
    const devExe = join(devDir, 'ELV IPTV Player.app', 'Contents', 'MacOS', 'mpv');
    const devCanvasExe = join(devDir, 'ELV IPTV Player.app', 'Contents', 'MacOS', 'elv-mpv');
    const devAddon = join(devDir, 'elv-iosurface.node');

    expect(
      mpvRuntimePaths(
        {
          isPackaged: false,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'darwin',
          arch: 'arm64',
        },
        present(devExe, devCanvasExe, devAddon),
      ),
    ).toEqual({
      executable: devExe,
      inputConf: join('/app', 'resources', 'mpv-input.conf'),
      canvasExecutable: devCanvasExe,
      ioSurfaceAddon: devAddon,
    });

    // When only one of elv-mpv or elv-iosurface.node exists, omit both
    expect(
      mpvRuntimePaths(
        {
          isPackaged: true,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'darwin',
          arch: 'arm64',
        },
        present(packagedExe, packagedCanvasExe),
      ),
    ).toEqual({ executable: packagedExe, inputConf: join('/res', 'mpv-input.conf') });

    expect(
      mpvRuntimePaths(
        {
          isPackaged: true,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'darwin',
          arch: 'arm64',
        },
        present(packagedExe, packagedAddon),
      ),
    ).toEqual({ executable: packagedExe, inputConf: join('/res', 'mpv-input.conf') });
  });

  it('finds the development runtime under resources/mpv/<platform>-<arch>', () => {
    const exe = join('/app', 'resources', 'mpv', 'win32-x64', 'elv-mpv.exe');
    const paths = mpvRuntimePaths(
      { isPackaged: false, resourcesPath: '/res', appPath: '/app', platform: 'win32', arch: 'x64' },
      present(exe),
    );
    expect(paths).toEqual({
      executable: exe,
      inputConf: join('/app', 'resources', 'mpv-input.conf'),
    });
  });

  it('returns null when the executable is missing', () => {
    expect(
      mpvRuntimePaths(
        {
          isPackaged: false,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'win32',
          arch: 'x64',
        },
        present(),
      ),
    ).toBeNull();
  });

  it('returns null on a platform without a runtime', () => {
    expect(
      mpvRuntimePaths(
        {
          isPackaged: true,
          resourcesPath: '/res',
          appPath: '/app',
          platform: 'linux',
          arch: 'x64',
        },
        () => true,
      ),
    ).toBeNull();
  });
});
