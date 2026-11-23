/** DOM element id of the idempotent `<style>` element injected by {@link attachAccessibilityFonts}. */
export const ACCESSIBILITY_FONTS_STYLE_ID = 'elv-accessibility-fonts';

/** `@font-face` declarations for the bundled OFL-1.1 accessibility fonts (`#163`). */
export const ACCESSIBILITY_FONTS_CSS = [
  '@font-face {',
  "  font-family: 'Atkinson Hyperlegible Next';",
  "  src: url('./fonts/AtkinsonHyperlegibleNext-Regular.ttf') format('truetype');",
  '  font-weight: 400;',
  '  font-style: normal;',
  '  font-display: swap;',
  '}',
  '@font-face {',
  "  font-family: 'Atkinson Hyperlegible Next';",
  "  src: url('./fonts/AtkinsonHyperlegibleNext-Bold.ttf') format('truetype');",
  '  font-weight: 700;',
  '  font-style: normal;',
  '  font-display: swap;',
  '}',
  '@font-face {',
  "  font-family: 'OpenDyslexic';",
  "  src: url('./fonts/OpenDyslexic-Regular.otf') format('opentype');",
  '  font-weight: 400;',
  '  font-style: normal;',
  '  font-display: swap;',
  '}',
  '@font-face {',
  "  font-family: 'OpenDyslexic';",
  "  src: url('./fonts/OpenDyslexic-Bold.otf') format('opentype');",
  '  font-weight: 700;',
  '  font-style: normal;',
  '  font-display: swap;',
  '}',
].join('\n');

/** Minimal `<style>` element surface required by {@link attachAccessibilityFonts}. */
export interface AccessibilityFontsStyleElementLike {
  id: string;
  textContent: string | null;
  remove(): void;
}

interface AccessibilityFontsDocumentLike {
  readonly head: {
    appendChild(node: AccessibilityFontsStyleElementLike): unknown;
  } | null;
  getElementById(id: string): AccessibilityFontsStyleElementLike | null;
  createElement(tagName: 'style'): AccessibilityFontsStyleElementLike;
}

/** Minimal `window` surface required by {@link attachAccessibilityFonts}. */
export interface AccessibilityFontsWindowLike {
  readonly document?: AccessibilityFontsDocumentLike | null;
}

const mountCounts = new WeakMap<object, number>();

/**
 * Registers `@font-face` rules for the bundled `Atkinson Hyperlegible Next` and `OpenDyslexic`
 * fonts on `targetWindow.document.head` using relative `./fonts/...` URLs so both dev servers and
 * packaged `app://elv/` Electron builds resolve them cleanly (`#163`). Returns a ref-counted
 * disposer.
 */
export function attachAccessibilityFonts(
  targetWindow: Window | AccessibilityFontsWindowLike,
): () => void {
  const win = targetWindow as AccessibilityFontsWindowLike;
  const doc = win.document;
  if (!doc?.head) return () => undefined;

  const nextCount = (mountCounts.get(doc) ?? 0) + 1;
  mountCounts.set(doc, nextCount);

  if (!doc.getElementById(ACCESSIBILITY_FONTS_STYLE_ID)) {
    const styleEl = doc.createElement('style');
    styleEl.id = ACCESSIBILITY_FONTS_STYLE_ID;
    styleEl.textContent = ACCESSIBILITY_FONTS_CSS;
    doc.head.appendChild(styleEl);
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const remaining = Math.max(0, (mountCounts.get(doc) ?? 0) - 1);
    if (remaining === 0) {
      doc.getElementById(ACCESSIBILITY_FONTS_STYLE_ID)?.remove();
      mountCounts.delete(doc);
    } else {
      mountCounts.set(doc, remaining);
    }
  };
}
