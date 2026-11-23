/** A local M3U playlist file selected via a sandboxed platform picker (`#51`). */
export interface PickedPlaylistFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Platform port for clipboard paste and sandboxed local playlist file picking (`#51`).
 * Each capability is optional so platforms without it (e.g. tvOS) simply omit the UI control.
 */
export interface SourceImportHost {
  readClipboardText?: () => Promise<string | null>;
  pickPlaylistFile?: () => Promise<PickedPlaylistFile | null>;
}
