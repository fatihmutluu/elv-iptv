import { StyleSheet, Text, View } from 'react-native';
import { GateScreen } from './gate/GateScreen.tsx';
import { resolveGate } from './gate/params.ts';

// Computed once: a re-render must never hand the gate new params, which would restart the run. Main loads the query only
// for an unpackaged `--elv-gate=` launch, and the preload flags gate mode; a page with just the query gets no gate.
const GATE = resolveGate(window.location.search, window.elv);

/** Placeholder root of the desktop renderer; the shared feature screens replace it later. */
export function App() {
  if (GATE) return <GateScreen params={GATE} />;
  return (
    <View style={styles.root}>
      <Text style={styles.title}>ELV IPTV</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#101114' },
  title: { color: '#ffffff', fontSize: 32, fontWeight: '600' },
});
