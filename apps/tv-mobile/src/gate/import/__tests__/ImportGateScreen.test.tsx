import { elvError, err, ok } from '@elv/domain';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { ImportGateScreen } from '../ImportGateScreen';
import type { ImportParams } from '../route';

const mockCloseDriver = jest.fn(async () => undefined);
const mockCloseCatalog = jest.fn(async () => undefined);
const mockOpenCatalog = jest.fn();
const mockCreateCatalogService = jest.fn();
const mockRunImport = jest.fn();
const mockCreateDeviceNativeGuideStager = jest.fn();

jest.mock('@elv/data', () => ({
  openCatalog: (...args: unknown[]) => mockOpenCatalog(...args),
  createCatalogService: (...args: unknown[]) => {
    mockCreateCatalogService(...args);
    return { close: mockCloseCatalog };
  },
}));

jest.mock('../../../catalog/native-guide-stager', () => ({
  createDeviceNativeGuideStager: (...args: unknown[]) => mockCreateDeviceNativeGuideStager(...args),
}));

jest.mock('../../../storage', () => ({
  createOpSqliteDriver: async () => ({ close: mockCloseDriver }),
  databaseLocation: () => undefined,
  createDeviceHttpClient: () => ({}),
  createMacrotaskScheduler: () => ({ yieldNow: async () => undefined }),
  createSecureSecretStore: () => ({}),
}));

jest.mock('../run-import', () => ({
  ...jest.requireActual('../run-import'),
  runImport: (...args: unknown[]) => mockRunImport(...args),
}));

jest.mock('../stall-meter', () => ({
  startStallMeter: () => ({ stop: () => 4 }),
}));

const params: ImportParams = {
  host: '10.0.2.2:7878',
  account: 'large',
  batch: 5000,
  maxBody: 4096,
  series: false,
  probeReads: false,
};

describe('ImportGateScreen', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
    mockCloseDriver.mockClear();
    mockCloseCatalog.mockClear();
    mockOpenCatalog.mockReset();
    mockCreateCatalogService.mockReset();
    mockRunImport.mockReset();
    mockCreateDeviceNativeGuideStager.mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('closes the catalog in finally after a gate import finishes', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    mockOpenCatalog.mockResolvedValue(ok(undefined));
    mockRunImport.mockResolvedValue({
      account: 'large',
      batch: 5000,
      maxBody: 4096,
      rows: 42,
      durationMs: 100,
      maxStallMs: 4,
    });
    await render(<ImportGateScreen params={params} />);
    await waitFor(
      () => {
        expect(screen.getByText('import large x5000: done')).toBeOnTheScreen();
      },
      { timeout: 5_000 },
    );
    expect(mockCloseCatalog).toHaveBeenCalledTimes(1);
  });

  it('closes the raw driver when openCatalog fails before creating the service', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    mockOpenCatalog.mockResolvedValue(err(elvError('storage', 'migration-failed')));
    await render(<ImportGateScreen params={params} />);
    await waitFor(
      () => {
        expect(
          screen.getByText('import large x5000: failed: storage/migration-failed'),
        ).toBeOnTheScreen();
      },
      { timeout: 5_000 },
    );
    expect(mockCloseDriver).toHaveBeenCalledTimes(1);
    expect(mockCloseCatalog).not.toHaveBeenCalled();
  });

  it('wires nativeGuideStager into createCatalogService when available (#478)', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const fakeStager = { stage: jest.fn(), cancel: jest.fn() };
    mockCreateDeviceNativeGuideStager.mockReturnValue(fakeStager);
    mockOpenCatalog.mockResolvedValue(ok(undefined));
    mockRunImport.mockResolvedValue({
      account: 'large',
      batch: 5000,
      maxBody: 4096,
      rows: 42,
      durationMs: 100,
      maxStallMs: 4,
    });
    await render(<ImportGateScreen params={params} />);
    await waitFor(
      () => {
        expect(screen.getByText('import large x5000: done')).toBeOnTheScreen();
      },
      { timeout: 5_000 },
    );
    expect(mockCreateDeviceNativeGuideStager).toHaveBeenCalledTimes(1);
    expect(mockCreateCatalogService).toHaveBeenCalledWith(
      expect.objectContaining({ nativeGuideStager: fakeStager }),
    );
  });
});
