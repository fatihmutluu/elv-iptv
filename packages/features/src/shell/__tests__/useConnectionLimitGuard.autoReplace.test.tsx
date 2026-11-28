import type { SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { createConnectionTracker } from '@elv/playback';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render } from '@testing-library/react-native';
import { type ReactElement, useRef } from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { StreamHealthProvider } from '../../shared';
import { useConnectionLimitGuard } from '../useConnectionLimitGuard';

async function wrapUi(node: ReactElement) {
  const i18n = createAppI18n('en');
  return render(
    <ViewportProvider
      value={{
        width: 1280,
        height: 720,
        formFactor: 'desktop',
        inputModality: 'pointer',
      }}
    >
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <StreamHealthProvider>{node}</StreamHealthProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>,
  );
}

function makeSource(id: string, maxConnections: number, activeConnections?: number): SourceRow {
  return {
    id,
    name: 'Provider',
    kind: 'xtream',
    needsImport: false,
    accountMeta: {
      maxConnections,
      ...(activeConnections !== undefined ? { activeConnections } : {}),
    },
  } as SourceRow;
}

const TARGET: PlayTarget = {
  itemKey: 'live:src-1:202',
  sourceId: 'src-1',
  title: 'Channel 202',
  kind: 'live',
  itemKind: 'live',
};

function GuardHarness({
  sources,
  tracker,
  autoReplaceSingleConnection,
  onOpenTarget,
  onStopOtherStream,
  onGuard,
}: {
  sources: readonly SourceRow[];
  tracker: ReturnType<typeof createConnectionTracker>;
  autoReplaceSingleConnection?: boolean;
  onOpenTarget: (target: PlayTarget) => void;
  onStopOtherStream: (streamId: string) => void;
  onGuard: (guard: ReturnType<typeof useConnectionLimitGuard>) => void;
}) {
  const sourcesRef = useRef(sources);
  const guard = useConnectionLimitGuard({
    sourcesRef,
    enrichTarget: (t) => t,
    connectionTracker: tracker,
    onOpenTarget,
    onReplaceTarget: jest.fn(),
    onStopOtherStream,
    ...(autoReplaceSingleConnection !== undefined ? { autoReplaceSingleConnection } : {}),
  });
  onGuard(guard);
  return <View />;
}

describe('useConnectionLimitGuard opt-in autoReplaceSingleConnection (Wave Q7-B)', () => {
  it('auto-stops local active stream and plays immediately when autoReplaceSingleConnection=true and maxConnections=1', async () => {
    const tracker = createConnectionTracker();
    tracker.acquire('src-1', 'live-embed:1');
    const onOpenTarget = jest.fn();
    const onStopOtherStream = jest.fn();
    const guardBox: { current: ReturnType<typeof useConnectionLimitGuard> | null } = {
      current: null,
    };

    const view = await wrapUi(
      <GuardHarness
        sources={[makeSource('src-1', 1)]}
        tracker={tracker}
        autoReplaceSingleConnection
        onOpenTarget={onOpenTarget}
        onStopOtherStream={onStopOtherStream}
        onGuard={(g) => {
          guardBox.current = g;
        }}
      />,
    );

    await act(async () => {
      guardBox.current?.requestPlay(TARGET);
    });

    expect(guardBox.current?.pending).toBeNull();
    expect(onStopOtherStream).toHaveBeenCalledTimes(1);
    expect(onStopOtherStream).toHaveBeenCalledWith('live-embed:1');
    expect(onOpenTarget).toHaveBeenCalledTimes(1);
    expect(onOpenTarget).toHaveBeenCalledWith(TARGET);
    expect(tracker.activeCount('src-1')).toBe(1);
    await view.unmount();
  });

  it('keeps ConnectionLimitDialog prompt when autoReplaceSingleConnection is false (default)', async () => {
    const tracker = createConnectionTracker();
    tracker.acquire('src-1', 'live-embed:1');
    const onOpenTarget = jest.fn();
    const onStopOtherStream = jest.fn();
    const guardBox: { current: ReturnType<typeof useConnectionLimitGuard> | null } = {
      current: null,
    };

    const view = await wrapUi(
      <GuardHarness
        sources={[makeSource('src-1', 1)]}
        tracker={tracker}
        autoReplaceSingleConnection={false}
        onOpenTarget={onOpenTarget}
        onStopOtherStream={onStopOtherStream}
        onGuard={(g) => {
          guardBox.current = g;
        }}
      />,
    );

    await act(async () => {
      guardBox.current?.requestPlay(TARGET);
    });

    expect(guardBox.current?.pending).not.toBeNull();
    expect(onStopOtherStream).not.toHaveBeenCalled();
    expect(onOpenTarget).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('keeps ConnectionLimitDialog prompt when maxConnections > 1 even if autoReplaceSingleConnection=true', async () => {
    const tracker = createConnectionTracker();
    tracker.acquire('src-1', 'multiview:1');
    tracker.acquire('src-1', 'multiview:2');
    const onOpenTarget = jest.fn();
    const onStopOtherStream = jest.fn();
    const guardBox: { current: ReturnType<typeof useConnectionLimitGuard> | null } = {
      current: null,
    };

    const view = await wrapUi(
      <GuardHarness
        sources={[makeSource('src-1', 2)]}
        tracker={tracker}
        autoReplaceSingleConnection
        onOpenTarget={onOpenTarget}
        onStopOtherStream={onStopOtherStream}
        onGuard={(g) => {
          guardBox.current = g;
        }}
      />,
    );

    await act(async () => {
      guardBox.current?.requestPlay(TARGET);
    });

    expect(guardBox.current?.pending).not.toBeNull();
    expect(onStopOtherStream).not.toHaveBeenCalled();
    expect(onOpenTarget).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('keeps ConnectionLimitDialog prompt when a remote device holds the single slot (no local stoppableStreamId)', async () => {
    const tracker = createConnectionTracker();
    const onOpenTarget = jest.fn();
    const onStopOtherStream = jest.fn();
    const guardBox: { current: ReturnType<typeof useConnectionLimitGuard> | null } = {
      current: null,
    };

    const view = await wrapUi(
      <GuardHarness
        sources={[makeSource('src-1', 1, 1)]}
        tracker={tracker}
        autoReplaceSingleConnection
        onOpenTarget={onOpenTarget}
        onStopOtherStream={onStopOtherStream}
        onGuard={(g) => {
          guardBox.current = g;
        }}
      />,
    );

    await act(async () => {
      guardBox.current?.requestPlay(TARGET);
    });

    expect(guardBox.current?.pending).not.toBeNull();
    expect(guardBox.current?.pending?.check.stoppableStreamId).toBeUndefined();
    expect(onStopOtherStream).not.toHaveBeenCalled();
    expect(onOpenTarget).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('MAJOR-7: keeps ConnectionLimitDialog when remote device holds an extra slot (providerActiveCons > ownActiveCount) even with local stoppableStreamId', async () => {
    const tracker = createConnectionTracker();
    tracker.acquire('src-1', 'live-embed:1');
    const onOpenTarget = jest.fn();
    const onStopOtherStream = jest.fn();
    const guardBox: { current: ReturnType<typeof useConnectionLimitGuard> | null } = {
      current: null,
    };

    const view = await wrapUi(
      <GuardHarness
        sources={[makeSource('src-1', 1, 2)]}
        tracker={tracker}
        autoReplaceSingleConnection
        onOpenTarget={onOpenTarget}
        onStopOtherStream={onStopOtherStream}
        onGuard={(g) => {
          guardBox.current = g;
        }}
      />,
    );

    await act(async () => {
      guardBox.current?.requestPlay(TARGET);
    });

    expect(guardBox.current?.pending).not.toBeNull();
    expect(guardBox.current?.pending?.check.stoppableStreamId).toBe('live-embed:1');
    expect(guardBox.current?.pending?.check.providerActiveCons).toBe(2);
    expect(onStopOtherStream).not.toHaveBeenCalled();
    expect(onOpenTarget).not.toHaveBeenCalled();
    await view.unmount();
  });
});
