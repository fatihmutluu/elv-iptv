import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { DiagnosticsPort } from '../../ports/wave-f7b-ports';
import { CrashRecoveryBoundary } from '../CrashRecoveryBoundary';

const i18n = createAppI18n('en');

function ExplodingChild(): ReactElement {
  throw new Error('Crash at https://user:secretpass@iptv.example.test/live.ts');
}

function makeDiagnostics(): DiagnosticsPort {
  return {
    appVersion: '1.0.0',
    platformLabel: 'Android TV',
    osVersion: '14',
    readLogTail: jest.fn(async () => ['[2026-11-25] safe diagnostic line']),
    copyText: jest.fn(async () => true),
    exportMarkdown: jest.fn(async () => true),
  };
}

describe('CrashRecoveryBoundary opt-in crash diagnostics (#226)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('hides crash diagnostics UI strictly when crashReportsOptIn is false (default)', async () => {
    const diagnostics = makeDiagnostics();
    const view = await render(
      <ThemeProvider>
        <ViewportProvider>
          <I18nProvider i18n={i18n}>
            <CrashRecoveryBoundary crashReportsOptIn={false} diagnostics={diagnostics}>
              <ExplodingChild />
            </CrashRecoveryBoundary>
          </I18nProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(view.getByTestId('crash-reload')).toBeTruthy();
    expect(view.queryByTestId('crash-diagnostics')).toBeNull();
    expect(view.queryByTestId('crash-report-preview-modal')).toBeNull();
  });

  it('shows View Diagnostics when opted in, renders redacted Markdown, and supports Copy/Export', async () => {
    const diagnostics = makeDiagnostics();
    const onToggleIncludeLogs = jest.fn();

    const view = await render(
      <ThemeProvider>
        <ViewportProvider>
          <I18nProvider i18n={i18n}>
            <CrashRecoveryBoundary
              crashReportsOptIn
              crashReportsIncludeLogs={false}
              diagnostics={diagnostics}
              onToggleIncludeLogs={onToggleIncludeLogs}
            >
              <ExplodingChild />
            </CrashRecoveryBoundary>
          </I18nProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );

    await fireEvent.press(view.getByTestId('crash-diagnostics'));
    expect(view.getByTestId('crash-report-preview-modal')).toBeTruthy();

    const markdownText = view.getByTestId('crash-report-markdown-text').props.children as string;
    expect(markdownText).toContain('# ELV IPTV Diagnostic Report');
    expect(markdownText).not.toContain('secretpass');
    expect(markdownText).not.toContain('Recent Logs');

    await fireEvent.press(view.getByTestId('crash-report-include-logs-toggle'));
    expect(onToggleIncludeLogs).toHaveBeenCalledWith(true);

    await waitFor(() => {
      const updated = view.getByTestId('crash-report-markdown-text').props.children as string;
      expect(updated).toContain('safe diagnostic line');
    });

    await fireEvent.press(view.getByTestId('crash-report-copy'));
    await waitFor(() => {
      expect(diagnostics.copyText).toHaveBeenCalledTimes(1);
    });

    await fireEvent.press(view.getByTestId('crash-report-export'));
    await waitFor(() => {
      expect(diagnostics.exportMarkdown).toHaveBeenCalledTimes(1);
    });

    await fireEvent.press(view.getByTestId('crash-report-close'));
    expect(view.queryByTestId('crash-report-preview-modal')).toBeNull();
  });

  it('records strictly redacted errorName and path-free stackSig to telemetry.recordAppCrash on render crash (#509)', async () => {
    const recordAppCrash = jest.fn();
    await render(
      <ThemeProvider>
        <ViewportProvider>
          <I18nProvider i18n={i18n}>
            <CrashRecoveryBoundary telemetry={{ recordAppCrash }} screenName="live">
              <ExplodingChild />
            </CrashRecoveryBoundary>
          </I18nProvider>
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(recordAppCrash).toHaveBeenCalledTimes(1);
    const meta = recordAppCrash.mock.calls[0]?.[0] as {
      errorName: string;
      stackSig: string;
      screen?: string;
      fatal: boolean;
    };
    expect(meta.errorName).toBe('Error');
    expect(meta.screen).toBe('live');
    expect(meta.fatal).toBe(true);
    expect(meta.stackSig).not.toContain('secretpass');
    expect(meta.stackSig).not.toContain('iptv.example.test');
    expect(meta.stackSig).not.toMatch(/[A-Za-z]:\\/);
  });
});
