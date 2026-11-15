import { createAppI18n } from '@elv/i18n';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { I18nProvider, useI18n } from '../i18n';

function TitleProbe() {
  const i18n = useI18n();
  return <Text testID="title">{`${i18n.locale}:${i18n.t('sources.title')}`}</Text>;
}

describe('I18nProvider and useI18n', () => {
  it('renders localized strings and re-renders when setLocale is called', async () => {
    const i18n = createAppI18n('en');
    await render(
      <I18nProvider i18n={i18n}>
        <TitleProbe />
      </I18nProvider>,
    );

    expect(screen.getByTestId('title')).toHaveTextContent('en:Sources');

    await act(async () => {
      i18n.setLocale('tr');
    });

    expect(screen.getByTestId('title')).toHaveTextContent('tr:Kaynaklar');
  });

  it('provides a default English fallback instance outside I18nProvider', async () => {
    await render(<TitleProbe />);
    expect(screen.getByTestId('title')).toHaveTextContent('en:Sources');
  });
});
