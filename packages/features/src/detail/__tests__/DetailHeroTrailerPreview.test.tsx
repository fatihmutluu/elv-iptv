import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import {
  DetailHeroTrailerPreview,
  type DetailHeroTrailerPreviewProps,
} from '../DetailHeroTrailerPreview';
import {
  buildYoutubeListeningHandshake,
  buildYoutubeMuteCommand,
  DETAIL_TRAILER_AUTOPLAY_DELAY_MS,
  DETAIL_TRAILER_PRELOAD_DELAY_MS,
} from '../detail-trailer-preview-model';

interface FakeDomNode {
  id: string;
  rel: string;
  href: string;
  textContent: string | null;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  remove(): void;
}

interface FakeDocument {
  visibilityState: 'visible' | 'hidden';
  head: {
    children: FakeDomNode[];
    appendChild(node: FakeDomNode): FakeDomNode;
    removeChild(node: FakeDomNode): FakeDomNode;
  };
  createElement(tag: string): FakeDomNode;
  getElementById(id: string): FakeDomNode | null;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  emitVisibility(next: 'visible' | 'hidden'): void;
}

function installFakeDocument(): { doc: FakeDocument; restore: () => void } {
  const prev = (globalThis as { document?: unknown }).document;
  const listeners = new Set<() => void>();
  const children: FakeDomNode[] = [];
  const doc: FakeDocument = {
    visibilityState: 'visible',
    head: {
      children,
      appendChild(node) {
        if (!children.includes(node)) children.push(node);
        return node;
      },
      removeChild(node) {
        const idx = children.indexOf(node);
        if (idx >= 0) children.splice(idx, 1);
        return node;
      },
    },
    createElement() {
      const attrs: Record<string, string> = {};
      const node: FakeDomNode = {
        id: '',
        rel: '',
        href: '',
        textContent: null,
        attributes: attrs,
        setAttribute(name, value) {
          attrs[name] = value;
        },
        getAttribute(name) {
          return attrs[name];
        },
        remove() {
          const idx = children.indexOf(node);
          if (idx >= 0) children.splice(idx, 1);
        },
      };
      return node;
    },
    getElementById(id) {
      return children.find((node) => node.id === id) ?? null;
    },
    addEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.delete(fn);
    },
    emitVisibility(next) {
      doc.visibilityState = next;
      for (const fn of [...listeners]) fn();
    },
  };
  (globalThis as { document?: unknown }).document = doc;
  return {
    doc,
    restore: () => {
      (globalThis as { document?: unknown }).document = prev;
    },
  };
}

interface FakeMessageEvent {
  readonly origin: string;
  readonly data: unknown;
}

function installFakeWindow() {
  const prev = (globalThis as { window?: unknown }).window;
  const listeners = new Set<(ev: FakeMessageEvent) => void>();
  const win = {
    addEventListener(type: string, fn: (ev: FakeMessageEvent) => void) {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener(type: string, fn: (ev: FakeMessageEvent) => void) {
      if (type === 'message') listeners.delete(fn);
    },
    emitMessage(ev: FakeMessageEvent) {
      for (const fn of [...listeners]) fn(ev);
    },
    listenerCount() {
      return listeners.size;
    },
  };
  (globalThis as { window?: unknown }).window = win;
  return {
    win,
    restore: () => {
      (globalThis as { window?: unknown }).window = prev;
    },
  };
}

function renderPreview(
  props: Partial<DetailHeroTrailerPreviewProps> = {},
  opts: { reduceMotion?: boolean } = {},
) {
  const merged: DetailHeroTrailerPreviewProps = {
    titleKey: 'movie:101',
    trailerStreamUrl: 'https://cdn.example.com/trailers/dune.mp4',
    trailerYoutubeId: '8g18jFHCLXk',
    muted: true,
    active: true,
    topOffset: 24,
    rightOffset: 32,
    isTv: false,
    onToggleMuted: jest.fn(),
    ...props,
  };
  const wrap = (next: DetailHeroTrailerPreviewProps) => (
    <ViewportProvider
      value={{
        formFactor: next.isTv ? 'tv' : 'desktop',
        orientation: 'landscape',
        inputModality: next.isTv ? 'tv' : 'pointer',
        width: 1280,
        height: 800,
      }}
    >
      <ThemeProvider preset="obsidianCrimson" reduceMotion={opts.reduceMotion ?? false}>
        <I18nProvider i18n={createAppI18n('en')}>
          <DetailHeroTrailerPreview {...next} />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  return {
    props: merged,
    wrap,
    view: render(wrap(merged)),
  };
}

function getMediaChild(includeHidden = false): ReturnType<typeof screen.getByTestId> {
  const media = screen.getByTestId('detail-trailer-preview-media', {
    includeHiddenElements: includeHidden,
  });
  const child = media.children[0];
  if (typeof child === 'string' || child === undefined) {
    throw new Error('Expected rendered media child element');
  }
  return child;
}

describe('DetailHeroTrailerPreview', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders nothing under reduceMotion, on TV, on native platforms, or with invalid sources', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const reduced = await renderPreview({}, { reduceMotion: true }).view;
    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS + 500);
    });
    expect(screen.queryByTestId('detail-trailer-preview')).toBeNull();
    expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();
    await reduced.unmount();

    const tv = await renderPreview({ isTv: true }).view;
    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS + 500);
    });
    expect(screen.queryByTestId('detail-trailer-preview')).toBeNull();
    await tv.unmount();

    jest.replaceProperty(Platform, 'OS', 'android');
    const native = await renderPreview({ isTv: false }).view;
    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS + 500);
    });
    expect(screen.queryByTestId('detail-trailer-preview')).toBeNull();
    await native.unmount();
  });

  it('preloads paused HTML5 <video> at 400ms, starts muted playback + mute button at 2500ms, toggles mute, and resets on error', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const onToggleMuted = jest.fn();
    const { props, wrap, view: viewPromise } = renderPreview({ onToggleMuted });
    const view = await viewPromise;

    // 0ms..399ms: idle, no video or mute toggle spawned yet
    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_PRELOAD_DELAY_MS - 1);
    });
    expect(screen.queryByTestId('detail-trailer-preview-media')).toBeNull();
    expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

    // 400ms: preloading mounted paused & hidden (opacity 0), mute toggle still hidden
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    const media = screen.getByTestId('detail-trailer-preview-media', {
      includeHiddenElements: true,
    });
    expect(media.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 0 })]),
    );
    const videoEl = getMediaChild(true);
    expect(videoEl.type).toBe('video');
    expect(videoEl.props.src).toBe('https://cdn.example.com/trailers/dune.mp4');
    expect(videoEl.props.preload).toBe('auto');
    expect(videoEl.props.autoPlay).toBe(false);
    expect(videoEl.props.muted).toBe(true);
    expect(videoEl.props.loop).toBe(true);
    expect(videoEl.props.playsInline).toBe(true);
    expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

    // 2500ms: playing — reveals video + top-right circular mute toggle
    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS - DETAIL_TRAILER_PRELOAD_DELAY_MS);
    });
    const playingMedia = screen.getByTestId('detail-trailer-preview-media');
    expect(playingMedia.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 1 })]),
    );
    const playingVideoEl = getMediaChild(false);
    expect(playingVideoEl.props.autoPlay).toBe(true);
    expect(playingVideoEl.props.muted).toBe(true);

    const muteAnchor = screen.getByTestId('detail-trailer-mute-anchor');
    expect(StyleSheet.flatten(muteAnchor.props.style)).toMatchObject({
      position: 'absolute',
      top: 24,
      right: 32,
      zIndex: 6,
    });
    const muteBtn = screen.getByTestId('detail-trailer-mute-toggle');
    expect(muteBtn.props.accessibilityLabel).toBe('Unmute preview');
    expect(screen.getByTestId('detail-trailer-mute-toggle-icon')).toBeTruthy();

    await fireEvent.press(muteBtn);
    expect(onToggleMuted).toHaveBeenCalledTimes(1);

    await view.rerender(wrap({ ...props, muted: false }));
    expect(getMediaChild(false).props.muted).toBe(false);
    expect(screen.getByTestId('detail-trailer-mute-toggle').props.accessibilityLabel).toBe(
      'Mute preview',
    );

    // Stream failure falls back cleanly to idle (static backdrop underneath)
    await act(async () => {
      playingVideoEl.props.onError();
    });
    expect(screen.queryByTestId('detail-trailer-preview-media')).toBeNull();
    expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

    await view.unmount();
  });

  it('preconnects YouTube at 400ms, mounts iframe only at 2500ms, and syncs mute via postMessage', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const { doc, restore } = installFakeDocument();
    const postMessage = jest.fn();
    const iframeNode = { contentWindow: { postMessage } };

    try {
      const {
        props,
        wrap,
        view: viewPromise,
      } = renderPreview({
        trailerStreamUrl: null,
        trailerYoutubeId: '8g18jFHCLXk',
        muted: true,
      });
      const view = await viewPromise;

      // 400ms: preconnect link added, iframe NOT mounted yet
      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_PRELOAD_DELAY_MS);
      });
      const preconnectLinks = doc.head.children.filter((node) => node.rel === 'preconnect');
      expect(preconnectLinks).toHaveLength(1);
      expect(preconnectLinks[0]?.href).toBe('https://www.youtube-nocookie.com');
      expect(screen.queryByTestId('detail-trailer-preview-media')).toBeNull();
      expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

      // 2500ms: iframe mounted & mute toggle visible
      await act(async () => {
        jest.advanceTimersByTime(
          DETAIL_TRAILER_AUTOPLAY_DELAY_MS - DETAIL_TRAILER_PRELOAD_DELAY_MS,
        );
      });
      const iframeEl = getMediaChild(false);
      expect(iframeEl.type).toBe('iframe');
      expect(iframeEl.props.src).toContain('https://www.youtube-nocookie.com/embed/8g18jFHCLXk?');
      expect(iframeEl.props.src).toContain('enablejsapi=1');
      expect(iframeEl.props.tabIndex).toBe(-1);
      expect(iframeEl.props['aria-hidden']).toBe(true);
      expect(iframeEl.props.allow).toBe('autoplay; encrypted-media');
      expect(screen.getByTestId('detail-trailer-mute-toggle')).toBeTruthy();

      await act(async () => {
        iframeEl.props.onLoad({ currentTarget: iframeNode });
      });
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeListeningHandshake(),
        'https://www.youtube-nocookie.com',
      );
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeMuteCommand(true),
        'https://www.youtube-nocookie.com',
      );

      await view.rerender(wrap({ ...props, muted: false }));
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeMuteCommand(false),
        'https://www.youtube-nocookie.com',
      );

      await view.unmount();
      expect(doc.head.children.filter((node) => node.rel === 'preconnect')).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('completes YouTube listening/onReady/infoDelivery handshake, verifies origin, retries boundedly, and cleans up listeners/timers', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const { restore: restoreDoc } = installFakeDocument();
    const { win, restore: restoreWin } = installFakeWindow();
    const postMessage = jest.fn();
    const iframeNode = { contentWindow: { postMessage } };

    try {
      const { view: viewPromise } = renderPreview({
        trailerStreamUrl: null,
        trailerYoutubeId: '8g18jFHCLXk',
        muted: false,
      });
      const view = await viewPromise;

      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
      });
      expect(win.listenerCount()).toBe(1);

      const iframeEl = getMediaChild(false);
      await act(async () => {
        iframeEl.props.onLoad({ currentTarget: iframeNode });
      });
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeListeningHandshake(),
        'https://www.youtube-nocookie.com',
      );
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeMuteCommand(false),
        'https://www.youtube-nocookie.com',
      );

      // Untrusted origin is ignored
      postMessage.mockClear();
      await act(async () => {
        win.emitMessage({
          origin: 'https://evil.example',
          data: JSON.stringify({ event: 'onReady' }),
        });
      });
      expect(postMessage).not.toHaveBeenCalled();

      // First infoDelivery re-syncs unMute once; subsequent infoDelivery does not spam
      await act(async () => {
        win.emitMessage({
          origin: 'https://www.youtube-nocookie.com',
          data: JSON.stringify({ event: 'infoDelivery', info: {} }),
        });
      });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeMuteCommand(false),
        'https://www.youtube-nocookie.com',
      );

      postMessage.mockClear();
      await act(async () => {
        win.emitMessage({
          origin: 'https://www.youtube-nocookie.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 1 } }),
        });
      });
      expect(postMessage).not.toHaveBeenCalled();

      // Bounded retry at 400ms fires when onReady has not arrived yet
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeMuteCommand(false),
        'https://www.youtube-nocookie.com',
      );

      // onReady re-syncs immediately and cancels remaining 1000ms retry
      postMessage.mockClear();
      await act(async () => {
        win.emitMessage({
          origin: 'https://www.youtube-nocookie.com',
          data: JSON.stringify({ event: 'onReady' }),
        });
      });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        buildYoutubeMuteCommand(false),
        'https://www.youtube-nocookie.com',
      );

      postMessage.mockClear();
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(postMessage).not.toHaveBeenCalled();

      // Verify retry timer + listener cleanup when unmounting before retries fire
      await act(async () => {
        iframeEl.props.onLoad({ currentTarget: iframeNode });
      });
      postMessage.mockClear();
      await view.unmount();
      expect(win.listenerCount()).toBe(0);

      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      restoreWin();
      restoreDoc();
    }
  });

  it('supports hideMuteButton + onPlayingChange transitions across titleKey, active, visibility, and unmount', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const { doc, restore } = installFakeDocument();
    const onPlayingChange = jest.fn();

    try {
      const {
        props,
        wrap,
        view: viewPromise,
      } = renderPreview({
        titleKey: 'movie:1',
        trailerStreamUrl: 'https://cdn.example.com/trailers/one.mp4',
        trailerYoutubeId: null,
        hideMuteButton: true,
        onPlayingChange,
      });
      const view = await viewPromise;

      expect(onPlayingChange).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
      });
      expect(onPlayingChange).toHaveBeenCalledTimes(1);
      expect(onPlayingChange).toHaveBeenLastCalledWith(true);
      expect(screen.getByTestId('detail-trailer-preview-media')).toBeTruthy();
      expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

      // Switch titleKey -> emits false immediately
      await view.rerender(
        wrap({
          ...props,
          titleKey: 'movie:2',
          trailerStreamUrl: 'https://cdn.example.com/trailers/two.mp4',
        }),
      );
      expect(onPlayingChange).toHaveBeenLastCalledWith(false);

      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
      });
      expect(onPlayingChange).toHaveBeenLastCalledWith(true);

      // visibility hidden -> emits false
      await act(async () => {
        doc.emitVisibility('hidden');
      });
      expect(onPlayingChange).toHaveBeenLastCalledWith(false);

      await act(async () => {
        doc.emitVisibility('visible');
      });
      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
      });
      expect(onPlayingChange).toHaveBeenLastCalledWith(true);

      // Unmount while playing -> emits false cleanly
      const callsBeforeUnmount = onPlayingChange.mock.calls.length;
      await view.unmount();
      expect(onPlayingChange).toHaveBeenCalledTimes(callsBeforeUnmount + 1);
      expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    } finally {
      restore();
    }
  });

  it('falls back to muted HTML5 <video> playback when unmuted play() rejects (e.g. NotAllowedError)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const playMock = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    const pauseMock = jest.fn();

    const { view: viewPromise } = renderPreview({
      muted: false,
      trailerStreamUrl: 'https://cdn.example.com/trailers/dune.mp4',
      trailerYoutubeId: null,
    });
    const view = await viewPromise;

    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_PRELOAD_DELAY_MS);
    });
    const preloadingVideo = getMediaChild(true) as unknown as {
      muted: boolean;
      play: () => Promise<void>;
      pause: () => void;
    };
    preloadingVideo.play = playMock;
    preloadingVideo.pause = pauseMock;

    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS - DETAIL_TRAILER_PRELOAD_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(playMock).toHaveBeenCalledTimes(2);
    expect(preloadingVideo.muted).toBe(true);

    await view.unmount();
  });

  it('tears down immediately on titleKey change, active=false, and document hidden visibilitychange', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const { doc, restore } = installFakeDocument();

    try {
      const {
        props,
        wrap,
        view: viewPromise,
      } = renderPreview({
        titleKey: 'movie:101',
        trailerStreamUrl: 'https://cdn.example.com/trailers/one.mp4',
        trailerYoutubeId: null,
      });
      const view = await viewPromise;

      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
      });
      expect(screen.getByTestId('detail-trailer-mute-toggle')).toBeTruthy();

      // Switch titleKey -> immediate idle reset (fresh settle required)
      await view.rerender(
        wrap({
          ...props,
          titleKey: 'movie:202',
          trailerStreamUrl: 'https://cdn.example.com/trailers/two.mp4',
        }),
      );
      expect(screen.queryByTestId('detail-trailer-preview-media')).toBeNull();
      expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
      });
      expect(screen.getByTestId('detail-trailer-mute-toggle')).toBeTruthy();

      // document hidden -> immediate teardown
      await act(async () => {
        doc.emitVisibility('hidden');
      });
      expect(screen.queryByTestId('detail-trailer-preview-media')).toBeNull();
      expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

      // visible again -> waits fresh dwell before playing
      await act(async () => {
        doc.emitVisibility('visible');
      });
      expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
      });
      expect(screen.getByTestId('detail-trailer-mute-toggle')).toBeTruthy();

      // active=false (Play / Modal open) -> immediate teardown
      await view.rerender(
        wrap({
          ...props,
          titleKey: 'movie:202',
          trailerStreamUrl: 'https://cdn.example.com/trailers/two.mp4',
          active: false,
        }),
      );
      expect(screen.queryByTestId('detail-trailer-preview-media')).toBeNull();
      expect(screen.queryByTestId('detail-trailer-mute-toggle')).toBeNull();

      await view.unmount();
    } finally {
      restore();
    }
  });
});
