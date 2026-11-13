import { render, screen, waitFor } from '@testing-library/react-native';
import { GateListScreen } from '../GateListScreen';

function gateLines(spy: jest.SpyInstance): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('ELV_GATE '));
}

describe('GateListScreen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders the list window for the requested item count', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={{ items: 100_000, auto: false, rate: 20, moves: 10 }} />);
    expect(screen.getByTestId('gate-list')).toBeOnTheScreen();
    expect(screen.getByText('Channel 1')).toBeOnTheScreen();
    expect(screen.queryByText('Channel 20')).toBeNull();
    expect(screen.getByText('100000 items')).toBeOnTheScreen();
  });

  it('prints exactly one ELV_GATE line when an auto run finishes', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={{ items: 1000, auto: true, rate: 60, moves: 20 }} />);
    await waitFor(() => expect(gateLines(log)).toHaveLength(1), { timeout: 8000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const lines = gateLines(log);
    expect(lines).toHaveLength(1);
    const metrics = JSON.parse((lines[0] ?? '').slice('ELV_GATE '.length));
    expect(metrics.items).toBe(1000);
    expect(metrics.moves).toBeGreaterThan(0);
    expect(metrics.moves + metrics.coalesced).toBeLessThanOrEqual(20);
    expect(metrics.keyToHighlightMs.p95).toBeGreaterThanOrEqual(0);
    expect(metrics.losses).toBe(0);
  });

  it('prints nothing for a manual session', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={{ items: 1000, auto: false, rate: 60, moves: 20 }} />);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(gateLines(log)).toHaveLength(0);
  });
});
