import { DEFAULT_PREFERENCES, type PreferencesPatch } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useState } from 'react';
import type { FeedbackPort, FeedbackSubmitInput, TelemetryPort } from '../../ports/wave-f9-ports';
import { FeedbackSettingsPanel } from '../FeedbackSettingsPanel';

function createMockTelemetry(): jest.Mocked<TelemetryPort> {
  let optIn = false;
  return {
    isOptedIn: jest.fn(() => optIn),
    setOptIn: jest.fn((enabled: boolean) => {
      optIn = enabled;
    }),
    queuedCount: jest.fn(() => 3),
    getPayloadPreviewJson: jest.fn(() =>
      JSON.stringify({ sessionId: 'anon-123', events: [{ kind: 'startup', durationMs: 120 }] }),
    ),
    recordScreenTransition: jest.fn(),
    recordMediaDecodeFailure: jest.fn(),
    recordPlaybackError: jest.fn(),
    flush: jest.fn(async () => undefined),
  };
}

function createMockFeedback() {
  const submit = jest.fn(
    async (_input: FeedbackSubmitInput): ReturnType<FeedbackPort['submit']> => ({
      ok: true,
      id: 'fb-1',
    }),
  );
  return { submit };
}

function Harness({
  telemetry,
  feedback,
}: {
  readonly telemetry?: TelemetryPort;
  readonly feedback?: FeedbackPort;
}): ReactElement {
  const [telemetryOptIn, setTelemetryOptIn] = useState(DEFAULT_PREFERENCES.telemetryOptIn);
  return (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <FeedbackSettingsPanel
              {...(telemetry !== undefined ? { telemetry } : {})}
              {...(feedback !== undefined ? { feedback } : {})}
              preferences={{
                preferences: { telemetryOptIn },
                updatePreferences: (patch: PreferencesPatch) => {
                  if (patch.telemetryOptIn !== undefined) {
                    setTelemetryOptIn(patch.telemetryOptIn);
                  }
                },
              }}
            />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

describe('FeedbackSettingsPanel', () => {
  it('defaults telemetry opt-in to false, toggles preference + port, and previews redacted JSON payload', async () => {
    const telemetry = createMockTelemetry();
    const feedback = createMockFeedback();

    await render(<Harness telemetry={telemetry} feedback={feedback} />);

    const toggle = screen.getByTestId('telemetry-opt-in-toggle');
    expect(toggle.props.accessibilityState.checked).toBe(false);
    expect(screen.getByTestId('telemetry-queued-count')).toHaveTextContent('Queued events: 3');
    expect(screen.queryByTestId('telemetry-payload-preview')).toBeNull();

    // Toggle opt-in ON
    await fireEvent.press(toggle);
    expect(telemetry.setOptIn).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('telemetry-opt-in-toggle').props.accessibilityState.checked).toBe(
      true,
    );

    // Open JSON payload preview
    await fireEvent.press(screen.getByTestId('telemetry-preview-toggle'));
    expect(screen.getByTestId('telemetry-payload-preview-text')).toHaveTextContent(/anon-123/);
    expect(screen.getByTestId('telemetry-payload-preview-text')).toHaveTextContent(/startup/);

    // Close preview
    await fireEvent.press(screen.getByTestId('telemetry-preview-toggle'));
    expect(screen.queryByTestId('telemetry-payload-preview')).toBeNull();
  });

  it('validates empty feedback message, selects category, attaches diagnostics, and submits', async () => {
    const telemetry = createMockTelemetry();
    const feedback = createMockFeedback();

    await render(<Harness telemetry={telemetry} feedback={feedback} />);

    // Empty message rejected cleanly
    await fireEvent.press(screen.getByTestId('feedback-submit-btn'));
    expect(screen.getByTestId('feedback-error')).toHaveTextContent(/Please write a brief/);
    expect(feedback.submit).not.toHaveBeenCalled();

    // Pick category + type message + enable redacted diagnostics
    await fireEvent.press(screen.getByTestId('feedback-cat-channel_epg'));
    expect(screen.getByTestId('feedback-cat-channel_epg').props.accessibilityState.selected).toBe(
      true,
    );
    await fireEvent.changeText(
      screen.getByTestId('feedback-message-input'),
      'EPG timestamps are offset by 1 hour.',
    );
    await fireEvent.press(screen.getByTestId('feedback-attach-diagnostics-toggle'));
    expect(
      screen.getByTestId('feedback-attach-diagnostics-toggle').props.accessibilityState.checked,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('feedback-submit-btn'));

    await waitFor(() => {
      expect(feedback.submit).toHaveBeenCalledWith({
        category: 'channel_epg',
        message: 'EPG timestamps are offset by 1 hour.',
        includeDiagnostics: true,
      });
      expect(screen.getByTestId('feedback-success')).toHaveTextContent(
        'Thank you! Your feedback has been received.',
      );
    });
  });

  it('shows error banner when submission fails and renders static preview when telemetry port is absent', async () => {
    const feedback = createMockFeedback();
    feedback.submit.mockResolvedValueOnce({ ok: false, errorCode: 'rate_limited' });

    await render(<Harness feedback={feedback} />);

    // Static fallback JSON preview still works
    await fireEvent.press(screen.getByTestId('telemetry-preview-toggle'));
    expect(screen.getByTestId('telemetry-payload-preview-text')).toHaveTextContent(
      /media_decode_failure/,
    );

    await fireEvent.changeText(
      screen.getByTestId('feedback-message-input'),
      'HEVC channel stuttered.',
    );
    await fireEvent.press(screen.getByTestId('feedback-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('feedback-error')).toHaveTextContent(
        /Could not send feedback right now/,
      );
    });
  });

  it('renders TvFocusGuideRegion, preserves D-pad left for wrapped chips, and calls onBack on TV Back', async () => {
    const dispatcher = createTvRemoteDispatcher();
    const onBack = jest.fn();

    await render(
      <TvRemoteProvider dispatcher={dispatcher}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider>
              <FeedbackSettingsPanel isActiveScope onBack={onBack} />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </TvRemoteProvider>,
    );

    expect(screen.getByTestId('settings-panel-feedback-focus-guide')).toBeTruthy();

    await act(async () => {
      dispatcher.dispatch({ key: 'left', action: 'press', time: 10 }, false);
    });
    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      dispatcher.dispatch({ key: 'back', action: 'press', time: 20 }, false);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
