import type { EdgeInsets } from './resolve-viewport';

interface SafeAreaProbeElement {
  style: {
    position: string;
    top: string;
    left: string;
    width: string;
    height: string;
    visibility: string;
    pointerEvents: string;
    paddingTop: string;
    paddingRight: string;
    paddingBottom: string;
    paddingLeft: string;
  };
  remove?(): void;
  parentNode?: { removeChild(node: SafeAreaProbeElement): void } | null;
}

interface SafeAreaProbeDocument {
  body?: {
    appendChild(node: SafeAreaProbeElement): void;
    removeChild(node: SafeAreaProbeElement): void;
  } | null;
  createElement(tag: 'div'): SafeAreaProbeElement;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

interface SafeAreaProbeWindow {
  getComputedStyle?(el: SafeAreaProbeElement): {
    paddingTop?: string;
    paddingRight?: string;
    paddingBottom?: string;
    paddingLeft?: string;
  };
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

function parseInsetPx(raw: string | undefined): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Returns true when two {@link EdgeInsets} snapshots match on all four edges. */
export function edgeInsetsEqual(a: EdgeInsets, b: EdgeInsets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * Probes CSS `env(safe-area-inset-*)` values on web/Electron using one hidden probe element,
 * re-measuring on `resize` and `fullscreenchange` (`#269`). Returns a cleanup function that removes
 * listeners and detaches the probe element.
 */
export function subscribeWebSafeArea(onChange: (insets: EdgeInsets) => void): () => void {
  const g = globalThis as unknown as {
    document?: SafeAreaProbeDocument;
    window?: SafeAreaProbeWindow;
  };
  const doc = g.document;
  const win = g.window;
  if (
    !doc?.body ||
    typeof doc.createElement !== 'function' ||
    typeof win?.getComputedStyle !== 'function'
  ) {
    return () => undefined;
  }

  const probe = doc.createElement('div');
  probe.style.position = 'fixed';
  probe.style.top = '0';
  probe.style.left = '0';
  probe.style.width = '0';
  probe.style.height = '0';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.paddingTop = 'env(safe-area-inset-top, 0px)';
  probe.style.paddingRight = 'env(safe-area-inset-right, 0px)';
  probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
  probe.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
  doc.body.appendChild(probe);

  let last: EdgeInsets | undefined;
  const measure = (): void => {
    const computed = win.getComputedStyle?.(probe);
    const next: EdgeInsets = {
      top: parseInsetPx(computed?.paddingTop),
      right: parseInsetPx(computed?.paddingRight),
      bottom: parseInsetPx(computed?.paddingBottom),
      left: parseInsetPx(computed?.paddingLeft),
    };
    if (last !== undefined && edgeInsetsEqual(last, next)) return;
    last = next;
    onChange(next);
  };

  measure();
  win.addEventListener?.('resize', measure);
  doc.addEventListener?.('fullscreenchange', measure);
  doc.addEventListener?.('webkitfullscreenchange', measure);

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    win.removeEventListener?.('resize', measure);
    doc.removeEventListener?.('fullscreenchange', measure);
    doc.removeEventListener?.('webkitfullscreenchange', measure);
    if (typeof probe.remove === 'function') {
      probe.remove();
    } else if (probe.parentNode) {
      probe.parentNode.removeChild(probe);
    } else {
      doc.body?.removeChild(probe);
    }
  };
}
