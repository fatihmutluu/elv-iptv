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
    await render(
      <GateListScreen params={{ items: 100_000, auto: false, rate: 20, moves: 10, stall: 0 }} />,
    );
    expect(screen.getByTestId('gate-list')).toBeOnTheScreen();
    expect(screen.getByText('Channel 1')).toBeOnTheScreen();
    expect(screen.queryByText('Channel 20')).toBeNull();
    expect(screen.getByText('100000 items')).toBeOnTheScreen();
  });

  it('prints exactly one ELV_GATE line when an auto run finishes', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(
      <GateListScreen params={{ items: 1000, auto: true, rate: 60, moves: 20, stall: 0 }} />,
    );
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
    await render(
      <GateListScreen params={{ items: 1000, auto: false, rate: 60, moves: 20, stall: 0 }} />,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(gateLines(log)).toHaveLength(0);
  });

  it('prints no line when the screen unmounts mid-run', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const view = await render(
      <GateListScreen params={{ items: 1000, auto: true, rate: 20, moves: 200, stall: 0 }} />,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    await view.unmount();
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    expect(gateLines(log)).toHaveLength(0);
  });

  it('prints only the new run line when the params change mid-run', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const first = { items: 1000, auto: true, rate: 20, moves: 200, stall: 0 };
    const view = await render(<GateListScreen key="a" params={first} />);
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    await view.rerender(
      <GateListScreen
        key="b"
        params={{ items: 2000, auto: true, rate: 60, moves: 20, stall: 0 }}
      />,
    );
    await waitFor(() => expect(gateLines(log)).toHaveLength(1), { timeout: 8000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    const lines = gateLines(log);
    expect(lines).toHaveLength(1);
    expect(JSON.parse((lines[0] ?? '').slice('ELV_GATE '.length)).items).toBe(2000);
  });
});
