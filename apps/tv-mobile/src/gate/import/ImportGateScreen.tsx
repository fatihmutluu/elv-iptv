import { openCatalog } from '@elv/data';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { createCatalogService } from '../../catalog/catalog';
import {
  createDeviceHttpClient,
  createMacrotaskScheduler,
  createOpSqliteDriver,
  createSecureSecretStore,
} from '../../storage';
import type { ImportParams } from './route';
import { type ImportResult, importLine, runImport } from './run-import';
import { startStallMeter } from './stall-meter';

async function run(params: ImportParams): Promise<ImportResult> {
  // A new database file per run, so a run never reuses the rows of an earlier one (development builds only).
  const db = await createOpSqliteDriver(`gate-import-${Date.now()}.db`);
  const opened = await openCatalog(db);
  if (!opened.ok) {
    const error = `${opened.error.category}/${opened.error.code}`;
    return { account: params.account, batch: params.batch, error, maxStallMs: 0 };
  }
  const catalog = createCatalogService({
    db,
    secrets: createSecureSecretStore(),
    scheduler: createMacrotaskScheduler(),
    http: createDeviceHttpClient(),
    clock: Date.now,
  });
  return runImport(catalog, params, () => startStallMeter());
}

/**
 * Development gate: imports a simulator account into a fresh device database and prints one `ELV_GATE_IMPORT {json}`
 * line (`console.log` on Android, `console.error` on iOS, whose release builds drop info logs).
 */
export function ImportGateScreen({ params }: { params: ImportParams }) {
  const [status, setStatus] = useState('importing');
  useEffect(() => {
    let alive = true;
    run(params)
      .catch(
        (e: unknown): ImportResult => ({
          account: params.account,
          batch: params.batch,
          error: e instanceof Error ? e.name : 'unknown',
          maxStallMs: 0,
        }),
      )
      .then((result) => {
        const line = importLine(result);
        // biome-ignore lint/suspicious/noConsole: the gate runners read this line from logcat or the simulator log
        if (Platform.OS === 'ios') console.error(line);
        // biome-ignore lint/suspicious/noConsole: the gate runners read this line from logcat or the simulator log
        else console.log(line);
        if (alive) setStatus('error' in result ? `failed: ${result.error}` : 'done');
      });
    return () => {
      alive = false;
    };
  }, [params]);
  return (
    <View style={styles.root}>
      <Text style={styles.text}>{`import ${params.account} x${params.batch}: ${status}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0e14' },
  text: { color: '#ffffff', fontSize: 28 },
});
