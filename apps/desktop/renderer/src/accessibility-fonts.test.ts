import { describe, expect, it } from 'vitest';
import {
  ACCESSIBILITY_FONTS_CSS,
  ACCESSIBILITY_FONTS_STYLE_ID,
  type AccessibilityFontsStyleElementLike,
  type AccessibilityFontsWindowLike,
  attachAccessibilityFonts,
} from './accessibility-fonts.ts';

function fakeWindow() {
  const styles = new Map<string, AccessibilityFontsStyleElementLike>();
  let created = 0;
  let removed = 0;
  const win: AccessibilityFontsWindowLike = {
    document: {
      head: {
        appendChild(node) {
          styles.set(node.id, node);
          return node;
        },
      },
      getElementById(id) {
        return styles.get(id) ?? null;
      },
      createElement() {
        created += 1;
        const el: AccessibilityFontsStyleElementLike = {
          id: '',
          textContent: null,
          remove() {
            removed += 1;
            styles.delete(el.id);
          },
        };
        return el;
      },
    },
  };
  return {
    win,
    styles,
    get created() {
      return created;
    },
    get removed() {
      return removed;
    },
  };
}

describe('attachAccessibilityFonts (#163)', () => {
  it('declares @font-face rules for Atkinson Hyperlegible Next and OpenDyslexic (400 & 700) with relative ./fonts/ URLs and font-display: swap', () => {
    expect(ACCESSIBILITY_FONTS_CSS).toContain("font-family: 'Atkinson Hyperlegible Next';");
    expect(ACCESSIBILITY_FONTS_CSS).toContain(
      "url('./fonts/AtkinsonHyperlegibleNext-Regular.ttf') format('truetype')",
    );
    expect(ACCESSIBILITY_FONTS_CSS).toContain(
      "url('./fonts/AtkinsonHyperlegibleNext-Bold.ttf') format('truetype')",
    );
    expect(ACCESSIBILITY_FONTS_CSS).toContain("font-family: 'OpenDyslexic';");
    expect(ACCESSIBILITY_FONTS_CSS).toContain(
      "url('./fonts/OpenDyslexic-Regular.otf') format('opentype')",
    );
    expect(ACCESSIBILITY_FONTS_CSS).toContain(
      "url('./fonts/OpenDyslexic-Bold.otf') format('opentype')",
    );
    expect(ACCESSIBILITY_FONTS_CSS.match(/font-weight: 400;/g)?.length).toBe(2);
    expect(ACCESSIBILITY_FONTS_CSS.match(/font-weight: 700;/g)?.length).toBe(2);
    expect(ACCESSIBILITY_FONTS_CSS.match(/font-display: swap;/g)?.length).toBe(4);
  });

  it('injects the stylesheet idempotently and removes it only when the last mount disposes', () => {
    const f = fakeWindow();
    const off1 = attachAccessibilityFonts(f.win);
    const off2 = attachAccessibilityFonts(f.win);

    expect(f.created).toBe(1);
    expect(f.styles.get(ACCESSIBILITY_FONTS_STYLE_ID)?.textContent).toBe(ACCESSIBILITY_FONTS_CSS);

    off1();
    off1();
    expect(f.removed).toBe(0);
    expect(f.styles.has(ACCESSIBILITY_FONTS_STYLE_ID)).toBe(true);

    off2();
    expect(f.removed).toBe(1);
    expect(f.styles.has(ACCESSIBILITY_FONTS_STYLE_ID)).toBe(false);
  });

  it('returns a safe no-op disposer when document or head is absent', () => {
    const offNoDoc = attachAccessibilityFonts({});
    const offNoHead = attachAccessibilityFonts({
      document: {
        head: null,
        getElementById: () => null,
        createElement: () => {
          throw new Error('should not create');
        },
      },
    });
    expect(() => offNoDoc()).not.toThrow();
    expect(() => offNoHead()).not.toThrow();
  });
});
