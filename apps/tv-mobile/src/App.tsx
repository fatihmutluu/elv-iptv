import { remoteKeys } from '@elv/remote-keys';
import { RemoteKeysProvider } from '@elv/ui-kit';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { GateListScreen } from './gate/GateListScreen';
import { ImportGateScreen } from './gate/import/ImportGateScreen';
import { PlayerGateScreen } from './gate/player/PlayerGateScreen';
import { useGateRoute } from './gate/useGateParams';

/**
 * Root component that `index.ts` registers, with the raw Android key source provided to both branches; a placeholder screen until Round 1. Development builds (`extra.gate`)
 * open the list, import or player gate instead when a `elviptv://gate/list`, `/import` or `/player` link started the app.
 */
export function App() {
  const gate = useGateRoute();
  if (gate !== undefined) {
    return (
      <RemoteKeysProvider android={remoteKeys}>
        {gate.name === 'list' && <GateListScreen key={JSON.stringify(gate)} params={gate.params} />}
        {gate.name === 'import' && (
          <ImportGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        {gate.name === 'player' && (
          <PlayerGateScreen key={JSON.stringify(gate)} params={gate.params} />
        )}
        <StatusBar style="light" />
      </RemoteKeysProvider>
    );
  }
  return (
    <RemoteKeysProvider android={remoteKeys}>
      <View style={styles.root}>
        <Text style={styles.title}>ELV IPTV</Text>
        <StatusBar style="light" />
      </View>
    </RemoteKeysProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0e14' },
  title: { color: '#ffffff', fontSize: 32, fontWeight: '600' },
});
