/**
 * annotation_composer.test.ts — native <dialog> wiring for AnnotationComposer (#41).
 *
 * AnnotationComposer was converted from a <div role="dialog"> to a native
 * <dialog> element opened via showModal().  These tests verify the behavioral
 * contract without mounting the Svelte component, because jsdom's partial
 * HTMLDialogElement implementation doesn't support showModal().  Instead, we:
 *
 *  1. Polyfill HTMLDialogElement.showModal / close / cancel on window so the
 *     tests can assert the wiring logic works correctly.
 *  2. Test the logic extracted from the component (handleKeydown, handleCancel,
 *     backdrop-click detection) in pure-function form, mirroring the approach
 *     used by annotation_popover.test.ts and editor_pane_flush.test.ts.
 *
 * JSDOM note: jsdom (used by Vitest) has partial HTMLDialogElement support but
 * does NOT implement showModal() — calling it throws "Not implemented".  The
 * tests below either mock the method or test the underlying logic/event wiring
 * directly, so they pass reliably in jsdom without requiring a live Svelte mount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Polyfill HTMLDialogElement.showModal / close for jsdom ──────────────────
// jsdom defines HTMLDialogElement but does not implement showModal().
// We add no-op stubs so any code path that calls them doesn't throw.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
}

// ── Helpers mirroring the logic inside AnnotationComposer.svelte ─────────────
//
// These pure functions are exact copies of the logic in the component's script.
// If the component changes its logic, update here to match.

function createSave(dispatch: (event: string, detail?: unknown) => void) {
  return function save(body: string): void {
    const trimmed = body.trim();
    if (!trimmed) {
      dispatch('cancel');
      return;
    }
    dispatch('submit', { body: trimmed });
  };
}

function createHandleKeydown(
  dispatch: (event: string, detail?: unknown) => void,
  save: (body: string) => void,
  getBody: () => string,
) {
  return function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save(getBody());
    }
    // Note: Esc is handled by the native <dialog> cancel event, NOT here.
    // The old keydown handler for Escape has been removed.
  };
}

function createHandleCancel(dispatch: (event: string) => void) {
  return function handleCancel(e: Event): void {
    e.preventDefault(); // prevent native dialog auto-close; parent controls open state
    dispatch('cancel');
  };
}

/**
 * Backdrop-click detection: a native <dialog> does NOT close on backdrop click
 * by default.  We add a click handler on the <dialog> element itself; if the
 * click target is the dialog element (not inside the inner content), it means
 * the user clicked on the ::backdrop / margin area.
 */
function createHandleDialogClick(
  dispatch: (event: string) => void,
  getDialog: () => HTMLDialogElement | null,
) {
  return function handleDialogClick(e: MouseEvent): void {
    const dialog = getDialog();
    if (dialog && e.target === dialog) {
      dispatch('cancel');
    }
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AnnotationComposer — native dialog wiring (#41)', () => {

  // ── showModal / close polyfill works in jsdom ────────────────────────────

  describe('HTMLDialogElement polyfill (jsdom compatibility)', () => {
    it('showModal() sets the open attribute', () => {
      const dialog = document.createElement('dialog');
      expect(dialog.hasAttribute('open')).toBe(false);
      dialog.showModal();
      expect(dialog.hasAttribute('open')).toBe(true);
    });

    it('close() removes the open attribute', () => {
      const dialog = document.createElement('dialog');
      dialog.showModal();
      dialog.close();
      expect(dialog.hasAttribute('open')).toBe(false);
    });
  });

  // ── save() logic ─────────────────────────────────────────────────────────

  describe('save()', () => {
    let dispatched: Array<{ event: string; detail?: unknown }>;
    let dispatch: (event: string, detail?: unknown) => void;

    beforeEach(() => {
      dispatched = [];
      dispatch = (event, detail) => dispatched.push({ event, detail });
    });

    it('dispatches submit with trimmed body when body is non-empty', () => {
      const save = createSave(dispatch);
      save('  Hello world  ');
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toEqual({ event: 'submit', detail: { body: 'Hello world' } });
    });

    it('dispatches cancel (not submit) when body is empty / whitespace-only', () => {
      const save = createSave(dispatch);
      save('   ');
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toEqual({ event: 'cancel', detail: undefined });
    });

    it('dispatches cancel when body is an empty string', () => {
      const save = createSave(dispatch);
      save('');
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].event).toBe('cancel');
    });
  });

  // ── Enter key → save ─────────────────────────────────────────────────────

  describe('handleKeydown()', () => {
    let dispatched: Array<{ event: string; detail?: unknown }>;
    let dispatch: (event: string, detail?: unknown) => void;
    let body: string;

    beforeEach(() => {
      dispatched = [];
      dispatch = (event, detail) => dispatched.push({ event, detail });
      body = '';
    });

    it('Enter (no Shift) calls save → dispatches submit when body is non-empty', () => {
      body = 'My comment';
      const save = createSave(dispatch);
      const handleKeydown = createHandleKeydown(dispatch, save, () => body);

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, cancelable: true });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      handleKeydown(event);

      expect(preventDefault).toHaveBeenCalled();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toEqual({ event: 'submit', detail: { body: 'My comment' } });
    });

    it('Shift+Enter does NOT save (allows newline insertion)', () => {
      body = 'Line one';
      const save = createSave(dispatch);
      const handleKeydown = createHandleKeydown(dispatch, save, () => body);

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      handleKeydown(event);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(dispatched).toHaveLength(0);
    });

    it('other keys are ignored', () => {
      const save = createSave(dispatch);
      const handleKeydown = createHandleKeydown(dispatch, save, () => body);

      const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
      handleKeydown(event);

      expect(dispatched).toHaveLength(0);
    });

    it('Enter with empty body dispatches cancel (via save)', () => {
      body = '';
      const save = createSave(dispatch);
      const handleKeydown = createHandleKeydown(dispatch, save, () => body);

      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, cancelable: true });
      handleKeydown(event);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].event).toBe('cancel');
    });
  });

  // ── Esc via native dialog cancel event ───────────────────────────────────

  describe('handleCancel() — native dialog cancel event (Esc)', () => {
    let dispatched: Array<{ event: string }>;
    let dispatch: (event: string) => void;

    beforeEach(() => {
      dispatched = [];
      dispatch = (event) => dispatched.push({ event });
    });

    it('dispatches cancel when the native dialog cancel event fires', () => {
      const handleCancel = createHandleCancel(dispatch);
      const event = new Event('cancel', { cancelable: true });
      const preventDefault = vi.spyOn(event, 'preventDefault');

      handleCancel(event);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].event).toBe('cancel');
      // Must preventDefault so the dialog doesn't auto-close (parent controls state)
      expect(preventDefault).toHaveBeenCalled();
    });
  });

  // ── Backdrop click → cancel ───────────────────────────────────────────────
  //
  // Native <dialog> does NOT close on backdrop click by default.  The composer
  // adds an explicit click handler on the <dialog> element: if the click target
  // IS the dialog element itself (::backdrop area), it dispatches cancel.

  describe('handleDialogClick() — backdrop-click cancels', () => {
    let dispatched: Array<{ event: string }>;
    let dispatch: (event: string) => void;
    let dialog: HTMLDialogElement;

    beforeEach(() => {
      dispatched = [];
      dispatch = (event) => dispatched.push({ event });
      dialog = document.createElement('dialog');
      dialog.innerHTML = '<div class="composer"><p>content</p></div>';
      document.body.appendChild(dialog);
    });

    afterEach(() => {
      document.body.removeChild(dialog);
    });

    it('dispatches cancel when clicking directly on the <dialog> (backdrop area)', () => {
      const handleDialogClick = createHandleDialogClick(dispatch, () => dialog);

      // Simulate a click whose target is the dialog element itself (backdrop)
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: dialog, configurable: true });

      handleDialogClick(event);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].event).toBe('cancel');
    });

    it('does NOT cancel when clicking inside the inner .composer content', () => {
      const handleDialogClick = createHandleDialogClick(dispatch, () => dialog);
      const innerDiv = dialog.querySelector('.composer')!;

      // Simulate a click whose target is the inner content element (not the dialog)
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: innerDiv, configurable: true });

      handleDialogClick(event);

      expect(dispatched).toHaveLength(0);
    });
  });

  // ── Element is a native <dialog> ─────────────────────────────────────────
  //
  // Sanity check that AnnotationComposer's root element is expected to be a
  // <dialog>, not a <div>.  This is verified by reading the component file in
  // the test (a structural assertion without mounting the component).

  describe('structural: AnnotationComposer uses <dialog> element', () => {
    it('the component template opens with a <dialog> element', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const componentPath = path.resolve(
        __dirname,
        '../lib/AnnotationComposer.svelte',
      );
      const source = fs.readFileSync(componentPath, 'utf-8');

      // Must use a <dialog> element (not <div role="dialog">)
      expect(source).toMatch(/<dialog\b/);
      // Must NOT use the old <div role="dialog"> pattern
      expect(source).not.toMatch(/<div[^>]+role="dialog"/);
    });

    it('wires the native cancel event to dispatch cancel', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const componentPath = path.resolve(
        __dirname,
        '../lib/AnnotationComposer.svelte',
      );
      const source = fs.readFileSync(componentPath, 'utf-8');

      // The dialog element must handle the native cancel event
      expect(source).toMatch(/on:cancel/);
    });

    it('calls showModal() to open the dialog', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const componentPath = path.resolve(
        __dirname,
        '../lib/AnnotationComposer.svelte',
      );
      const source = fs.readFileSync(componentPath, 'utf-8');

      expect(source).toMatch(/showModal\s*\(\s*\)/);
    });
  });
});
