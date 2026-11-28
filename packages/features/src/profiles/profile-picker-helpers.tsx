import type { KeyEvent, KeyInput } from '@elv/focus-core';
import { TvFocusAnchor, useKeyInterpreter, useTvKeyInterceptor, useTvKeySource } from '@elv/ui-kit';
import { type ReactElement, useCallback } from 'react';
import { StyleSheet } from 'react-native';

const NOOP_TV_SUBSCRIBER = (): boolean => false;

function useExclusiveTvKeySource(
  onInput: ((input: KeyInput) => boolean | undefined) | ((input: KeyInput) => void),
): void {
  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    onInput(input);
    return true;
  });
}

/** Captures TV D-pad keys while the root profile picker tiles grid is active. */
export function PickerTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent, { keySource: useExclusiveTvKeySource });
  return <TvFocusAnchor testID="profile-picker-tv-focus-anchor" hasTVPreferredFocus />;
}

/** Captures TV Back key while a profile Add/Edit sub-modal is open. */
export function SubModalTvBackBridge({ onBack }: { readonly onBack: () => void }): ReactElement {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onBack();
        return true;
      }
      return false;
    },
    [onBack],
  );
  useKeyInterpreter(handleKey, { keySource: useExclusiveTvKeySource });
  return <TvFocusAnchor testID="profile-submodal-tv-focus-anchor" hasTVPreferredFocus />;
}

/** Shared stylesheet for {@link ProfilePickerOverlay}. */
export const profilePickerStyles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
  },
  closeAnchor: {
    position: 'absolute',
    zIndex: 51,
  },
  scroll: {
    flex: 1,
  },
  centerContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 36,
  },
  title: {
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: 28,
    maxWidth: 880,
  },
  gridTv: {
    gap: 36,
    maxWidth: 1020,
  },
  addWrap: {
    width: 132,
    alignItems: 'center',
    gap: 10,
  },
  addCircle: {
    width: 120,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addLabel: {
    textAlign: 'center',
    maxWidth: 132,
  },
  subModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 52,
  },
  subModalContainer: {
    width: '100%',
    maxWidth: 500,
    maxHeight: '86%',
  },
  subModalScroll: {
    width: '100%',
    flexGrow: 0,
  },
  subModalScrollContent: {
    flexGrow: 1,
  },
});
