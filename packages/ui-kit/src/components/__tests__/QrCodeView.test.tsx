import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../../theme';
import { QrCodeView } from '../QrCodeView';
import { MAX_QR_PAYLOAD_BYTES } from '../qr-matrix';

describe('<QrCodeView />', () => {
  it('renders a high-contrast QR code container with white quiet zone and dark modules', async () => {
    await render(
      <ThemeProvider>
        <QrCodeView
          value="http://192.168.1.10:8080/pair/abcdef0123456789abcdef0123456789"
          size={220}
          testID="pairing-qr"
          accessibilityLabel="Scan QR code"
        />
      </ThemeProvider>,
    );

    const root = screen.getByTestId('pairing-qr');
    expect(root.props.accessibilityLabel).toBe('Scan QR code');
    expect(root.props.accessibilityRole).toBe('image');

    const flatStyle = Array.isArray(root.props.style)
      ? Object.assign({}, ...root.props.style)
      : root.props.style;
    expect(flatStyle.width).toBe(220);
    expect(flatStyle.height).toBe(220);
    expect(flatStyle.backgroundColor).toBe('#FFFFFF');
  });

  it('renders a graceful fallback without throwing when payload exceeds V10-M capacity', async () => {
    await render(
      <ThemeProvider>
        <QrCodeView
          value={'z'.repeat(MAX_QR_PAYLOAD_BYTES + 20)}
          size={200}
          testID="oversized-qr"
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('oversized-qr-fallback')).toBeTruthy();
  });
});
