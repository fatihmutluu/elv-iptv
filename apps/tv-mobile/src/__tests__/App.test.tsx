import { render, screen } from '@testing-library/react-native';
import { App } from '../App';

describe('App', () => {
  it('shows the product name', async () => {
    await render(<App />);
    expect(screen.getByText('ELV IPTV')).toBeOnTheScreen();
  });
});
