import { render, screen } from '@testing-library/react-native';
import { forwardRef, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { TvFocusGuideRegion } from '../TvFocusGuideRegion';

const reactNative = require('react-native') as {
  readonly TVFocusGuideView: unknown;
};

const forwardedCaptures: Array<Record<string, unknown>> = [];

const ForwardedGuide = forwardRef<unknown, Record<string, unknown>>((props, _ref) => {
  forwardedCaptures.push(props);
  return (
    <View testID={props.testID as string} style={props.style as never}>
      {props.children as ReactNode}
    </View>
  );
});

describe('TvFocusGuideRegion (#281, #130)', () => {
  afterEach(() => {
    forwardedCaptures.length = 0;
    jest.restoreAllMocks();
  });

  it('keeps native TVFocusGuideView visible (enabled={true}) and gates focusable/autoFocus/trapFocus* when enabled={false}', async () => {
    const receivedProps: Array<Record<string, unknown>> = [];
    const mockGuide = jest.fn((props: Record<string, unknown>) => {
      receivedProps.push(props);
      return (
        <View testID={props.testID as string} style={props.style as never}>
          {props.children as ReactNode}
        </View>
      );
    });
    jest.spyOn(reactNative, 'TVFocusGuideView', 'get').mockReturnValue(mockGuide);

    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const view = await render(
      <TvFocusGuideRegion
        testID="nav-region"
        enabled={false}
        autoFocus={true}
        trapFocusLeft
        trapFocusRight
        trapFocusUp
        trapFocusDown
        style={{ paddingHorizontal: 16 }}
      >
        <Text>Nav Item</Text>
      </TvFocusGuideRegion>,
    );

    expect(mockGuide).toHaveBeenCalledTimes(1);
    expect(receivedProps[0]).toMatchObject({
      testID: 'nav-region',
      enabled: true,
      autoFocus: false,
      focusable: false,
      style: { paddingHorizontal: 16 },
    });
    expect(receivedProps[0]).not.toHaveProperty('trapFocusLeft');
    expect(receivedProps[0]).not.toHaveProperty('trapFocusRight');
    expect(receivedProps[0]).not.toHaveProperty('trapFocusUp');
    expect(receivedProps[0]).not.toHaveProperty('trapFocusDown');
    expect(receivedProps[0]?.style).not.toEqual(expect.objectContaining({ display: 'none' }));
    expect(screen.getByText('Nav Item')).toBeTruthy();

    // When enabled={true} on tvOS, forwards autoFocus, omits focusable={false}, and passes trapFocus*
    jest.replaceProperty(Platform, 'OS', 'ios');
    await view.rerender(
      <TvFocusGuideRegion testID="nav-region" trapFocusLeft>
        <Text>Nav Item</Text>
      </TvFocusGuideRegion>,
    );
    expect(mockGuide).toHaveBeenCalledTimes(2);
    expect(receivedProps[1]).toMatchObject({
      enabled: true,
      autoFocus: true,
      trapFocusLeft: true,
    });
    expect(receivedProps[1]?.focusable).toBeUndefined();
    expect(receivedProps[1]).not.toHaveProperty('trapFocusRight');
    expect(receivedProps[1]).not.toHaveProperty('trapFocusUp');
    expect(receivedProps[1]).not.toHaveProperty('trapFocusDown');

    await view.unmount();
  });

  it('renders real react-native-tvos TVFocusGuideView visibly with display: flex on native TV', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const view = await render(
      <TvFocusGuideRegion testID="real-tv-guide" enabled={true} autoFocus trapFocusLeft>
        <Text>Visible Active Region</Text>
      </TvFocusGuideRegion>,
    );

    const guide = screen.getByTestId('real-tv-guide');
    const flatStyle = StyleSheet.flatten(guide.props.style);
    expect(flatStyle.display).toBe('flex');
    expect(guide.props.autoFocus).toBe(true);
    expect(guide.props.isTVSelectable).toBe(true);
    expect(guide.props.trapFocusLeft).toBe(true);
    expect(screen.getByText('Visible Active Region')).toBeTruthy();
    await view.unmount();
  });

  it('supports forwardRef/object TVFocusGuideView components ($$typeof)', async () => {
    jest.spyOn(reactNative, 'TVFocusGuideView', 'get').mockReturnValue(ForwardedGuide);
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const view = await render(
      <TvFocusGuideRegion testID="forwarded-region" enabled={false} trapFocusUp>
        <Text>Forwarded Child</Text>
      </TvFocusGuideRegion>,
    );

    expect(forwardedCaptures).toHaveLength(1);
    expect(forwardedCaptures[0]).toMatchObject({
      testID: 'forwarded-region',
      enabled: true,
      autoFocus: false,
      focusable: false,
    });
    expect(forwardedCaptures[0]).not.toHaveProperty('trapFocusUp');
    expect(screen.getByText('Forwarded Child')).toBeTruthy();
    await view.unmount();
  });

  it('falls back to a plain View on non-TV mobile platforms and web', async () => {
    const mockGuide = jest.fn(() => <View />);
    jest.spyOn(reactNative, 'TVFocusGuideView', 'get').mockReturnValue(mockGuide);

    // Non-TV Android phone
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);
    const phoneView = await render(
      <TvFocusGuideRegion testID="phone-region" enabled={false}>
        <Text>Phone Content</Text>
      </TvFocusGuideRegion>,
    );
    expect(mockGuide).not.toHaveBeenCalled();
    expect(screen.getByTestId('phone-region')).toBeTruthy();
    expect(screen.getByText('Phone Content')).toBeTruthy();
    await phoneView.unmount();

    // Web (even if Platform.isTV is true)
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const webView = await render(
      <TvFocusGuideRegion testID="web-region">
        <Text>Web Content</Text>
      </TvFocusGuideRegion>,
    );
    expect(mockGuide).not.toHaveBeenCalled();
    expect(screen.getByTestId('web-region')).toBeTruthy();
    expect(screen.getByText('Web Content')).toBeTruthy();
    await webView.unmount();
  });

  it('falls back to a plain View on native TV when TVFocusGuideView is unavailable', async () => {
    jest.spyOn(reactNative, 'TVFocusGuideView', 'get').mockReturnValue(undefined);
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const view = await render(
      <TvFocusGuideRegion testID="fallback-region" style={{ flex: 1 }}>
        <Text>Fallback Content</Text>
      </TvFocusGuideRegion>,
    );
    expect(screen.getByTestId('fallback-region')).toBeTruthy();
    expect(screen.getByText('Fallback Content')).toBeTruthy();
    await view.unmount();
  });
});
