import type { ReactElement } from 'react';
import { View } from 'react-native';

/** Props of {@link FocusRing}. */
export interface FocusRingProps {
  top: number;
  height: number;
  testID?: string;
}

const ring = {
  position: 'absolute',
  left: 0,
  right: 0,
  borderWidth: 3,
  borderColor: '#ffffff',
  borderRadius: 8,
} as const;

/** The focus highlight of a TV list: one absolutely positioned frame, moved by the list, never part of a row. */
export function FocusRing({ top, height, testID }: FocusRingProps): ReactElement {
  return <View testID={testID} style={{ ...ring, top, height }} />;
}
