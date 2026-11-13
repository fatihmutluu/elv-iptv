import { StyleSheet, Text, View } from 'react-native';

/** Placeholder root of the desktop renderer; the shared feature screens replace it later. */
export function App() {
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
