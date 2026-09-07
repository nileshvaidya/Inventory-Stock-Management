import { describe, it, expect, vi } from 'vitest';
import { repaintPreservingFocus, repaintPreservingScroll, afterFocusSettles, onRealBlur } from './domFocus.js';

function mount(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('repaintPreservingFocus', () => {
  it('restores focus and cursor position to the equivalent element after a full re-render', () => {
    const root = mount('<input data-action="item-name" data-index="0" value="M6 Hex" />');
    const before = root.querySelector('input');
    before.focus();
    before.setSelectionRange(2, 2);

    repaintPreservingFocus(root, () => {
      // Simulates the same full innerHTML replace every screen's paint()
      // does — a brand-new element, not the one focus() was called on.
      root.innerHTML = '<input data-action="item-name" data-index="0" value="M6 Hex Bolt" />';
    });

    const after = root.querySelector('input');
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(2);
    expect(after.selectionEnd).toBe(2);
  });

  it('restores focus (not the front-inserting default) for a number input, whose selection API is unavailable', () => {
    const root = mount('<input type="number" data-action="item-qty" data-index="0" value="12" />');
    const before = root.querySelector('input');
    before.focus();

    expect(() => {
      repaintPreservingFocus(root, () => {
        root.innerHTML = '<input type="number" data-action="item-qty" data-index="0" value="125" />';
      });
    }).not.toThrow();

    const after = root.querySelector('input');
    expect(document.activeElement).toBe(after);
    expect(after.value).toBe('125');
  });

  it('does not crash and still renders when nothing was focused', () => {
    const root = mount('<p>static content</p>');
    let rendered = false;

    repaintPreservingFocus(root, () => {
      rendered = true;
      root.innerHTML = '<p>updated</p>';
    });

    expect(rendered).toBe(true);
    expect(root.textContent).toBe('updated');
  });

  it('does not crash when the focused element is removed by the render (e.g. its row was deleted)', () => {
    const root = mount('<input data-action="item-name" data-index="0" value="x" />');
    root.querySelector('input').focus();

    expect(() => {
      repaintPreservingFocus(root, () => {
        root.innerHTML = '<p>no rows left</p>';
      });
    }).not.toThrow();
  });

  it('restores focus to a <select> without touching its selected value', () => {
    const root = mount(`
      <select data-action="item-link" data-index="0">
        <option value="">Not linked</option>
        <option value="item-1" selected>Widget</option>
      </select>
    `);
    root.querySelector('select').focus();

    repaintPreservingFocus(root, () => {
      root.innerHTML = `
        <select data-action="item-link" data-index="0">
          <option value="">Not linked</option>
          <option value="item-1" selected>Widget</option>
        </select>
      `;
    });

    const after = root.querySelector('select');
    expect(document.activeElement).toBe(after);
    expect(after.value).toBe('item-1');
  });
});

describe('onRealBlur', () => {
  it('ignores the synthetic blur repaintPreservingFocus causes by replacing the focused element', () => {
    // Reproduces the infinite loop found on Invoices' Payment Terms: a
    // field with both a live 'input' handler (re-rendering on every
    // keystroke, for a computed total elsewhere) and its own 'blur'
    // handler. Removing a focused element from the DOM (what every
    // repaint does) fires a synchronous 'blur' on it — without this
    // filter, that would trigger the handler, which calls setState,
    // which triggers another repaint, forever.
    const root = mount('<input data-action="terms" value="x" />');
    const input = root.querySelector('input');
    input.focus();

    let calls = 0;
    onRealBlur(input, () => {
      calls += 1;
    });

    repaintPreservingFocus(root, () => {
      root.innerHTML = '<input data-action="terms" value="x" />';
    });

    expect(calls).toBe(0);
  });

  it('still runs for a real blur, where focus genuinely moves to another element', () => {
    const root = mount('<input data-action="terms" value="x" /><input data-action="other" />');
    const input = /** @type {HTMLInputElement} */ (root.querySelector('[data-action="terms"]'));
    const other = /** @type {HTMLInputElement} */ (root.querySelector('[data-action="other"]'));
    input.focus();

    let calls = 0;
    onRealBlur(input, () => {
      calls += 1;
    });

    other.focus();

    expect(calls).toBe(1);
  });
});

describe('repaintPreservingScroll', () => {
  it('restores scrollTop on the equivalent element after a full re-render', () => {
    const root = mount('<div data-role="scroller" style="overflow-y:auto"><p>row 1</p></div>');
    const before = root.querySelector('[data-role="scroller"]');
    before.scrollTop = 240;

    repaintPreservingScroll(root, '[data-role="scroller"]', () => {
      // Simulates a full innerHTML replace appending more rows — a
      // brand-new element, not the one scrollTop was set on.
      root.innerHTML = '<div data-role="scroller" style="overflow-y:auto"><p>row 1</p><p>row 2</p></div>';
    });

    const after = root.querySelector('[data-role="scroller"]');
    expect(after.scrollTop).toBe(240);
  });

  it('does not crash when the scrollable element does not exist yet (e.g. still loading)', () => {
    const root = mount('<p>Loading…</p>');

    expect(() => {
      repaintPreservingScroll(root, '[data-role="scroller"]', () => {
        root.innerHTML = '<div data-role="scroller"><p>row 1</p></div>';
      });
    }).not.toThrow();
  });
});

describe('afterFocusSettles', () => {
  it('defers the callback rather than running it synchronously', () => {
    vi.useFakeTimers();
    let ran = false;
    afterFocusSettles(() => {
      ran = true;
    });
    // Not yet — this is the whole point: a 'blur' handler that calls
    // setState synchronously races the browser's own in-flight focus
    // transfer (e.g. Tab moving to the next field), stealing focus back.
    expect(ran).toBe(false);
    vi.runAllTimers();
    expect(ran).toBe(true);
    vi.useRealTimers();
  });
});
