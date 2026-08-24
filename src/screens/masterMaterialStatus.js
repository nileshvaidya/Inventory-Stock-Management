// Master Material Status (Phase 3): company-wide, filterable, exportable
// view of every PO/item's receipt and inspection status — one row per PO
// line item (Ordered/Received/Accepted/Rejected/Pending).
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { createStore } from '../state.js';
import { canViewModule } from '../navPermissions.js';
import { fetchMasterMaterialStatus } from '../masterMaterialStatus.js';
import { fetchProjects } from '../projects.js';
import { PO_STATUSES, poStatusLabel, poStatusTagClass } from '../poStatus.js';
import { toCsv, downloadCsv } from '../csvExport.js';

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }
  if (!canViewModule('/master-material-status', user.role)) {
    window.location.hash = '#/dashboard';
    return;
  }

  const content = renderShell(container, { activeRoute: '/master-material-status', user });
  content.setAttribute('data-screen', 'master-material-status');
  const store = createStore({
    rows: [],
    projects: [],
    loading: true,
    error: false,
    projectId: '',
    status: '',
  });

  async function load() {
    store.setState({ loading: true, error: false });
    const s = store.getState();
    try {
      const rows = await fetchMasterMaterialStatus({ projectId: s.projectId || undefined, status: s.status || undefined });
      store.setState({ rows, loading: false, error: false });
    } catch {
      store.setState({ loading: false, error: true });
    }
  }

  function paint() {
    renderContent(content, store.getState());
    wireEvents(content, store, load);
  }

  store.subscribe(paint);
  paint();
  const projects = await fetchProjects();
  store.setState({ projects });
  await load();
}

function renderContent(container, state) {
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <h1 style="margin:0">Master Material Status</h1>
      <button type="button" class="btn btn-secondary" data-action="export-csv">Export CSV</button>
    </div>

    <div class="card elev-sm" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
        <div class="field"><label for="mms-filter-project">Project</label>
          <select class="input" id="mms-filter-project" data-action="filter-project">
            <option value="">All</option>
            ${state.projects.map((p) => `<option value="${escapeHtml(p.id)}" ${state.projectId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="mms-filter-status">Status</label>
          <select class="input" id="mms-filter-status" data-action="filter-status">
            <option value="">All</option>
            ${PO_STATUSES.map((s) => `<option value="${escapeHtml(s)}" ${state.status === s ? 'selected' : ''}>${escapeHtml(poStatusLabel(s))}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>

    <div class="card elev-sm" style="padding:0;overflow-x:auto">
      ${
        state.loading
          ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">Loading…</div>`
          : state.error
            ? `<div style="padding:20px;text-align:center">
                <p style="font-size:13px;color:var(--color-accent-2-200);margin:0 0 10px">Couldn't load material status.</p>
                <button type="button" class="btn btn-secondary" data-action="retry">Retry</button>
              </div>`
            : state.rows.length === 0
              ? `<div style="padding:20px;font-size:13px;color:var(--color-neutral-500)">No line items match these filters.</div>`
              : `<table class="table" style="min-width:820px">
                  <thead><tr><th>PO Number</th><th>Project</th><th>Vendor</th><th>Item</th><th>Ordered</th><th>Received</th><th>Accepted</th><th>Rejected</th><th>Pending</th><th>Status</th></tr></thead>
                  <tbody>${state.rows.map(renderRow).join('')}</tbody>
                </table>`
      }
    </div>
  `;
}

function renderRow(row) {
  return `
    <tr data-mms-row="${escapeHtml(row.po_line_item_id)}">
      <td>${escapeHtml(row.po_number || '—')}</td>
      <td>${escapeHtml(row.project_name || '—')}</td>
      <td>${escapeHtml(row.vendor_name || '—')}</td>
      <td>${escapeHtml(row.item_name)}</td>
      <td>${row.ordered_qty}</td>
      <td>${row.received_qty}</td>
      <td>${row.accepted_qty}</td>
      <td>${row.rejected_qty}</td>
      <td>${row.pending_qty}</td>
      <td><span class="tag ${poStatusTagClass(row.po_status)}">${escapeHtml(poStatusLabel(row.po_status))}</span></td>
    </tr>`;
}

function wireEvents(container, store, load) {
  const bindFilter = (selector, key) => {
    container.querySelector(selector)?.addEventListener('change', (e) => {
      store.setState({ [key]: e.target.value });
      load();
    });
  };
  bindFilter('[data-action="filter-project"]', 'projectId');
  bindFilter('[data-action="filter-status"]', 'status');

  container.querySelector('[data-action="retry"]')?.addEventListener('click', load);

  container.querySelector('[data-action="export-csv"]')?.addEventListener('click', () => {
    const { rows } = store.getState();
    const csv = toCsv(
      rows.map((row) => ({
        po_number: row.po_number || '',
        project: row.project_name || '',
        vendor: row.vendor_name || '',
        item: row.item_name,
        ordered: row.ordered_qty,
        received: row.received_qty,
        accepted: row.accepted_qty,
        rejected: row.rejected_qty,
        pending: row.pending_qty,
        status: poStatusLabel(row.po_status),
      })),
      [
        { key: 'po_number', header: 'PO Number' },
        { key: 'project', header: 'Project' },
        { key: 'vendor', header: 'Vendor' },
        { key: 'item', header: 'Item' },
        { key: 'ordered', header: 'Ordered' },
        { key: 'received', header: 'Received' },
        { key: 'accepted', header: 'Accepted' },
        { key: 'rejected', header: 'Rejected' },
        { key: 'pending', header: 'Pending' },
        { key: 'status', header: 'Status' },
      ]
    );
    downloadCsv(csv, `master-material-status-${new Date().toISOString().slice(0, 10)}.csv`);
  });
}
