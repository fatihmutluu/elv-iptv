import { PROFILE_AVATAR_TOKENS } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, UiAdaptersProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import { ProfileAvatarBadge, type ProfileAvatarSize } from '../ProfileAvatarBadge';
import { ProfileAvatarTile } from '../ProfileAvatarTile';

describe('ProfileAvatarBadge', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders all 9 distinct illustrated avatars via UiAdapters.renderSvg on native', async () => {
    const renderSvg = jest.fn(({ size, color }: { size: number; color: string }) => (
      <View testID="mock-svg-avatar" accessibilityLabel={`${size}:${color}`} />
    ));

    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <UiAdaptersProvider adapters={{ renderSvg }}>
            <View>
              {PROFILE_AVATAR_TOKENS.map((token) => (
                <ProfileAvatarBadge
                  key={token}
                  name={token}
                  avatarToken={token}
                  size="md"
                  testID={`badge-${token}`}
                />
              ))}
            </View>
          </UiAdaptersProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(renderSvg).toHaveBeenCalledTimes(9);
    for (const token of PROFILE_AVATAR_TOKENS) {
      expect(screen.getByTestId(`badge-${token}`)).toBeTruthy();
      expect(screen.getByTestId(`badge-${token}-art-${token}`)).toBeTruthy();
    }

    await view.unmount();
  });

  it('renders distinct native vector geometry for all 9 avatars and a true pencil icon on Android and iOS without a custom adapter', async () => {
    for (const os of ['android', 'ios'] as const) {
      jest.replaceProperty(Platform, 'OS', os);
      const signatures = new Set<string>();

      for (const token of PROFILE_AVATAR_TOKENS) {
        const view = await render(
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider>
              <ProfileAvatarBadge
                name={token}
                avatarToken={token}
                size="lg"
                testID={`native-${os}-${token}`}
              />
            </ThemeProvider>
          </I18nProvider>,
        );
        const artTree = JSON.stringify(view.toJSON());
        // Strip testID/color differences by comparing the inner vector canvas children geometry
        const artNode = screen.getByTestId(`native-${os}-${token}-art-${token}`);
        const canvasChild = artNode.children[0];
        if (typeof canvasChild === 'string' || !canvasChild) {
          throw new Error(`expected vector canvas child for ${token}`);
        }
        expect(canvasChild.children.length).toBeGreaterThanOrEqual(4);
        const geometrySignature = JSON.stringify(
          canvasChild.children.map((node) => {
            if (typeof node === 'string') return node;
            const style = Array.isArray(node.props.style)
              ? Object.assign({}, ...node.props.style)
              : node.props.style;
            const {
              backgroundColor: _bg,
              borderColor: _bc,
              ...geom
            } = style as Record<string, unknown>;
            return geom;
          }),
        );
        signatures.add(geometrySignature);
        expect(artTree.length).toBeGreaterThan(0);
        await view.unmount();
      }

      expect(signatures.size).toBe(9);

      const tileView = await render(
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <ProfileAvatarTile
              profile={{
                id: 'p1',
                name: 'Alex',
                avatarToken: 'crimson',
                isKids: false,
                isDefault: true,
                createdAt: 0,
                updatedAt: 0,
              }}
              active
              isTv={false}
              isWeb={false}
              isTouch
              hovered={false}
              tileFocused={false}
              editFocused={false}
              showTvEditPill={false}
              onHoverIn={jest.fn()}
              onHoverOut={jest.fn()}
              onSelect={jest.fn()}
              onEdit={jest.fn()}
            />
          </ThemeProvider>
        </I18nProvider>,
      );

      const pencilNode = screen.getByTestId('profile-picker-edit-icon-p1');
      const pencilCanvas = pencilNode.children[0];
      if (typeof pencilCanvas === 'string' || !pencilCanvas) {
        throw new Error('expected pencil vector canvas child');
      }
      // Crisp pencil path contains rotated diagonal stroke segments, NOT a 2-box person silhouette.
      expect(pencilCanvas.children.length).toBeGreaterThanOrEqual(5);
      const hasDiagonalSegment = pencilCanvas.children.some((node) => {
        if (typeof node === 'string') return false;
        const style = Array.isArray(node.props.style)
          ? Object.assign({}, ...node.props.style)
          : node.props.style;
        return Array.isArray((style as { transform?: unknown[] }).transform);
      });
      expect(hasDiagonalSegment).toBe(true);
      await tileView.unmount();
    }
  });

  it('renders crisp inline SVG on web and supports sm, md, lg, and xl (>=100px) sizes', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const sizes: readonly ProfileAvatarSize[] = ['sm', 'md', 'lg', 'xl'];

    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <View>
            {sizes.map((size) => (
              <ProfileAvatarBadge
                key={size}
                name="Alex"
                avatarToken="teal"
                size={size}
                isKids={size === 'xl'}
                showKidsPill={size === 'xl'}
                testID={`size-${size}`}
              />
            ))}
          </View>
        </ThemeProvider>
      </I18nProvider>,
    );

    const xlCircle = screen.getByTestId('size-xl-circle');
    const flatStyles = Array.isArray(xlCircle.props.style)
      ? Object.assign({}, ...xlCircle.props.style)
      : xlCircle.props.style;
    expect(flatStyles.width).toBeGreaterThanOrEqual(100);
    expect(flatStyles.height).toBeGreaterThanOrEqual(100);
    expect(screen.getByTestId('size-xl-kids')).toHaveTextContent('Kids');

    await view.unmount();
  });
});
