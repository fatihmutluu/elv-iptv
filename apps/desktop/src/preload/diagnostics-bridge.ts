import {
  type CopyDiagnosticTextRequest,
  DIAGNOSTICS_CHANNELS,
  type DiagnosticsBridge,
  type ExportDiagnosticReportReply,
  type ExportDiagnosticReportRequest,
  isCopyDiagnosticTextRequest,
  isExportDiagnosticReportReply,
  isExportDiagnosticReportRequest,
  isReadLogTailReply,
  parseReadLogTailMaxLines,
} from '../shared/diagnostics-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createDiagnosticsBridge}. */
export interface DiagnosticsIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Builds the frozen `window.elv.diagnostics` bridge inside the sandboxed Electron preload (`#226`).
 * Validates all inputs and replies strictly before/after crossing IPC.
 */
export function createDiagnosticsBridge(ipc: DiagnosticsIpcRendererLike): DiagnosticsBridge {
  const bridge: DiagnosticsBridge = {
    async readLogTail(maxLines?: number): Promise<string[]> {
      const clamped = parseReadLogTailMaxLines(maxLines);
      if (clamped === null) {
        throw new Error('diagnostics:readLogTail requires a finite numeric maxLines');
      }
      const reply = await ipc.invoke(DIAGNOSTICS_CHANNELS.readLogTail, clamped);
      if (!isReadLogTailReply(reply)) {
        throw new Error('diagnostics:readLogTail returned an unexpected reply');
      }
      return reply;
    },
    async exportReport(markdown: string): Promise<ExportDiagnosticReportReply> {
      const payload: ExportDiagnosticReportRequest = { markdown };
      if (!isExportDiagnosticReportRequest(payload)) {
        throw new Error('diagnostics:exportReport requires non-empty markdown <= 512 KiB');
      }
      const reply = await ipc.invoke(DIAGNOSTICS_CHANNELS.exportReport, payload);
      if (!isExportDiagnosticReportReply(reply)) {
        throw new Error('diagnostics:exportReport returned an unexpected reply');
      }
      return { saved: reply.saved };
    },
    async copyReport(text: string): Promise<boolean> {
      const payload: CopyDiagnosticTextRequest = { text };
      if (!isCopyDiagnosticTextRequest(payload)) {
        throw new Error('diagnostics:copyText requires non-empty text <= 512 KiB');
      }
      const reply = await ipc.invoke(DIAGNOSTICS_CHANNELS.copyText, payload);
      if (typeof reply !== 'boolean') {
        throw new Error('diagnostics:copyText returned an unexpected reply');
      }
      return reply;
    },
  };
  return Object.freeze(bridge);
}
