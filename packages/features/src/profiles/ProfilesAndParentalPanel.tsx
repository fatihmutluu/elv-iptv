import type { CatalogService, SourceRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { TextEntryBoundary, useKeyInterpreter, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { ParentalControlsCard } from './ParentalControlsCard';

/** Props of {@link ProfilesAndParentalPanel}. */
export interface ProfilesAndParentalPanelProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  /** Whether this Settings detail pane owns TV remote focus (`false` while sidebar or Top Nav owns focus). */
  readonly isActiveScope?: boolean;
  /** Returns TV focus from this panel back to the Settings sidebar. */
  readonly onBack?: () => void;
}

function ProfilesPanelTvBridge({ onBack }: { readonly onBack: () => void }): null {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onBack();
        return true;
      }
      return false;
    },
    [onBack],
  );
  useKeyInterpreter(handleKey);
  return null;
}

/**
 * Cinema Quietude v2 Settings -> Kids Mode section (`#31`, `#506`).
 * Profile creation, editing, and deletion live strictly in the top-right "Who's Watching?" overlay.
 */
export function ProfilesAndParentalPanel({
  catalog,
  sources,
  isActiveScope = true,
  onBack,
}: ProfilesAndParentalPanelProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  return (
    <TextEntryBoundary>
      <ScrollView
        testID="settings-panel-profiles"
        style={styles.scroll}
        contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
      >
        {isTv && isActiveScope && onBack !== undefined ? (
          <ProfilesPanelTvBridge onBack={onBack} />
        ) : null}

        <ParentalControlsCard catalog={catalog} sources={sources} isActiveScope={isActiveScope} />
      </ScrollView>
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
});
