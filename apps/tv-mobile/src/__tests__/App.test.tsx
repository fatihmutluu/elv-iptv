import { act, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { App } from '../App';

let mockGate = false;
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockGate ? { gate: true } : {} };
    },
  },
}));

const GATE_URL = 'elviptv://gate/list?items=50';

function openedWith(url: string | null) {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(url);
  const remove = jest.fn();
  const add = jest.spyOn(Linking, 'addEventListener').mockReturnValue({ remove });
  add.mockClear();
  return { add, remove };
}

afterEach(() => {
  jest.restoreAllMocks();
  mockGate = false;
});

describe('App', () => {
  it('shows the product name', async () => {
    openedWith(null);
    await render(<App />);
    expect(screen.getByText('ELV IPTV')).toBeOnTheScreen();
  });

  it('ignores a gate URL when the build has no gate flag', async () => {
    openedWith(GATE_URL);
    await render(<App />);
    expect(screen.getByText('ELV IPTV')).toBeOnTheScreen();
    expect(screen.queryByTestId('gate-list')).toBeNull();
  });

  it('keeps the placeholder in a gate build until a gate URL opens it', async () => {
    mockGate = true;
    openedWith(null);
    await render(<App />);
    expect(screen.getByText('ELV IPTV')).toBeOnTheScreen();
    expect(screen.queryByTestId('gate-list')).toBeNull();
  });

  it('opens the gate list from the initial URL in a gate build', async () => {
    mockGate = true;
    openedWith(GATE_URL);
    await render(<App />);
    expect(await screen.findByTestId('gate-list')).toBeOnTheScreen();
    expect(screen.queryByText('ELV IPTV')).toBeNull();
  });

  it('opens the gate list from a URL event and unsubscribes on unmount', async () => {
    mockGate = true;
    const { add, remove } = openedWith(null);
    const view = await render(<App />);
    const handler = add.mock.calls[0]?.[1] as (event: { url: string }) => void;
    await act(async () => handler({ url: GATE_URL }));
    expect(await screen.findByTestId('gate-list')).toBeOnTheScreen();
    await view.unmount();
    expect(remove).toHaveBeenCalled();
  });
});
