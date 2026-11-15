import { render, screen } from '@testing-library/react-native';
import { Dimensions, Platform, Text } from 'react-native';
import {
  detectFormFactor,
  type FormFactor,
  FormFactorProvider,
  useFormFactor,
} from '../form-factor';

function FormFactorProbe() {
  const formFactor = useFormFactor();
  return <Text testID="ff-value">{formFactor}</Text>;
}

describe('detectFormFactor and useFormFactor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('classifies tv, desktop, tablet, and phone accurately', () => {
    expect(detectFormFactor({ isTV: true, os: 'android', width: 320, height: 240 })).toBe('tv');
    expect(detectFormFactor({ isTV: true, os: 'web', width: 1920, height: 1080 })).toBe('tv');
    expect(detectFormFactor({ isTV: false, os: 'web', width: 375, height: 667 })).toBe('desktop');
    expect(detectFormFactor({ isTV: false, os: 'ios', width: 768, height: 1024 })).toBe('tablet');
    expect(detectFormFactor({ isTV: false, os: 'android', width: 960, height: 600 })).toBe(
      'tablet',
    );
    expect(detectFormFactor({ isTV: false, os: 'ios', width: 390, height: 844 })).toBe('phone');
    expect(detectFormFactor({ isTV: false, os: 'android', width: 599, height: 900 })).toBe('phone');
  });

  it.each<FormFactor>(['tv', 'phone', 'tablet', 'desktop'])(
    'returns explicit FormFactorProvider override %s',
    async (override) => {
      await render(
        <FormFactorProvider value={override}>
          <FormFactorProbe />
        </FormFactorProvider>,
      );
      expect(screen.getByTestId('ff-value')).toHaveTextContent(override);
    },
  );

  it('derives form factor from platform and window dimensions when no override is supplied', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: 820,
      height: 1180,
      scale: 2,
      fontScale: 1,
    });

    await render(
      <FormFactorProvider>
        <FormFactorProbe />
      </FormFactorProvider>,
    );
    expect(screen.getByTestId('ff-value')).toHaveTextContent('tablet');
  });

  it('falls back to detected form factor even without FormFactorProvider', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await render(<FormFactorProbe />);
    expect(screen.getByTestId('ff-value')).toHaveTextContent('tv');
  });
});
