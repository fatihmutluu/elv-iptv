import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { FeedbackPort, FeedbackSubmitInput } from '../../ports/wave-f9-ports';
import { FeedbackSettingsPanel } from '../FeedbackSettingsPanel';

function createMockFeedback() {
  const submit = jest.fn(
    async (_input: FeedbackSubmitInput): ReturnType<FeedbackPort['submit']> => ({
      ok: true,
      id: 'fb-1',
    }),
  );
  return { submit };
}

function Harness({ feedback }: { readonly feedback?: FeedbackPort }): ReactElement {
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
            <FeedbackSettingsPanel {...(feedback !== undefined ? { feedback } : {})} />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

describe('FeedbackSettingsPanel', () => {
  it('omits the Optional Runtime Telemetry card and defaults attachDiagnostics to true', async () => {
    const feedback = createMockFeedback();

    await render(<Harness feedback={feedback} />);

    expect(screen.queryByTestId('telemetry-settings-card')).toBeNull();
    expect(screen.queryByTestId('telemetry-opt-in-toggle')).toBeNull();
    expect(screen.queryByTestId('telemetry-payload-preview')).toBeNull();

    const diagToggle = screen.getByTestId('feedback-attach-diagnostics-toggle');
    expect(diagToggle.props.accessibilityState.checked).toBe(true);
  });

  it('validates empty feedback message, submits with diagnostics ON by default, and allows opting out', async () => {
    const feedback = createMockFeedback();

    await render(<Harness feedback={feedback} />);

    // Empty message rejected cleanly
    await fireEvent.press(screen.getByTestId('feedback-submit-btn'));
    expect(screen.getByTestId('feedback-error')).toHaveTextContent(/Please write a brief/);
    expect(feedback.submit).not.toHaveBeenCalled();

    // Pick category + type message -> diagnostics already ON by default
    await fireEvent.press(screen.getByTestId('feedback-cat-channel_epg'));
    expect(screen.getByTestId('feedback-cat-channel_epg').props.accessibilityState.selected).toBe(
      true,
    );
    await fireEvent.changeText(
      screen.getByTestId('feedback-message-input'),
      'EPG timestamps are offset by 1 hour.',
    );

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

    // User can opt out of diagnostics before submitting again
    await fireEvent.press(screen.getByTestId('feedback-attach-diagnostics-toggle'));
    expect(
      screen.getByTestId('feedback-attach-diagnostics-toggle').props.accessibilityState.checked,
    ).toBe(false);
    await fireEvent.changeText(
      screen.getByTestId('feedback-message-input'),
      'Another report without logs.',
    );
    await fireEvent.press(screen.getByTestId('feedback-submit-btn'));
    await waitFor(() => {
      expect(feedback.submit).toHaveBeenLastCalledWith({
        category: 'channel_epg',
        message: 'Another report without logs.',
        includeDiagnostics: false,
      });
    });
  });

  it('shows error banner when submission fails', async () => {
    const feedback = createMockFeedback();
    feedback.submit.mockResolvedValueOnce({ ok: false, errorCode: 'rate_limited' });

    await render(<Harness feedback={feedback} />);

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
