import { type RefObject, useEffect, useRef } from 'react';

/** Minimal DOM keyboard event shape handled by {@link attachDesktopDialogTrap}. */
export interface DialogKeyEventLike {
  readonly key?: unknown;
  readonly shiftKey?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/** Minimal DOM element shape needed for focus trapping and background `inert` isolation. */
export interface DialogElementLike {
  readonly parentElement?: DialogElementLike | null;
  readonly children?: ArrayLike<DialogElementLike> | Iterable<DialogElementLike>;
  readonly ownerDocument?: DialogDocumentLike | null;
  readonly isConnected?: boolean;
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly style?: { readonly display?: string; readonly visibility?: string };
  tabIndex?: number;
  inert?: boolean;
  focus?: () => void;
  getAttribute?: (name: string) => string | null;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
  hasAttribute?: (name: string) => boolean;
  addEventListener?: (type: string, listener: (event: DialogKeyEventLike) => void) => void;
  removeEventListener?: (type: string, listener: (event: DialogKeyEventLike) => void) => void;
  querySelectorAll?: (
    selector: string,
  ) => ArrayLike<DialogElementLike> | Iterable<DialogElementLike>;
}

/** Minimal DOM document shape used by {@link attachDesktopDialogTrap}. */
export interface DialogDocumentLike {
  readonly body?: DialogElementLike | null;
  readonly activeElement?: DialogElementLike | null;
}

/** Options accepted by {@link attachDesktopDialogTrap}. */
export interface DesktopDialogTrapOptions {
  /** Called when `Escape` is pressed inside the trapped dialog. */
  readonly onEscape?: () => void;
  /** Whether to restore focus to the previously focused element on cleanup (default `true`). */
  readonly restoreFocus?: boolean;
  /** Optional document override (defaults to `dialogEl.ownerDocument ?? globalThis.document`). */
  readonly doc?: DialogDocumentLike;
}

interface SavedSiblingState {
  readonly el: DialogElementLike;
  readonly mode: 'inert' | 'aria-hidden';
  readonly prevInert: boolean;
  readonly prevAriaHidden: string | null;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  '[tabindex]',
  '[role="button"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(', ');

function isDialogElementLike(value: unknown): value is DialogElementLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as DialogElementLike;
  return (
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function' &&
    typeof candidate.querySelectorAll === 'function'
  );
}

function isHiddenOrInert(el: DialogElementLike): boolean {
  if (el.hidden === true || el.hasAttribute?.('hidden') === true) return true;
  if (el.inert === true || el.hasAttribute?.('inert') === true) return true;
  if (el.getAttribute?.('aria-hidden') === 'true') return true;
  if (el.style?.display === 'none' || el.style?.visibility === 'hidden') return true;
  return false;
}

function hasNegativeTabIndex(el: DialogElementLike): boolean {
  const raw = el.getAttribute?.('tabindex');
  if (raw !== null && raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) || parsed < 0;
  }
  return typeof el.tabIndex === 'number' && el.tabIndex < 0;
}

function isFocusableInside(el: DialogElementLike, root: DialogElementLike): boolean {
  if (el.disabled === true || el.hasAttribute?.('disabled') === true) return false;
  if (hasNegativeTabIndex(el)) return false;
  let current: DialogElementLike | null | undefined = el;
  while (current !== null && current !== undefined && current !== root) {
    if (isHiddenOrInert(current)) return false;
    current = current.parentElement;
  }
  return true;
}

/** Returns focusable descendants within `container` in DOM order, excluding disabled/hidden/inert nodes. */
export function getFocusableDialogElements(container: DialogElementLike): DialogElementLike[] {
  const raw = container.querySelectorAll?.(FOCUSABLE_SELECTOR);
  if (raw === undefined) return [];
  const list = Array.from(raw);
  return list.filter((el) => isFocusableInside(el, container));
}

function isolateBackgroundSiblings(
  dialogEl: DialogElementLike,
  body: DialogElementLike | null | undefined,
): SavedSiblingState[] {
  const saved: SavedSiblingState[] = [];
  const seen = new Set<DialogElementLike>();
  let current: DialogElementLike = dialogEl;

  while (
    current.parentElement !== null &&
    current.parentElement !== undefined &&
    current !== body
  ) {
    const parent = current.parentElement;
    const children = parent.children !== undefined ? Array.from(parent.children) : [];
    for (const sibling of children) {
      if (sibling === current || seen.has(sibling)) continue;
      seen.add(sibling);
      if ('inert' in sibling) {
        saved.push({
          el: sibling,
          mode: 'inert',
          prevInert: Boolean(sibling.inert),
          prevAriaHidden: null,
        });
        sibling.inert = true;
      } else {
        saved.push({
          el: sibling,
          mode: 'aria-hidden',
          prevInert: false,
          prevAriaHidden: sibling.getAttribute?.('aria-hidden') ?? null,
        });
        sibling.setAttribute?.('aria-hidden', 'true');
      }
    }
    current = parent;
  }

  return saved;
}

/**
 * Attaches a desktop web modal focus trap and ancestor-sibling `inert` isolation to `dialogEl` (#283).
 * Safe no-op on non-web platforms or null/non-DOM refs; returns an idempotent teardown function.
 */
export function attachDesktopDialogTrap(
  dialogEl: unknown,
  options?: DesktopDialogTrapOptions,
): () => void {
  if (!isDialogElementLike(dialogEl)) return () => undefined;

  const doc: DialogDocumentLike | undefined =
    options?.doc ??
    dialogEl.ownerDocument ??
    (globalThis as { document?: DialogDocumentLike }).document;
  const previousFocus = doc?.activeElement ?? null;
  const savedSiblings = isolateBackgroundSiblings(dialogEl, doc?.body);

  let appliedFallbackTabIndex = false;
  const hadTabIndexAttr = dialogEl.hasAttribute?.('tabindex') === true;
  const prevTabIndexAttr = dialogEl.getAttribute?.('tabindex') ?? null;
  const prevTabIndexProp = dialogEl.tabIndex;

  const initialFocusables = getFocusableDialogElements(dialogEl);
  if (initialFocusables.length > 0) {
    initialFocusables[0]?.focus?.();
  } else {
    appliedFallbackTabIndex = true;
    dialogEl.tabIndex = -1;
    dialogEl.setAttribute?.('tabindex', '-1');
    dialogEl.focus?.();
  }

  const onKeyDown = (event: DialogKeyEventLike): void => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      options?.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusables = getFocusableDialogElements(dialogEl);
    if (focusables.length === 0) {
      event.preventDefault?.();
      dialogEl.focus?.();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = doc?.activeElement ?? null;

    if (event.shiftKey === true) {
      if (
        active === first ||
        active === dialogEl ||
        active === null ||
        !focusables.includes(active)
      ) {
        event.preventDefault?.();
        last?.focus?.();
      }
    } else if (active === last || active === null || !focusables.includes(active)) {
      event.preventDefault?.();
      first?.focus?.();
    }
  };

  dialogEl.addEventListener?.('keydown', onKeyDown);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;

    dialogEl.removeEventListener?.('keydown', onKeyDown);

    for (let i = savedSiblings.length - 1; i >= 0; i -= 1) {
      const entry = savedSiblings[i];
      if (entry === undefined) continue;
      if (entry.mode === 'inert') {
        entry.el.inert = entry.prevInert;
      } else if (entry.prevAriaHidden === null) {
        entry.el.removeAttribute?.('aria-hidden');
      } else {
        entry.el.setAttribute?.('aria-hidden', entry.prevAriaHidden);
      }
    }

    if (appliedFallbackTabIndex) {
      if (hadTabIndexAttr && prevTabIndexAttr !== null) {
        dialogEl.setAttribute?.('tabindex', prevTabIndexAttr);
      } else {
        dialogEl.removeAttribute?.('tabindex');
        if (typeof prevTabIndexProp === 'number') dialogEl.tabIndex = prevTabIndexProp;
      }
    }

    if (
      options?.restoreFocus !== false &&
      previousFocus !== null &&
      previousFocus.isConnected === true
    ) {
      previousFocus.focus?.();
    }
  };
}

/** React hook wiring {@link attachDesktopDialogTrap} to a dialog ref while `enabled` is true. */
export function useDesktopDialogTrap(
  ref: RefObject<unknown>,
  enabled: boolean,
  onEscape?: () => void,
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    return attachDesktopDialogTrap(ref.current, {
      onEscape: () => onEscapeRef.current?.(),
    });
  }, [enabled, ref]);
}
