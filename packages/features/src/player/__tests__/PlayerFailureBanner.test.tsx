import { elvError } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { ThemeProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { describePlaybackFailure } from '../errors';
import { PlayerFailureBanner } from '../PlayerOsdChrome';

describe('PlayerFailureBanner localized HTTP status (#63)', () => {
  it('renders localized HTTP status line in EN and TR when httpStatus is present', async () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const failure = describePlaybackFailure(elvError('network', 'http-503'), {
      url: 'https://user:pass@stream.example.test:8080/live/1.ts',
      httpStatus: 503,
    });

    const viewEn = await render(
      <ThemeProvider>
        <PlayerFailureBanner failure={failure} i18n={en} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('player-error-http-status')).toHaveTextContent(
      'Stream server returned HTTP 503',
    );
    expect(screen.getByTestId('osd-error-hint')).toBeTruthy();
    await viewEn.unmount();

    const viewTr = await render(
      <ThemeProvider>
        <PlayerFailureBanner failure={failure} i18n={tr} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('player-error-http-status')).toHaveTextContent(
      'Yayın sunucusu HTTP 503 döndürdü',
    );
    await viewTr.unmount();
  });

  it('omits player-error-http-status when failure has no HTTP status', async () => {
    const en = createAppI18n('en');
    const failure = describePlaybackFailure(elvError('playback', 'unsupported-codec'));

    const view = await render(
      <ThemeProvider>
        <PlayerFailureBanner failure={failure} i18n={en} />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('player-error-http-status')).toBeNull();
    expect(screen.getByTestId('osd-error-hint')).toBeTruthy();
    await view.unmount();
  });
});
