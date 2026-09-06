// Every screen's paint() does a full container.innerHTML replace on every
// store change — needed to keep computed totals/validation live as the
// user types — but that destroys and rebuilds the focused <input> from
// scratch on every keystroke, dropping focus after each character (reported
// on PO Upload and Inspection; the same store.subscribe(paint) + full
// re-render pattern is shared by every screen with an editable form, so the
// fix lives here once instead of being re-implemented per screen).
//
// Wrap the actual render call with repaintPreservingFocus: it remembers
// which element was focused (matched by id/data-* attributes) and its
// cursor position before the render, then restores both on the equivalent
// freshly-rendered element afterwards.

// Set for the duration of a repaintPreservingFocus render+refocus cycle —
// see onRealBlur below for why any 'blur' handler needs to check this.
let repaintInProgress = false;

/**
 * @param {HTMLElement} root
 * @param {() => void} render
 */
export function repaintPreservingFocus(root, render) {
  const activeEl = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (document.activeElement);
  const focusSelector = activeEl && root.contains(activeEl) ? describeFocusTarget(activeEl) : null;
  const selection =
    focusSelector && typeof activeEl.selectionStart === 'number'
      ? { start: activeEl.selectionStart, end: activeEl.selectionEnd }
      : null;

  // Replacing the DOM below detaches the currently focused element (its
  // node is destroyed and an equivalent new one takes its place) — when a
  // focused element is removed from the document, the browser fires a
  // synchronous 'blur' on it as a side effect, even though focus is
  // restored to its replacement a few lines down and the user never
  // actually left the field. A field that both re-renders live (e.g. on
  // 'input', for a computed total elsewhere) and has its own 'blur'
  // handler would otherwise treat that synthetic blur as real: blur ->
  // setState -> another repaint -> another synthetic blur, forever (hit
  // on Invoices' Payment Terms). onRealBlur checks this flag to ignore
  // blur events that happen only because of this repaint, not a genuine
  // focus change.
  repaintInProgress = true;
  render();
  repaintInProgress = false;

  if (!focusSelector) return;
  const next = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (root.querySelector(focusSelector));
  if (!next) return;
  next.focus();
  if (selection) {
    try {
      next.setSelectionRange(selection.start, selection.end);
    } catch {
      // Some input types (number, date, etc.) don't support selection
      // ranges — focus is still restored, just not the cursor position.
    }
  } else if (next.tagName === 'INPUT' || next.tagName === 'TEXTAREA') {
    // Types like number/date don't expose selectionStart at all, so
    // `selection` above is null and the caret isn't restored above — left
    // alone, focus() plants it at position 0, which would insert every
    // further keystroke at the front instead of the end (typing "125"
    // comes out "521"). Reassigning the value to itself is the standard
    // trick to force the caret to the end. Skipped for anything that isn't
    // a text-entry element (a <select>/<button> regaining focus needs no
    // caret at all).
    const value = next.value;
    next.value = '';
    next.value = value;
  }
}

/**
 * Builds a CSS selector identifying `el` by its id and every data-*
 * attribute, so the equivalent element in a freshly-rendered subtree (same
 * data-action/data-index/data-role/data-id/etc., new DOM node) can be
 * found again after a full re-render.
 * @param {Element} el
 */
function describeFocusTarget(el) {
  const parts = [];
  if (el.id) parts.push(`#${CSS.escape(el.id)}`);
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-')) {
      parts.push(`[${attr.name}="${escapeAttrValue(attr.value)}"]`);
    }
  }
  return parts.length ? parts.join('') : null;
}

/** @param {string} value */
function escapeAttrValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Attaches a 'blur' handler that only runs for a real focus change, never
 * for the synthetic 'blur' repaintPreservingFocus's own DOM replacement
 * fires on the outgoing element (see the repaintInProgress comment there).
 * Every 'blur' handler in the app that triggers a repaint should use this
 * instead of addEventListener('blur', ...) directly.
 * @param {HTMLInputElement} el
 * @param {(e: FocusEvent & { target: HTMLInputElement }) => void} handler
 */
export function onRealBlur(el, handler) {
  el.addEventListener('blur', (e) => {
    if (repaintInProgress) return;
    handler(/** @type {FocusEvent & { target: HTMLInputElement }} */ (e));
  });
}

/**
 * Defers `fn` (a store.setState call that will trigger a
 * repaintPreservingFocus re-render) until just after the browser finishes
 * any focus transfer already in flight — e.g. Tab moving focus to the next
 * field. A 'blur' handler that calls setState synchronously races that
 * transfer: repaintPreservingFocus reads document.activeElement to decide
 * what to refocus, but at the point a 'blur' handler runs, the browser
 * hasn't yet moved focus to the next element — so it force-refocuses the
 * very field that's supposed to be losing focus, breaking Tab navigation
 * (reported after Invoices' date fields were switched to 'blur'). A
 * zero-delay setTimeout runs after the browser completes the focus change
 * already underway, so by the time this re-render happens,
 * document.activeElement correctly reflects wherever the user actually
 * tabbed to.
 * @param {() => void} fn
 */
export function afterFocusSettles(fn) {
  setTimeout(fn, 0);
}

const TABBABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Every element Tab can reach, in DOM/tab order, restricted to what's
 * actually visible (offsetParent is null for display:none — but also for
 * position:fixed, so the current activeElement is always included too, in
 * case it's fixed-positioned itself).
 * @returns {HTMLElement[]}
 */
function tabbableElements() {
  return /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll(TABBABLE_SELECTOR))).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * A native <input type="date"> treats Tab as "move to the next day/month/
 * year segment" and only actually leaves the control once every segment
 * has been passed through (confirmed even on a bare, zero-JS date input —
 * genuine browser behavior, not something introduced by this app's
 * re-render architecture). That's surprising in a multi-field form where
 * every other field's Tab moves straight to the next one — reported on
 * Invoices' Invoice Date, expected to reach Payment Terms in one press.
 * Attach this to a date input (in wireEvents, since the element is
 * recreated on every repaint) to make Tab skip straight past it like any
 * other field; Left/Right arrow keys still move between its segments.
 * @param {HTMLInputElement} dateInput
 */
export function skipDateSegmentsOnTab(dateInput) {
  dateInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = tabbableElements();
    const index = focusable.indexOf(dateInput);
    if (index === -1) return;
    const target = focusable[e.shiftKey ? index - 1 : index + 1];
    if (!target) return;
    e.preventDefault();
    target.focus();
  });
}
