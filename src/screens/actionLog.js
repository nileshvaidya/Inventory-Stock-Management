// Action Log (Phase 9): a filterable audit trail of every action across
// the app — username, date range, and action type (table + operation).
// Admin only. Populated automatically by a database trigger attached to
// every mutable table (see supabase/schema.sql's trg_log_action()) — this
// screen only ever reads it.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchActionLog, describeAction, TABLE_LABELS, OPERATION_LABELS } from '../actionLog.js';
import { fetchAdminUsers } from '../admin.js';
import { toCsv, downloadCsv } from '../csvExport.js';
import { repaintPreservingFocus, afterFocusSettles } from '../domFocus.js';

function initialState() {
  return {
    rows: [],
    users: [],
    loading: true,
    error: false,
    userId: '',
    tableName: '',
    operation: '',
    dateFrom: '',
    dateTo: '',
    openRowId: null,
  };
}

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/action-log', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/action-log', user });
  content.setAttribute('data-screen', 'action-log');
  const store = createStore(initialState());

  async function load() {
    store.setState({ loading: true, error: false });
    const s = store.getState();
    try {
      const rows = await fetchActionLog({
        userId: s.userId || undefined,
        tableName: s.tableName || undefined,
        operation: s.operation || undefined,
        dateFrom: s.dateFrom || undefined,
        dateTo: s.dateTo || undefined,
      });
      store.setState({ rows, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    // Without repaintPreservingFocus, any repaint (a filter's 'change',
    // the date fields' deferred 'blur' above) drops focus to <body> — this
    // screen never got the fix the other screens received when the
    // original per-keystroke focus-loss bug was found, since none of its
    // fields need live per-keystroke reactivity. It still needs the same
    // wrapper for anything that re-renders while a field has focus.
    repaintPreservingFocus(content, () => {
      renderContent(content, store.getState());
      wireEvents(content, store, load);
    });
  }

  store.subscribe(paint);
  paint();
  const users = await fetchAdminUsers();
  store.setState({ users });
  await load();
}

function renderContent(container, state) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Action Log</h1>
      <button type="button" class="btn btn-secondary" data-action="export-csv">Export CSV</button>
    </div>

    <div class="card elev-sm" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
        <div class="field"><label for="al-filter-user">User</label>
          <select class="input" id="al-filter-user" data-action="filter-user">
            <option value="">All</option>
            ${state.users.map((u) => `<option value="${escapeHtml(u.id)}" ${state.userId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="al-filter-table">Record Type</label>
          <select class="input" id="al-filter-table" data-action="filter-table">
            <option value="">All</option>
            ${Object.entries(TABLE_LABELS)
              .map(([key, label]) => `<option value="${escapeHtml(key)}" ${state.tableName === key ? 'selected' : ''}>${escapeHtml(label)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field"><label for="al-filter-operation">Action</label>
          <select class="input" id="al-filter-operation" data-action="filter-operation">
            <option value="">All</option>
            ${Object.entries(OPERATION_LABELS)
              .map(([key, label]) => `<option value="${escapeHtml(key)}" ${state.operation === key ? 'selected' : ''}>${escapeHtml(label)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field"><label for="al-filter-date-from">From</label>
          <input class="input" id="al-filter-date-from" type="date" data-action="filter-date-from" value="${escapeHtml(state.dateFrom)}" />
        </div>
        <div class="field"><label for="al-filter-date-to">To</label>
          <input class="input" id="al-filter-date-to" type="date" data-action="filter-date-to" value="${escapeHtml(state.dateTo)}" />
        </div>
      </div>
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load the action log.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.rows.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No actions match these filters.</div>`
              : `<table class="table" style="min-width:680px">
                  <thead><tr><th>Date/Time</th><th>User</th><th>Action</th><th></th></tr></thead>
                  <tbody>${state.rows.map((row) => renderRow(row, state)).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderRow(row, state) {
  const isOpen = state.openRowId === row.id;
  const rows = [
    `<tr data-action-row="${escapeHtml(row.id)}">
      <td>${escapeHtml(new Date(row.created_at).toLocaleString())}</td>
      <td>${escapeHtml(row.user?.name || '—')}</td>
      <td>${escapeHtml(describeAction(row))}</td>
      <td><button type="button" class="btn btn-ghost" data-action="toggle-row" data-id="${escapeHtml(row.id)}" style="padding:4px 10px;font-size:12px">${isOpen ? 'Hide' : 'Details'}</button></td>
    </tr>`,
  ];

  if (isOpen) {
    rows.push(`
      <tr data-action-detail-row="${escapeHtml(row.id)}">
        <td colspan="4" style="padding:12px 14px;border-top:1px solid var(--color-divider)">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
            <div>
              <p style="font-size:12px;color:var(--color-neutral-500);margin:0 0 4px">Before</p>
              <pre style="font-size:11px;white-space:pre-wrap;word-break:break-all;margin:0">${escapeHtml(row.old_data ? JSON.stringify(row.old_data, null, 2) : '—')}</pre>
            </div>
            <div>
              <p style="font-size:12px;color:var(--color-neutral-500);margin:0 0 4px">After</p>
              <pre style="font-size:11px;white-space:pre-wrap;word-break:break-all;margin:0">${escapeHtml(row.new_data ? JSON.stringify(row.new_data, null, 2) : '—')}</pre>
            </div>
          </div>
        </td>
      </tr>
    `);
  }
  return rows.join('');
}

function wireEvents(container, store, load) {
  const bindFilter = (selector, key) => {
    container.querySelector(selector)?.addEventListener('change', (e) => {
      store.setState({ [key]: e.target.value });
      load();
    });
  };
  bindFilter('[data-action="filter-user"]', 'userId');
  bindFilter('[data-action="filter-table"]', 'tableName');
  bindFilter('[data-action="filter-operation"]', 'operation');
  // Date fields use 'blur', not the 'change' the filters above share:
  // Chrome fires 'change' on a date input on every completed segment, not
  // just once the full date is committed, so wiring it the same way as a
  // <select> would re-render (destroying/recreating the input, since this
  // screen doesn't use repaintPreservingFocus — there's no other live-typed
  // field to preserve) on every keystroke while the user is still typing a
  // date, and can also fight the browser's own Tab-driven focus transfer
  // out of the field (see domFocus.js's afterFocusSettles for why the
  // state update itself needs deferring, not just the event choice).
  const bindDateFilter = (selector, key) => {
    container.querySelector(selector)?.addEventListener('blur', (e) => {
      const value = e.target.value;
      afterFocusSettles(() => {
        store.setState({ [key]: value });
        load();
      });
    });
  };
  bindDateFilter('[data-action="filter-date-from"]', 'dateFrom');
  bindDateFilter('[data-action="filter-date-to"]', 'dateTo');

  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelectorAll('[data-action="toggle-row"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = store.getState();
      const id = btn.dataset.id;
      store.setState({ openRowId: state.openRowId === id ? null : id });
    });
  });

  container.querySelector('[data-action="export-csv"]')?.addEventListener('click', () => {
    const { rows } = store.getState();
    const csv = toCsv(
      rows.map((row) => ({
        date: new Date(row.created_at).toLocaleString(),
        user: row.user?.name || '',
        action: describeAction(row),
        row_id: row.row_id || '',
      })),
      [
        { key: 'date', header: 'Date/Time' },
        { key: 'user', header: 'User' },
        { key: 'action', header: 'Action' },
        { key: 'row_id', header: 'Row ID' },
      ]
    );
    downloadCsv(csv, `action-log-${new Date().toISOString().slice(0, 10)}.csv`);
  });
}
