/** A local M3U playlist file selected via a sandboxed platform picker (`#51`). */
export interface PickedPlaylistFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Platform port for clipboard paste, sandboxed local playlist file picking (`#51`), and OS
 * `open-file` / `second-instance` local playlist launches (`#259`).
 * Each capability is optional so platforms without it (e.g. tvOS) simply omit the UI control.
 */
export interface SourceImportHost {
  readClipboardText?: () => Promise<string | null>;
  pickPlaylistFile?: () => Promise<PickedPlaylistFile | null>;
  readonly consumePendingPlaylistFiles?: () => Promise<readonly PickedPlaylistFile[]>;
  readonly onOpenPlaylistFile?: (listener: (file: PickedPlaylistFile) => void) => () => void;
}
