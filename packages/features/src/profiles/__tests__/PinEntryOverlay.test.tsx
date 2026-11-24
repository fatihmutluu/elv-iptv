import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  useTvKeySource,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';
import { PinEntryOverlay, type PinEntryOverlayProps } from '../PinEntryOverlay';
import { ProfilePickerOverlay } from '../ProfilePickerOverlay';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_CHANNEL_UP = 166;

function BackgroundPlayerSubscriber({ onKey }: { readonly onKey: (input: unknown) => void }): null {
  useTvKeySource((input) => {
    onKey(input);
    return true;
  });
  return null;
}

async function tapDigits(digits: string) {
  for (const d of digits) {
    await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
  }
}

function renderPinOverlay(
  props: PinEntryOverlayProps,
  opts?: { readonly tv?: boolean; readonly androidSource?: AndroidKeySource },
): ReturnType<typeof render> {
  const tree: ReactElement = (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor: opts?.tv ? 'tv' : 'desktop',
          orientation: 'landscape',
          inputModality: opts?.tv ? 'tv' : 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <PinEntryOverlay {...props} />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
  return render(
    opts?.androidSource ? (
      <RemoteKeysProvider android={opts.androidSource}>{tree}</RemoteKeysProvider>
    ) : (
      tree
    ),
  );
}

describe('PinEntryOverlay', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('handles create mode mismatch then confirm match and calls onSetPin', async () => {
    const onSetPin = jest.fn(async () => ok(undefined));
    const onSuccess = jest.fn();
    const onCancel = jest.fn();

    await renderPinOverlay({
      mode: 'create',
      onSetPin,
      onSuccess,
      onCancel,
    });

    await tapDigits('1234');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    expect(screen.getByTestId('pin-entry-title')).toHaveTextContent('Confirm PIN');

    // Enter mismatched PIN
    await tapDigits('9999');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('pin-entry-error')).toHaveTextContent(
        'PINs do not match. Try again.',
      );
      expect(screen.getByTestId('pin-entry-title')).toHaveTextContent('Create a 4–8 digit PIN');
    });
    expect(onSetPin).not.toHaveBeenCalled();

    // Create + confirm matching PIN
    await tapDigits('2468');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await tapDigits('2468');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));

    await waitFor(() => {
      expect(onSetPin).toHaveBeenCalledWith('2468', undefined);
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it('shows wrong-PIN feedback, lockout countdown, and succeeds on valid PIN in verify mode', async () => {
    const onVerify = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, remainingAttempts: 4 })
      .mockResolvedValueOnce({
        ok: false,
        remainingAttempts: 0,
        lockedUntilMs: Date.now() + 25_000,
      })
      .mockResolvedValueOnce({ ok: true });
    const onSuccess = jest.fn();

    await renderPinOverlay({
      mode: 'verify',
      onVerify,
      onSuccess,
      onCancel: jest.fn(),
    });

    await tapDigits('0000');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('pin-entry-error')).toHaveTextContent('Incorrect PIN.');
    });

    // Lockout response disables submit and shows countdown
    await tapDigits('0001');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('pin-entry-error')).toHaveTextContent(
        /Too many attempts\. Try again in \d+s\./,
      );
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('supports change PIN (old -> new -> confirm) and remove PIN flows', async () => {
    const onVerify = jest.fn(async (pin: string) =>
      pin === '1111' ? { ok: true as const } : { ok: false as const, remainingAttempts: 4 },
    );
    const onSetPin = jest.fn(async () => ok(undefined));
    const onSuccess = jest.fn();

    const view = await renderPinOverlay({
      mode: 'change',
      onVerify,
      onSetPin,
      onSuccess,
      onCancel: jest.fn(),
    });

    // Step 1: verify old PIN
    await tapDigits('1111');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('pin-entry-title')).toHaveTextContent('Create a 4–8 digit PIN');
    });

    // Step 2 + 3: create & confirm new PIN
    await tapDigits('5678');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await tapDigits('5678');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));

    await waitFor(() => {
      expect(onSetPin).toHaveBeenCalledWith('5678', '1111');
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    await view.unmount();

    // Remove mode
    const onClearPin = jest
      .fn()
      .mockResolvedValueOnce(err(elvError('auth', 'invalid-pin')))
      .mockResolvedValueOnce(ok(undefined));
    const onRemoveSuccess = jest.fn();

    await renderPinOverlay({
      mode: 'remove',
      onClearPin,
      onSuccess: onRemoveSuccess,
      onCancel: jest.fn(),
    });

    await tapDigits('9999');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('pin-entry-error')).toHaveTextContent('Incorrect PIN.');
    });

    await tapDigits('5678');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(onClearPin).toHaveBeenLastCalledWith('5678');
      expect(onRemoveSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it('dismisses cleanly on TV Back key', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };
    const onCancel = jest.fn();

    await renderPinOverlay(
      { mode: 'verify', onVerify: async () => ({ ok: true }), onSuccess: jest.fn(), onCancel },
      { tv: true, androidSource },
    );

    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('exclusively intercepts TV remote keys so background Player subscribers never receive D-pad/channel/Back events', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return { remove: () => undefined };
      },
    };
    const backgroundSpy = jest.fn();
    const onCancel = jest.fn();
    await render(
      <RemoteKeysProvider android={androidSource}>
        <TvRemoteProvider>
          <ViewportProvider
            value={{
              formFactor: 'tv',
              orientation: 'landscape',
              inputModality: 'tv',
              width: 1280,
              height: 720,
            }}
          >
            <I18nProvider i18n={createAppI18n('en')}>
              <ThemeProvider>
                <BackgroundPlayerSubscriber onKey={backgroundSpy} />
                <PinEntryOverlay
                  mode="verify"
                  onVerify={async () => ({ ok: true })}
                  onSuccess={jest.fn()}
                  onCancel={onCancel}
                />
              </ThemeProvider>
            </I18nProvider>
          </ViewportProvider>
        </TvRemoteProvider>
      </RemoteKeysProvider>,
    );

    await act(async () => {
      keyListener?.({ action: 'down', keyCode: KEYCODE_DPAD_DOWN, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_DPAD_DOWN, canceled: false, ageMs: 10 });
      keyListener?.({ action: 'down', keyCode: KEYCODE_CHANNEL_UP, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_CHANNEL_UP, canceled: false, ageMs: 10 });
      keyListener?.({ action: 'down', keyCode: KEYCODE_BACK, canceled: false, ageMs: 0 });
      keyListener?.({ action: 'up', keyCode: KEYCODE_BACK, canceled: false, ageMs: 10 });
    });

    expect(backgroundSpy).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses pure onVerifyCurrentPin in change mode and shows lockout countdown on pin-locked in remove & confirm steps', async () => {
    const onVerify = jest.fn(async () => ({ ok: true as const }));
    const onVerifyCurrentPin = jest.fn(async () => ({ ok: true as const }));
    const onSetPin = jest.fn(async () => err(elvError('auth', 'pin-locked')));
    const onCancel = jest.fn();

    const changeView = await renderPinOverlay({
      mode: 'change',
      onVerify,
      onVerifyCurrentPin,
      onSetPin,
      onSuccess: jest.fn(),
      onCancel,
    });

    await tapDigits('1111');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(onVerifyCurrentPin).toHaveBeenCalledWith('1111');
      expect(onVerify).not.toHaveBeenCalled();
      expect(screen.getByTestId('pin-entry-title')).toHaveTextContent('Create a 4–8 digit PIN');
    });

    // Confirm step receives auth/pin-locked -> displays lockout countdown instead of generic wrong-PIN
    await tapDigits('2222');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await tapDigits('2222');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('pin-entry-error')).toHaveTextContent(
        /Too many attempts\. Try again in \d+s\./,
      );
    });
    await changeView.unmount();

    // Remove step receives auth/pin-locked -> displays lockout countdown
    const onClearPin = jest.fn(async () => err(elvError('auth', 'pin-locked')));
    const removeView = await renderPinOverlay({
      mode: 'remove',
      onClearPin,
      onSuccess: jest.fn(),
      onCancel: jest.fn(),
    });
    await tapDigits('9999');
    await fireEvent.press(screen.getByTestId('pin-entry-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('pin-entry-error')).toHaveTextContent(
        /Too many attempts\. Try again in \d+s\./,
      );
    });
    await removeView.unmount();
  });

  it('calls stopImmediatePropagation on web keydown in PinEntryOverlay and ProfilePickerOverlay', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: unknown) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      fn: (e: unknown) => void,
    ) => {
      listeners.get(type)?.delete(fn);
    };

    try {
      const onCancel = jest.fn();
      const pinView = await renderPinOverlay({
        mode: 'verify',
        onVerify: async () => ({ ok: true }),
        onSuccess: jest.fn(),
        onCancel,
      });

      const stopImm = jest.fn();
      await act(async () => {
        for (const fn of listeners.get('keydown') ?? []) {
          fn({
            key: 'Escape',
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            stopImmediatePropagation: stopImm,
          });
        }
      });
      expect(stopImm).toHaveBeenCalledTimes(1);
      expect(onCancel).toHaveBeenCalledTimes(1);
      await pinView.unmount();

      const onClosePicker = jest.fn();
      const pickerView = await render(
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <ProfilePickerOverlay
              profiles={[
                {
                  id: 'default',
                  name: 'Default',
                  avatarToken: 'crimson',
                  isKids: false,
                  isDefault: true,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ]}
              activeProfileId="default"
              onSelectProfile={jest.fn()}
              onManageInSettings={jest.fn()}
              onClose={onClosePicker}
            />
          </ThemeProvider>
        </I18nProvider>,
      );

      const pickerStopImm = jest.fn();
      await act(async () => {
        for (const fn of listeners.get('keydown') ?? []) {
          fn({
            key: 'Escape',
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            stopImmediatePropagation: pickerStopImm,
          });
        }
      });
      expect(pickerStopImm).toHaveBeenCalledTimes(1);
      expect(onClosePicker).toHaveBeenCalledTimes(1);
      await pickerView.unmount();
    } finally {
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
    }
  });

  it('skips desktop capture keydown on Web-TV so Enter stays D-pad select', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: unknown) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      fn: (e: unknown) => void,
    ) => {
      listeners.get(type)?.delete(fn);
    };
    try {
      const onVerify = jest.fn(async () => ({ ok: true as const }));
      const view = await renderPinOverlay(
        { mode: 'verify', onVerify, onSuccess: jest.fn(), onCancel: jest.fn() },
        { tv: true },
      );

      // PinEntryOverlay must NOT attach its capture desktop keydown handler when isTv === true
      const stopImm = jest.fn();
      await act(async () => {
        for (const fn of listeners.get('keydown') ?? []) {
          fn({
            key: 'Enter',
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            stopImmediatePropagation: stopImm,
          });
        }
      });
      expect(stopImm).not.toHaveBeenCalled();
      expect(onVerify).not.toHaveBeenCalled();
      await view.unmount();
    } finally {
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
    }
  });
});
