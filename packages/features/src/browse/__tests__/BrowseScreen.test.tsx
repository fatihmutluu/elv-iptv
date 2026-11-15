import { createAppI18n } from '@elv/i18n';
import { type FormFactor, FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import type { PlayTarget } from '../../ports/play-target';
import { BrowseScreen, type BrowseScreenProps } from '../BrowseScreen';
import { EMPTY_TAB_MEMORY, type TabBrowseMemory } from '../browse-model';
import { openBrowseTestCatalog } from './browse-test-harness';

function StatefulBrowse({
  formFactor,
  ...props
}: Omit<BrowseScreenProps, 'memory' | 'onMemoryChange'> & { formFactor: FormFactor }) {
  const [memory, setMemory] = useState<TabBrowseMemory>(EMPTY_TAB_MEMORY);
  return (
    <FormFactorProvider value={formFactor}>
      <I18nProvider i18n={createAppI18n('en')}>
        <BrowseScreen {...props} memory={memory} onMemoryChange={setMemory} />
      </I18nProvider>
    </FormFactorProvider>
  );
}

describe('BrowseScreen paging, movies, and empty states', () => {
  it('pages a 25,000-channel category in <= 2 SQLite items() calls and resolves middle playlist items on demand', async () => {
    const env = await openBrowseTestCatalog({ liveCount: 25_000 });
    try {
      const sources = await env.addAndImport('Main');
      const itemsSpy = jest.spyOn(env.catalog, 'items');
      const onPlay = jest.fn<void, [PlayTarget]>();

      const view = await render(
        <StatefulBrowse
          formFactor="desktop"
          kind="live"
          catalog={env.catalog}
          sources={sources}
          refreshToken={1}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('1. Channel 1')).toBeTruthy();
      });

      expect(screen.getByText('General (25000)')).toBeTruthy();
      expect(itemsSpy.mock.calls.length).toBeLessThanOrEqual(2);
      for (const [, offset, limit] of itemsSpy.mock.calls) {
        expect(offset).toBe(0);
        expect(limit).toBe(200);
      }
      expect(JSON.stringify(view.toJSON())).not.toContain('"type":"Image"');

      await fireEvent.press(screen.getByTestId('browse-items-list-row-3'));

      await waitFor(() => {
        expect(onPlay).toHaveBeenCalledTimes(1);
      });

      const target = onPlay.mock.calls[0]?.[0];
      expect(target).toBeDefined();
      expect(target?.kind).toBe('live');
      expect(target?.title).toBe('4. Channel 4');
      expect(target?.playlist?.count).toBe(25_000);
      expect(target?.playlist?.currentIndex).toBe(3);

      const mid = await target?.playlist?.getAt(12_500);
      expect(mid).toEqual({
        itemKey: expect.stringContaining(':live:'),
        sourceId: sources[0]?.id,
        title: '12501. Channel 12501',
        kind: 'live',
      });
      expect(itemsSpy).toHaveBeenCalledWith(expect.any(String), 12_400, 200);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('activates a movie as kind="vod" without a live playlist and prefixes categories when multiple sources exist', async () => {
    const env = await openBrowseTestCatalog({ liveCount: 2 });
    try {
      await env.addAndImport('Alpha');
      const sources = await env.addAndImport('Beta');
      const onPlay = jest.fn<void, [PlayTarget]>();

      const view = await render(
        <StatefulBrowse
          formFactor="tablet"
          kind="movie"
          catalog={env.catalog}
          sources={sources}
          refreshToken={1}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Alpha — Feature Films (1)')).toBeTruthy();
        expect(screen.getByText('Beta — Feature Films (1)')).toBeTruthy();
        expect(screen.getByText('Synthetic Movie One (2024)')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('browse-items-list-row-0'));

      await waitFor(() => {
        expect(onPlay).toHaveBeenCalledTimes(1);
      });
      expect(onPlay.mock.calls[0]?.[0]).toEqual({
        itemKey: expect.stringContaining(':movie:201'),
        sourceId: sources[0]?.id,
        title: 'Synthetic Movie One (2024)',
        kind: 'vod',
      });
      expect(onPlay.mock.calls[0]?.[0]?.playlist).toBeUndefined();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('renders emptyNoSources + browse-open-sources when no ready sources exist', async () => {
    const env = await openBrowseTestCatalog({ liveCount: 2 });
    try {
      const onOpenSources = jest.fn();
      const view = await render(
        <FormFactorProvider value="phone">
          <I18nProvider i18n={createAppI18n('en')}>
            <BrowseScreen
              kind="live"
              catalog={env.catalog}
              sources={[]}
              refreshToken={0}
              memory={EMPTY_TAB_MEMORY}
              onMemoryChange={jest.fn()}
              onPlay={jest.fn()}
              onOpenSources={onOpenSources}
            />
          </I18nProvider>
        </FormFactorProvider>,
      );

      expect(
        screen.getByText('No sources ready yet. Add or import a source to browse.'),
      ).toBeTruthy();
      await fireEvent.press(screen.getByTestId('browse-open-sources'));
      expect(onOpenSources).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
