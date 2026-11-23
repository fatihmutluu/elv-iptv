import { type ImageAdapterProps, ThemeProvider, UiAdaptersProvider } from '@elv/ui-kit';
import { act, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Animated, View } from 'react-native';
import {
  AMBIENT_BACKDROP_CROSSFADE_MS,
  AMBIENT_BACKDROP_DEBOUNCE_MS,
  AmbientBackdrop,
} from '../AmbientBackdrop';

function TestProviders({
  reduceMotion = false,
  lowPowerTier,
  onRenderImage,
  children,
}: {
  reduceMotion?: boolean;
  lowPowerTier?: boolean;
  onRenderImage?: (props: ImageAdapterProps) => void;
  children: ReactNode;
}) {
  const renderImage = (props: ImageAdapterProps) => {
    onRenderImage?.(props);
    return <View testID={`adapter-img:${props.uri}:${props.maxDecodePx ?? 'none'}`} />;
  };
  return (
    <ThemeProvider reduceMotion={reduceMotion}>
      <UiAdaptersProvider
        adapters={{ renderImage, ...(lowPowerTier !== undefined ? { lowPowerTier } : {}) }}
      >
        {children}
      </UiAdaptersProvider>
    </ThemeProvider>
  );
}

describe('AmbientBackdrop (#414)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('debounces rapid focus changes by 500ms so intermediate cards never load artwork', async () => {
    const renderedUris: string[] = [];
    const onRenderImage = (p: ImageAdapterProps) => renderedUris.push(p.uri);

    const view = await render(
      <TestProviders onRenderImage={onRenderImage}>
        <AmbientBackdrop backdropKey="card-1" uri="https://cdn.example/1.jpg" title="Card 1" />
      </TestProviders>,
    );

    expect(screen.queryByTestId('ambient-backdrop')).toBeNull();
    expect(renderedUris).toEqual([]);

    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS - 100);
    });
    expect(renderedUris).toEqual([]);

    await view.rerender(
      <TestProviders onRenderImage={onRenderImage}>
        <AmbientBackdrop backdropKey="card-2" uri="https://cdn.example/2.jpg" title="Card 2" />
      </TestProviders>,
    );
    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS - 50);
    });
    expect(renderedUris).toEqual([]);

    await view.rerender(
      <TestProviders onRenderImage={onRenderImage}>
        <AmbientBackdrop backdropKey="card-3" uri="https://cdn.example/3.jpg" title="Card 3" />
      </TestProviders>,
    );
    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });

    expect(screen.getByTestId('ambient-backdrop')).toBeTruthy();
    expect(renderedUris).toEqual(['https://cdn.example/3.jpg']);
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/3.jpg:960', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();

    await view.unmount();
  });

  it('crossfades smoothly over 320ms when switching committed backdrops with motion enabled', async () => {
    const timingSpy = jest.spyOn(Animated, 'timing');

    const view = await render(
      <TestProviders reduceMotion={false}>
        <AmbientBackdrop backdropKey="a" uri="https://cdn.example/a.jpg" title="A" />
      </TestProviders>,
    );

    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/a.jpg:960', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();

    timingSpy.mockClear();
    await view.rerender(
      <TestProviders reduceMotion={false}>
        <AmbientBackdrop backdropKey="b" uri="https://cdn.example/b.jpg" title="B" />
      </TestProviders>,
    );
    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });

    expect(timingSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toValue: 1,
        duration: AMBIENT_BACKDROP_CROSSFADE_MS,
      }),
    );
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/b.jpg:960', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_CROSSFADE_MS + 50);
    });
    expect(
      screen.queryByTestId('ambient-backdrop-prev', { includeHiddenElements: true }),
    ).toBeNull();

    await view.unmount();
  });

  it('performs an instant single-layer swap with no animation when reduceMotion is true', async () => {
    const timingSpy = jest.spyOn(Animated, 'timing');

    const view = await render(
      <TestProviders reduceMotion>
        <AmbientBackdrop backdropKey="a" uri="https://cdn.example/a.jpg" title="A" />
      </TestProviders>,
    );

    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/a.jpg:960', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
    expect(timingSpy).not.toHaveBeenCalled();

    await view.rerender(
      <TestProviders reduceMotion>
        <AmbientBackdrop backdropKey="b" uri="https://cdn.example/b.jpg" title="B" />
      </TestProviders>,
    );
    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });

    expect(timingSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId('ambient-backdrop-prev', { includeHiddenElements: true }),
    ).toBeNull();
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/b.jpg:960', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();

    await view.unmount();
  });

  it('uses single-layer 640px low-decode mode without dual-layer animation on lowPowerTier', async () => {
    const timingSpy = jest.spyOn(Animated, 'timing');

    const view = await render(
      <TestProviders reduceMotion={false}>
        <AmbientBackdrop backdropKey="a" uri="https://cdn.example/a.jpg" lowPowerTier />
      </TestProviders>,
    );

    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/a.jpg:640', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();

    await view.rerender(
      <TestProviders reduceMotion={false}>
        <AmbientBackdrop backdropKey="b" uri="https://cdn.example/b.jpg" lowPowerTier />
      </TestProviders>,
    );
    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });

    expect(timingSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId('ambient-backdrop-prev', { includeHiddenElements: true }),
    ).toBeNull();
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/b.jpg:640', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();

    await view.unmount();
  });

  it('inherits lowPowerTier from UiAdaptersProvider when prop is omitted', async () => {
    const timingSpy = jest.spyOn(Animated, 'timing');

    const view = await render(
      <TestProviders reduceMotion={false} lowPowerTier>
        <AmbientBackdrop backdropKey="a" uri="https://cdn.example/a.jpg" />
      </TestProviders>,
    );

    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });
    expect(timingSpy).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('adapter-img:https://cdn.example/a.jpg:640', {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();

    await view.unmount();
  });

  it('clears cleanly when uri becomes null or empty', async () => {
    const view = await render(
      <TestProviders reduceMotion>
        <AmbientBackdrop backdropKey="a" uri="https://cdn.example/a.jpg" />
      </TestProviders>,
    );

    await act(async () => {
      jest.advanceTimersByTime(AMBIENT_BACKDROP_DEBOUNCE_MS);
    });
    expect(screen.getByTestId('ambient-backdrop')).toBeTruthy();

    await view.rerender(
      <TestProviders reduceMotion>
        <AmbientBackdrop backdropKey="a" uri={null} />
      </TestProviders>,
    );
    expect(screen.queryByTestId('ambient-backdrop')).toBeNull();

    await view.unmount();
  });
});
