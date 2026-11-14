import { act, render, screen } from '@testing-library/react-native';
import { Linking, Platform, Settings } from 'react-native';
import { App } from '../App';

let mockGate = false;
let mockListener: ((event: unknown) => void) | undefined;
jest.mock('@elv/remote-keys', () => ({
  remoteKeys: {
    addListener: (l: (event: unknown) => void) => {
      mockListener = l;
      return { remove: () => {} };
    },
  },
}));
jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockGate ? { gate: true } : {} };
    },
  },
}));

// jest-expo registers no native SettingsManager; each test stubs Settings.get.
jest.mock('react-native/Libraries/Settings/NativeSettingsManager', () => ({
  __esModule: true,
  default: {
    getConstants: () => ({ settings: {} }),
    setValues: jest.fn(),
    deleteValues: jest.fn(),
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

function launchedWith(value: unknown) {
  return jest
    .spyOn(Settings, 'get')
    .mockImplementation((key) => (key === 'gateUrl' ? value : undefined));
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

  it('opens the gate list from the -gateUrl launch argument in a gate build', async () => {
    mockGate = true;
    openedWith(null);
    const read = launchedWith(GATE_URL);
    await render(<App />);
    expect(await screen.findByTestId('gate-list')).toBeOnTheScreen();
    expect(read).toHaveBeenCalledWith('gateUrl');
  });

  it('prefers the launch argument over the initial URL', async () => {
    mockGate = true;
    openedWith('elviptv://gate/list?items=7');
    launchedWith(GATE_URL);
    await render(<App />);
    expect(await screen.findByTestId('gate-list')).toBeOnTheScreen();
    expect(screen.getByText('50 items')).toBeOnTheScreen();
  });

  it('never reads the launch argument when the build has no gate flag', async () => {
    openedWith(null);
    const read = launchedWith(GATE_URL);
    await render(<App />);
    expect(screen.getByText('ELV IPTV')).toBeOnTheScreen();
    expect(read).not.toHaveBeenCalled();
  });

  it('ignores a launch argument that is not a gate URL', async () => {
    mockGate = true;
    openedWith(null);
    launchedWith(42);
    await render(<App />);
    expect(screen.getByText('ELV IPTV')).toBeOnTheScreen();
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

  it('moves gate focus from the raw Android key source', async () => {
    mockGate = true;
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    openedWith('elviptv://gate/list?items=1000&auto=0');
    const view = await render(<App />);
    await screen.findByTestId('gate-list');
    await act(async () =>
      mockListener?.({ action: 'down', keyCode: 20, canceled: false, ageMs: 0 }),
    );
    expect(screen.getByTestId('gate-list-row-1').props.accessibilityState.selected).toBe(true);
    await view.unmount();
  });
});
