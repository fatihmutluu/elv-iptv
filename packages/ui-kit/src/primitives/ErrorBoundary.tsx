import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { useViewport } from '../viewport';
import { CtaButton } from './CtaButton';

/** Props passed to a custom {@link ErrorBoundary} fallback renderer. */
export interface ErrorBoundaryFallbackProps {
  readonly error: Error;
  readonly reset: () => void;
}

/** Props of {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  title?: string;
  description?: string;
  retryLabel?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
  onReset?: () => void;
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode;
  testID?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function DefaultErrorFallback({
  title,
  description,
  retryLabel,
  onReset,
  testID,
}: {
  title?: string;
  description?: string;
  retryLabel?: string;
  onReset: () => void;
  testID?: string;
}): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const isTv = viewport.inputModality === 'tv';

  const resolvedTitle = title ?? i18n.t('ui.error.title');
  const resolvedDescription = description ?? i18n.t('ui.error.description');
  const resolvedRetry = retryLabel ?? i18n.t('ui.error.retry');

  return (
    <View
      testID={testID ?? 'elv-error-boundary'}
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.bgCanvas,
          paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
          paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
        },
      ]}
    >
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.modal,
            padding: theme.spacing.lg,
          },
        ]}
      >
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
          {resolvedTitle}
        </Text>
        <Text
          style={[
            theme.typography.body,
            { color: theme.colors.textSecondary, marginTop: theme.spacing.xs },
          ]}
        >
          {resolvedDescription}
        </Text>
        <CtaButton
          testID={testID ? `${testID}-retry` : 'elv-error-boundary-retry'}
          label={resolvedRetry}
          hasTVPreferredFocus={isTv}
          onPress={onReset}
          style={{ marginTop: theme.spacing.md }}
        />
      </View>
    </View>
  );
}

/**
 * TV- and touch-navigable React error boundary (`#159`) isolating screen render crashes behind a
 * themed recovery action without leaking raw error details into user-facing copy.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset });
    }
    return (
      <DefaultErrorFallback
        {...(this.props.title !== undefined ? { title: this.props.title } : {})}
        {...(this.props.description !== undefined ? { description: this.props.description } : {})}
        {...(this.props.retryLabel !== undefined ? { retryLabel: this.props.retryLabel } : {})}
        onReset={this.reset}
        {...(this.props.testID !== undefined ? { testID: this.props.testID } : {})}
      />
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    borderWidth: 1,
  },
});
