import { describe, it, expect, vi } from 'vitest';
import { repaintPreservingFocus, afterFocusSettles } from './domFocus.js';

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
