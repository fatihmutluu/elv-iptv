import { StyleSheet, Text, View } from 'react-native';
import { GateScreen } from './gate/GateScreen.tsx';
import { parseGateParams } from './gate/params.ts';

/** Placeholder root of the desktop renderer; the shared feature screens replace it later. */
export function App() {
  // Main loads the gate query only for an unpackaged `--elv-gate=` launch; a normal launch has no query.
  const gate = parseGateParams(window.location.search);
  if (gate) return <GateScreen params={gate} />;
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
