/** Request payload for handing off stream playback to an external media player (`#406`). */
export interface ExternalPlayerRequest {
  readonly url: string;
  readonly mimeType?: string;
  readonly title: string;
  readonly startPositionMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly customScheme?: string;
}

/** Result returned from an external media player launch attempt (`#406`). */
export interface ExternalPlayerResult {
  readonly launched: boolean;
  readonly positionMs?: number;
  readonly durationMs?: number;
  readonly completed?: boolean;
  readonly errorCode?: string;
}

/** Platform port for handing off stream playback to an installed external media player (`#406`). */
export interface ExternalPlayerPort {
  readonly isSupported: boolean;
  launch(req: ExternalPlayerRequest): Promise<ExternalPlayerResult>;
}

/** Platform port for opt-in redacted diagnostic crash reports (`#226`). */
export interface DiagnosticsPort {
  readonly appVersion: string;
  readonly platformLabel: string;
  readonly osVersion?: string;
  readLogTail(maxLines?: number): Promise<readonly string[]>;
  copyText?(text: string): Promise<boolean>;
  exportMarkdown?(markdown: string): Promise<boolean>;
  recordDiagnosticLog?(line: string): void;
}
