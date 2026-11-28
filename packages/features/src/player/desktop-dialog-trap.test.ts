import { describe, expect, it, vi } from 'vitest';
import {
  attachDesktopDialogTrap,
  type DialogDocumentLike,
  type DialogElementLike,
  type DialogKeyEventLike,
  getFocusableDialogElements,
} from './desktop-dialog-trap';

interface MockElement extends DialogElementLike {
  readonly id: string;
  readonly tagName: string;
  readonly attrs: Map<string, string>;
  readonly listeners: Map<string, Set<(e: DialogKeyEventLike) => void>>;
  children: MockElement[];
  parentElement: MockElement | null;
  ownerDocument: MockDocument | null;
  isConnected: boolean;
  disabled?: boolean;
  hidden?: boolean;
  tabIndex?: number;
  inert?: boolean;
  style?: { display?: string; visibility?: string };
  focusCount: number;
  focus(): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  addEventListener(type: string, listener: (e: DialogKeyEventLike) => void): void;
  removeEventListener(type: string, listener: (e: DialogKeyEventLike) => void): void;
  querySelectorAll(selector: string): MockElement[];
  dispatchKey(event: Partial<DialogKeyEventLike> & { key: string }): {
    defaultPrevented: boolean;
    propagationStopped: boolean;
  };
}

interface MockDocument extends DialogDocumentLike {
  body: MockElement;
  activeElement: MockElement | null;
}

function createMockDoc(): MockDocument {
  const doc: MockDocument = {
    body: null as unknown as MockElement,
    activeElement: null,
  };
  doc.body = createMockEl(doc, { id: 'body', tagName: 'BODY', supportsInert: true });
  return doc;
}

function createMockEl(
  doc: MockDocument,
  opts: {
    id: string;
    tagName?: string;
    attrs?: Record<string, string>;
    supportsInert?: boolean;
    inert?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    tabIndex?: number;
    style?: { display?: string; visibility?: string };
    isConnected?: boolean;
  },
): MockElement {
  const attrs = new Map<string, string>(Object.entries(opts.attrs ?? {}));
  const listeners = new Map<string, Set<(e: DialogKeyEventLike) => void>>();
  const el: MockElement = {
    id: opts.id,
    tagName: (opts.tagName ?? 'DIV').toUpperCase(),
    attrs,
    listeners,
    children: [],
    parentElement: null,
    ownerDocument: doc,
    isConnected: opts.isConnected ?? true,
    ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
    ...(opts.hidden !== undefined ? { hidden: opts.hidden } : {}),
    ...(opts.tabIndex !== undefined ? { tabIndex: opts.tabIndex } : {}),
    ...(opts.style !== undefined ? { style: opts.style } : {}),
    focusCount: 0,
    focus() {
      el.focusCount += 1;
      doc.activeElement = el;
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
      if (name === 'tabindex') el.tabIndex = Number.parseInt(value, 10);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    hasAttribute(name: string) {
      return attrs.has(name);
    },
    addEventListener(type: string, listener: (e: DialogKeyEventLike) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (e: DialogKeyEventLike) => void) {
      listeners.get(type)?.delete(listener);
    },
    querySelectorAll() {
      const result: MockElement[] = [];
      const walk = (node: MockElement) => {
        for (const child of node.children) {
          const isCandidate =
            child.tagName === 'BUTTON' ||
            child.tagName === 'INPUT' ||
            child.tagName === 'SELECT' ||
            child.tagName === 'TEXTAREA' ||
            (child.tagName === 'A' && child.hasAttribute('href')) ||
            child.hasAttribute('tabindex') ||
            typeof child.tabIndex === 'number' ||
            child.getAttribute('role') === 'button' ||
            child.getAttribute('role') === 'radio' ||
            child.getAttribute('role') === 'switch';
          if (isCandidate) result.push(child);
          walk(child);
        }
      };
      walk(el);
      return result;
    },
    dispatchKey(partial) {
      let defaultPrevented = false;
      let propagationStopped = false;
      const evt: DialogKeyEventLike = {
        ...partial,
        preventDefault: () => {
          defaultPrevented = true;
        },
        stopPropagation: () => {
          propagationStopped = true;
        },
      };
      for (const fn of [...(listeners.get('keydown') ?? [])]) fn(evt);
      return { defaultPrevented, propagationStopped };
    },
  };
  if (opts.supportsInert !== false) {
    el.inert = opts.inert ?? false;
  }
  return el;
}

function append(parent: MockElement, ...children: MockElement[]): void {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
}

describe('attachDesktopDialogTrap (#283)', () => {
  it('is a safe no-op for null, undefined, or non-DOM targets', () => {
    expect(() => attachDesktopDialogTrap(null)()).not.toThrow();
    expect(() => attachDesktopDialogTrap(undefined)()).not.toThrow();
    expect(() => attachDesktopDialogTrap({ nativeView: true })()).not.toThrow();
  });

  it('marks ancestor siblings inert, preserves prior inert state, and restores both on teardown', () => {
    const doc = createMockDoc();
    const appShell = createMockEl(doc, { id: 'app-shell' });
    const navBar = createMockEl(doc, { id: 'nav-bar' });
    const alreadyInertBanner = createMockEl(doc, { id: 'already-inert', inert: true });
    const playerRoot = createMockEl(doc, { id: 'player-root' });
    const surface = createMockEl(doc, { id: 'surface' });
    const osd = createMockEl(doc, { id: 'osd' });
    const triggerBtn = createMockEl(doc, { id: 'trigger-btn', tagName: 'BUTTON', tabIndex: 0 });
    const dialog = createMockEl(doc, { id: 'dialog' });
    const closeBtn = createMockEl(doc, { id: 'close-btn', tagName: 'BUTTON', tabIndex: 0 });
    const optionBtn = createMockEl(doc, { id: 'option-btn', tagName: 'BUTTON', tabIndex: 0 });

    append(doc.body, navBar, alreadyInertBanner, appShell);
    append(appShell, playerRoot);
    append(playerRoot, surface, dialog, osd);
    append(osd, triggerBtn);
    append(dialog, closeBtn, optionBtn);

    triggerBtn.focus();
    expect(doc.activeElement).toBe(triggerBtn);

    const teardown = attachDesktopDialogTrap(dialog, { doc });

    // Background siblings at every ancestor level are inert; dialog & ancestors remain active
    expect(navBar.inert).toBe(true);
    expect(alreadyInertBanner.inert).toBe(true);
    expect(surface.inert).toBe(true);
    expect(osd.inert).toBe(true);
    expect(appShell.inert).toBe(false);
    expect(playerRoot.inert).toBe(false);
    expect(dialog.inert).toBe(false);

    // Focus moved to first focusable descendant inside dialog
    expect(doc.activeElement).toBe(closeBtn);

    // Teardown restores exact previous inert state and returns focus to triggerBtn
    teardown();
    expect(navBar.inert).toBe(false);
    expect(alreadyInertBanner.inert).toBe(true);
    expect(surface.inert).toBe(false);
    expect(osd.inert).toBe(false);
    expect(doc.activeElement).toBe(triggerBtn);

    // Idempotent second teardown does not re-focus or corrupt state
    const prevFocusCount = triggerBtn.focusCount;
    teardown();
    expect(triggerBtn.focusCount).toBe(prevFocusCount);
  });

  it('falls back to aria-hidden="true" when inert is unsupported and restores exact prior attribute', () => {
    const doc = createMockDoc();
    const siblingNoAttr = createMockEl(doc, { id: 's1', supportsInert: false });
    const siblingFalse = createMockEl(doc, {
      id: 's2',
      supportsInert: false,
      attrs: { 'aria-hidden': 'false' },
    });
    const siblingTrue = createMockEl(doc, {
      id: 's3',
      supportsInert: false,
      attrs: { 'aria-hidden': 'true' },
    });
    const dialog = createMockEl(doc, { id: 'dialog', supportsInert: false });
    const btn = createMockEl(doc, { id: 'btn', tagName: 'BUTTON', tabIndex: 0 });

    append(doc.body, siblingNoAttr, siblingFalse, siblingTrue, dialog);
    append(dialog, btn);

    const teardown = attachDesktopDialogTrap(dialog, { doc });
    expect(siblingNoAttr.getAttribute('aria-hidden')).toBe('true');
    expect(siblingFalse.getAttribute('aria-hidden')).toBe('true');
    expect(siblingTrue.getAttribute('aria-hidden')).toBe('true');

    teardown();
    expect(siblingNoAttr.getAttribute('aria-hidden')).toBeNull();
    expect(siblingFalse.getAttribute('aria-hidden')).toBe('false');
    expect(siblingTrue.getAttribute('aria-hidden')).toBe('true');
  });

  it('cycles Tab and Shift+Tab across focusable descendants while skipping disabled, negative tabIndex, hidden, and aria-hidden elements', () => {
    const doc = createMockDoc();
    const dialog = createMockEl(doc, { id: 'dialog' });
    const first = createMockEl(doc, { id: 'first', tagName: 'BUTTON', tabIndex: 0 });
    const disabledBtn = createMockEl(doc, {
      id: 'disabled',
      tagName: 'BUTTON',
      disabled: true,
      tabIndex: 0,
    });
    const negTab = createMockEl(doc, {
      id: 'neg-tab',
      tagName: 'DIV',
      attrs: { tabindex: '-1' },
      tabIndex: -1,
    });
    const hiddenBtn = createMockEl(doc, {
      id: 'hidden',
      tagName: 'BUTTON',
      hidden: true,
      tabIndex: 0,
    });
    const ariaHiddenBtn = createMockEl(doc, {
      id: 'aria-hidden',
      tagName: 'BUTTON',
      attrs: { 'aria-hidden': 'true' },
      tabIndex: 0,
    });
    const hiddenWrapper = createMockEl(doc, {
      id: 'hidden-wrap',
      attrs: { 'aria-hidden': 'true' },
    });
    const nestedHiddenBtn = createMockEl(doc, {
      id: 'nested-hidden',
      tagName: 'BUTTON',
      tabIndex: 0,
    });
    const middle = createMockEl(doc, {
      id: 'middle',
      tagName: 'DIV',
      attrs: { role: 'radio', tabindex: '0' },
      tabIndex: 0,
    });
    const last = createMockEl(doc, { id: 'last', tagName: 'BUTTON', tabIndex: 0 });

    append(hiddenWrapper, nestedHiddenBtn);
    append(doc.body, dialog);
    append(
      dialog,
      first,
      disabledBtn,
      negTab,
      hiddenBtn,
      ariaHiddenBtn,
      hiddenWrapper,
      middle,
      last,
    );

    expect(getFocusableDialogElements(dialog).map((e) => (e as MockElement).id)).toEqual([
      'first',
      'middle',
      'last',
    ]);

    const teardown = attachDesktopDialogTrap(dialog, { doc });
    expect(doc.activeElement).toBe(first);

    // Shift+Tab from first wraps to last
    const wrapBack = dialog.dispatchKey({ key: 'Tab', shiftKey: true });
    expect(wrapBack.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(last);

    // Tab from last wraps to first
    const wrapForward = dialog.dispatchKey({ key: 'Tab', shiftKey: false });
    expect(wrapForward.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(first);

    // Intermediate focus lets browser handle normal Tab without preventing default
    middle.focus();
    expect(dialog.dispatchKey({ key: 'Tab', shiftKey: false }).defaultPrevented).toBe(false);
    expect(dialog.dispatchKey({ key: 'Tab', shiftKey: true }).defaultPrevented).toBe(false);

    teardown();
  });

  it('focuses dialog with fallback tabIndex=-1 when empty, handles Escape cleanly, and respects restoreFocus / isConnected', () => {
    const doc = createMockDoc();
    const trigger = createMockEl(doc, { id: 'trigger', tagName: 'BUTTON', tabIndex: 0 });
    const emptyDialog = createMockEl(doc, { id: 'empty-dialog' });
    append(doc.body, trigger, emptyDialog);

    trigger.focus();
    const onEscape = vi.fn();
    const teardown = attachDesktopDialogTrap(emptyDialog, { doc, onEscape });

    expect(emptyDialog.tabIndex).toBe(-1);
    expect(doc.activeElement).toBe(emptyDialog);

    // Tab inside empty dialog stays pinned on emptyDialog
    const tabRes = emptyDialog.dispatchKey({ key: 'Tab' });
    expect(tabRes.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(emptyDialog);

    // Escape calls onEscape and stops propagation
    const escRes = emptyDialog.dispatchKey({ key: 'Escape' });
    expect(escRes.defaultPrevented).toBe(true);
    expect(escRes.propagationStopped).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);

    // If previousFocus is disconnected before teardown, focus is NOT restored to it
    trigger.isConnected = false;
    const before = trigger.focusCount;
    teardown();
    expect(trigger.focusCount).toBe(before);
    expect(emptyDialog.hasAttribute('tabindex')).toBe(false);

    // When restoreFocus: false, focus is NOT restored even if connected
    trigger.isConnected = true;
    trigger.focus();
    const countBeforeOptOut = trigger.focusCount;
    const teardownNoRestore = attachDesktopDialogTrap(emptyDialog, { doc, restoreFocus: false });
    teardownNoRestore();
    expect(trigger.focusCount).toBe(countBeforeOptOut);
  });

  it('supports non-blocking modal:false + initialFocus:container without setting inert on siblings or hijacking Tab (#58, #57)', () => {
    const doc = createMockDoc();
    const videoSibling = createMockEl(doc, { id: 'video', tagName: 'DIV' });
    const panel = createMockEl(doc, { id: 'panel', tagName: 'DIV' });
    const closeBtn = createMockEl(doc, { id: 'close', tagName: 'BUTTON' });
    append(panel, closeBtn);
    append(doc.body, videoSibling, panel);

    const onEscape = vi.fn();
    const teardown = attachDesktopDialogTrap(panel, {
      doc,
      modal: false,
      initialFocus: 'container',
      onEscape,
    });

    // Sibling video/bar stays interactive (never marked inert or aria-hidden)
    expect(videoSibling.inert).toBe(false);
    expect(videoSibling.getAttribute('aria-hidden')).toBeNull();
    // Focus lands on container itself, not the Close button
    expect(doc.activeElement).toBe(panel);
    expect(closeBtn.focusCount).toBe(0);
    // Tab is NOT trapped
    const tabRes = panel.dispatchKey({ key: 'Tab' });
    expect(tabRes.defaultPrevented).toBe(false);
    // Escape still closes cleanly
    const escRes = panel.dispatchKey({ key: 'Escape' });
    expect(escRes.defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);

    teardown();
    expect(panel.hasAttribute('tabindex')).toBe(false);
  });

  it('keeps backdrop inside overlay wrapper non-inert while isolating background siblings and handles document/window Escape (BLOCKER-3, MAJOR-9)', () => {
    const winListeners = new Map<string, Set<(e: DialogKeyEventLike) => void>>();
    const docListeners = new Map<string, Set<(e: DialogKeyEventLike) => void>>();
    const fakeWin = {
      addEventListener: (type: string, fn: (e: DialogKeyEventLike) => void) => {
        const set = winListeners.get(type) ?? new Set();
        set.add(fn);
        winListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: DialogKeyEventLike) => void) => {
        winListeners.get(type)?.delete(fn);
      },
    };
    const doc = Object.assign(createMockDoc(), {
      defaultView: fakeWin,
      addEventListener: (type: string, fn: (e: DialogKeyEventLike) => void) => {
        const set = docListeners.get(type) ?? new Set();
        set.add(fn);
        docListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: DialogKeyEventLike) => void) => {
        docListeners.get(type)?.delete(fn);
      },
    });

    const appBackground = createMockEl(doc, { id: 'app-background' });
    const overlayWrapper = createMockEl(doc, { id: 'overlay-wrapper' });
    const backdrop = createMockEl(doc, {
      id: 'backdrop',
      tagName: 'DIV',
      attrs: { tabindex: '-1', 'aria-hidden': 'true' },
      tabIndex: -1,
    });
    const dialogPanel = createMockEl(doc, { id: 'dialog-panel' });
    const closeBtn = createMockEl(doc, { id: 'close-btn', tagName: 'BUTTON', tabIndex: 0 });
    const bodyText = createMockEl(doc, { id: 'body-text', tagName: 'P' });

    append(doc.body, appBackground, overlayWrapper);
    append(overlayWrapper, backdrop, dialogPanel);
    append(dialogPanel, closeBtn, bodyText);

    const onEscape = vi.fn();
    const teardown = attachDesktopDialogTrap(overlayWrapper, { doc, onEscape });

    // Background sibling outside overlay IS inert, while backdrop inside overlay stays interactive!
    expect(appBackground.inert).toBe(true);
    expect(backdrop.inert).toBe(false);
    // Focusable elements exclude aria-hidden/tabIndex=-1 backdrop and land on closeBtn
    expect(getFocusableDialogElements(overlayWrapper).map((e) => (e as MockElement).id)).toEqual([
      'close-btn',
    ]);
    expect(doc.activeElement).toBe(closeBtn);

    // Synthetic Escape dispatched on window (e.g. from attachMouseBackGuard / Alt+ArrowLeft / Mouse Back) closes modal once!
    doc.activeElement = bodyText;
    const winPrevent = vi.fn();
    for (const fn of [...(winListeners.get('keydown') ?? [])]) {
      fn({ key: 'Escape', preventDefault: winPrevent });
    }
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(winPrevent).toHaveBeenCalledTimes(1);

    // Document-level Escape when body has focus also closes modal once
    doc.activeElement = doc.body;
    const docPrevent = vi.fn();
    for (const fn of [...(docListeners.get('keydown') ?? [])]) {
      fn({ key: 'Escape', preventDefault: docPrevent });
    }
    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(docPrevent).toHaveBeenCalledTimes(1);

    // Same Escape event bubbling through overlayWrapper -> doc -> win fires onEscape strictly ONCE
    const sharedEvent: DialogKeyEventLike = { key: 'Escape', preventDefault: vi.fn() };
    for (const fn of [...(overlayWrapper.listeners.get('keydown') ?? [])]) fn(sharedEvent);
    for (const fn of [...(docListeners.get('keydown') ?? [])]) fn(sharedEvent);
    for (const fn of [...(winListeners.get('keydown') ?? [])]) fn(sharedEvent);
    expect(onEscape).toHaveBeenCalledTimes(3);

    teardown();
    expect(appBackground.inert).toBe(false);
    expect(winListeners.get('keydown')?.size ?? 0).toBe(0);
    expect(docListeners.get('keydown')?.size ?? 0).toBe(0);
  });

  it('does not steal focus on hover-open when initialFocus is none while preserving Escape handling', () => {
    const docListeners = new Map<string, Set<(e: DialogKeyEventLike) => void>>();
    const doc = Object.assign(createMockDoc(), {
      addEventListener: (type: string, fn: (e: DialogKeyEventLike) => void) => {
        const set = docListeners.get(type) ?? new Set();
        set.add(fn);
        docListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: DialogKeyEventLike) => void) => {
        docListeners.get(type)?.delete(fn);
      },
    });
    const prevTrigger = createMockEl(doc, { id: 'hover-trigger', tagName: 'BUTTON', tabIndex: 0 });
    const otherFocused = createMockEl(doc, { id: 'other-control', tagName: 'INPUT', tabIndex: 0 });
    const hoverPanel = createMockEl(doc, { id: 'hover-panel' });
    const menuItem = createMockEl(doc, { id: 'menu-item', tagName: 'BUTTON', tabIndex: 0 });
    append(doc.body, prevTrigger, otherFocused, hoverPanel);
    append(hoverPanel, menuItem);

    doc.activeElement = otherFocused;
    const onEscape = vi.fn();
    const teardown = attachDesktopDialogTrap(hoverPanel, {
      doc,
      modal: false,
      initialFocus: 'none',
      onEscape,
    });

    expect(doc.activeElement).toBe(otherFocused);
    expect(hoverPanel.getAttribute('tabindex')).toBeNull();

    for (const fn of [...(docListeners.get('keydown') ?? [])]) {
      fn({ key: 'Escape', preventDefault: vi.fn() });
    }
    expect(onEscape).toHaveBeenCalledTimes(1);

    doc.activeElement = prevTrigger;
    teardown();
    expect(doc.activeElement).toBe(prevTrigger);
  });
});
