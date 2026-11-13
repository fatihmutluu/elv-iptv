import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { GateListScreen } from '../GateListScreen';
import { advance, gateLines, onlyGateMetrics } from './gate-test-utils';

const autoRun = { items: 1000, auto: true, rate: 60, moves: 20, stall: 0 };

describe('GateListScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

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
    await render(<GateListScreen params={autoRun} />);
    await advance(2000);
    expect(gateLines(log)).toHaveLength(1);
    await advance(500);
    const metrics = onlyGateMetrics(log);
    expect(metrics.items).toBe(1000);
    expect(metrics.moves).toBeGreaterThan(0);
    expect(metrics.scripted).toBe(20);
    expect(metrics.moves + (metrics.coalesced as number)).toBeLessThanOrEqual(20);
    expect(metrics.keyToHighlightMs.p95).toBeGreaterThanOrEqual(0);
    expect(metrics.losses).toBe(0);
  });

  it.each([
    ['android', 'log', 'error'],
    ['ios', 'error', 'log'],
  ] as const)('prints the line on %s with console.%s, not console.%s', async (os, used, unused) => {
    jest.replaceProperty(Platform, 'OS', os);
    const spies = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
    };
    await render(<GateListScreen params={autoRun} />);
    await advance(2000);
    expect(gateLines(spies[used])).toHaveLength(1);
    expect(gateLines(spies[unused])).toHaveLength(0);
  });

  it('prints nothing for a manual session', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={{ ...autoRun, auto: false }} />);
    await advance(3000);
    expect(gateLines(log)).toHaveLength(0);
  });

  it('prints no line when the screen unmounts mid-run', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const view = await render(<GateListScreen params={{ ...autoRun, rate: 20, moves: 200 }} />);
    await advance(800);
    await view.unmount();
    await advance(3000, 100);
    expect(gateLines(log)).toHaveLength(0);
  });

  it('prints only the new run line when the params change mid-run', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const first = { ...autoRun, rate: 20, moves: 200 };
    const view = await render(<GateListScreen key="a" params={first} />);
    await advance(800);
    await view.rerender(<GateListScreen key="b" params={{ ...autoRun, items: 2000 }} />);
    await advance(2000);
    expect(gateLines(log)).toHaveLength(1);
    await advance(3000, 100);
    expect(onlyGateMetrics(log).items).toBe(2000);
  });
});
