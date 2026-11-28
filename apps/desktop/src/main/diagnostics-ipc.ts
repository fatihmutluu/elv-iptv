import { writeFile as nodeWriteFile } from 'node:fs/promises';
import { redactText } from '@elv/domain';
import {
  DEFAULT_DIAGNOSTIC_REPORT_FILENAME,
  DIAGNOSTICS_CHANNELS,
  type ExportDiagnosticReportReply,
  isCopyDiagnosticTextRequest,
  isExportDiagnosticReportRequest,
  parseReadLogTailMaxLines,
} from '../shared/diagnostics-ipc.ts';
import { assertTrustedSenderFrame, type TrustedSenderEventLike } from './trusted-sender.ts';

type IpcHandler = (
  event: TrustedSenderEventLike & { sender: unknown },
  ...args: unknown[]
) => unknown;

interface DiagnosticsIpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

interface DiagnosticSaveDialogOptions {
  readonly defaultPath: string;
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

interface DiagnosticSaveDialogResult {
  readonly canceled: boolean;
  readonly filePath?: string | undefined;
}

/** Collaborators injected into {@link registerDiagnosticsIpc}. */
export interface DiagnosticsIpcDeps<TWindow = unknown> {
  ipcMain: DiagnosticsIpcMainLike;
  getWindowFromSender(sender: unknown): TWindow | null | undefined;
  readLogTail(maxLines: number): Promise<string[]>;
  showSaveDialog(
    window: TWindow | null | undefined,
    options: DiagnosticSaveDialogOptions,
  ): Promise<DiagnosticSaveDialogResult>;
  writeFile?(filePath: string, content: string): Promise<void>;
  writeClipboardText(text: string): void | Promise<void>;
  devOrigin?: string | null;
  log?(line: string): void;
}

/**
 * Registers `diagnostics:readLogTail`, `diagnostics:exportReport`, and `diagnostics:copyText`
 * on `ipcMain` (`#226`). Enforces strict input validation, double-redaction through `redactText`,
 * 512 KiB report bounds, and writes strictly to user-chosen save-dialog paths without ever
 * accepting or exposing host file paths across IPC.
 */
export function registerDiagnosticsIpc<TWindow = unknown>(
  deps: DiagnosticsIpcDeps<TWindow>,
): () => void {
  const { ipcMain, getWindowFromSender, readLogTail, showSaveDialog, writeClipboardText, log } =
    deps;
  const writeUtf8 =
    deps.writeFile ??
    ((filePath: string, content: string) => nodeWriteFile(filePath, content, 'utf8'));

  ipcMain.handle(DIAGNOSTICS_CHANNELS.readLogTail, async (event, rawMaxLines) => {
    assertTrustedSenderFrame(event, DIAGNOSTICS_CHANNELS.readLogTail, deps.devOrigin, log);
    const maxLines = parseReadLogTailMaxLines(rawMaxLines);
    if (maxLines === null) {
      log?.(`diagnostics ipc: dropped an invalid ${DIAGNOSTICS_CHANNELS.readLogTail} payload`);
      throw new Error('invalid diagnostics:readLogTail maxLines');
    }
    const lines = await readLogTail(maxLines);
    return lines.slice(-maxLines).map((line) => redactText(line));
  });

  ipcMain.handle(
    DIAGNOSTICS_CHANNELS.exportReport,
    async (event, rawRequest): Promise<ExportDiagnosticReportReply> => {
      assertTrustedSenderFrame(event, DIAGNOSTICS_CHANNELS.exportReport, deps.devOrigin, log);
      if (!isExportDiagnosticReportRequest(rawRequest)) {
        log?.(`diagnostics ipc: dropped an invalid ${DIAGNOSTICS_CHANNELS.exportReport} payload`);
        throw new Error('invalid diagnostics:exportReport payload');
      }
      const safeMarkdown = redactText(rawRequest.markdown);
      const win = getWindowFromSender(event.sender);
      const result = await showSaveDialog(win, {
        defaultPath: DEFAULT_DIAGNOSTIC_REPORT_FILENAME,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || typeof result.filePath !== 'string' || result.filePath.trim() === '') {
        return { saved: false };
      }
      await writeUtf8(result.filePath, safeMarkdown);
      return { saved: true };
    },
  );

  ipcMain.handle(DIAGNOSTICS_CHANNELS.copyText, async (event, rawRequest): Promise<boolean> => {
    assertTrustedSenderFrame(event, DIAGNOSTICS_CHANNELS.copyText, deps.devOrigin, log);
    if (!isCopyDiagnosticTextRequest(rawRequest)) {
      log?.(`diagnostics ipc: dropped an invalid ${DIAGNOSTICS_CHANNELS.copyText} payload`);
      throw new Error('invalid diagnostics:copyText payload');
    }
    await writeClipboardText(redactText(rawRequest.text));
    return true;
  });

  return () => {
    ipcMain.removeHandler(DIAGNOSTICS_CHANNELS.readLogTail);
    ipcMain.removeHandler(DIAGNOSTICS_CHANNELS.exportReport);
    ipcMain.removeHandler(DIAGNOSTICS_CHANNELS.copyText);
  };
}
