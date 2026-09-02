// In-app Help / User Manual — a click-by-click walkthrough of every
// screen, illustrated with real screenshots (public/help/screenshots/,
// captured via scripts/capture-help-screenshots.mjs against demo mode;
// see that script's own comment for how to regenerate them after a UI
// change), plus a Frequently Asked Questions section. No data fetching —
// this screen is pure static content, unlike every other authenticated
// screen, so it has no loading/error/empty states.
//
// Build brief §3: "explicitly exclude any mention of the Bill Payments
// module from the help content shown to non-authorized roles — maintain
// two help views, or role-conditional help sections." The restricted
// section below is built into its own HTML string and only spliced into
// the page when the viewer's role is 'authorized' (checked via
// canViewModule, same source of truth the sidebar/route guard use) — it's
// never present in the DOM at all for anyone else, not just hidden by CSS.
import { getCurrentProfile } from '../auth.js';
import { renderShell } from '../layout.js';
import { escapeHtml } from '../components.js';
import { canViewModule } from '../navPermissions.js';

const SHOT = '/help/screenshots';

export async function render(container) {
  const user = await getCurrentProfile();
  if (!user) {
    window.location.hash = '#/login';
    return;
  }

  const content = renderShell(container, { activeRoute: '/help', user });
  content.setAttribute('data-screen', 'help');
  content.innerHTML = renderHelp(user);

  content.querySelectorAll('[data-toc-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = content.querySelector(link.getAttribute('href'));
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  content.querySelectorAll('[data-faq-question]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const answer = btn.parentElement.querySelector('[data-faq-answer]');
      const willOpen = answer.classList.contains('hidden');
      answer.classList.toggle('hidden', !willOpen);
      btn.querySelector('[data-faq-caret]').textContent = willOpen ? '▾' : '▸';
    });
  });
}

function img(src, alt) {
  return `<img src="${SHOT}/${src}" alt="${escapeHtml(alt)}" style="width:100%;max-width:680px;border-radius:var(--radius-md);border:1px solid var(--color-divider);margin:10px 0 16px;display:block" />`;
}

function section(id, title, bodyHtml) {
  return `
    <section id="${id}" class="card elev-sm" style="padding:20px;margin-bottom:20px;scroll-margin-top:16px">
      <h2 style="font-size:20px;margin-bottom:12px">${escapeHtml(title)}</h2>
      ${bodyHtml}
    </section>`;
}

function h3(text) {
  return `<h3 style="font-size:15px;font-weight:600;margin:14px 0 6px">${escapeHtml(text)}</h3>`;
}

function ol(items) {
  return `<ol style="padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--color-neutral-300);margin:0">${items
    .map((i) => `<li>${i}</li>`)
    .join('')}</ol>`;
}

function note(text) {
  return `<p style="font-size:13px;color:var(--color-neutral-500);margin-top:8px">${text}</p>`;
}

const TOC = [
  ['help-getting-started', 'Getting Started'],
  ['help-dashboard', 'Dashboard'],
  ['help-po-upload', 'PO Upload'],
  ['help-order-status', 'Order Status'],
  ['help-material-inward', 'Material Inward'],
  ['help-inspection', 'Inspection'],
  ['help-master-material-status', 'Master Material Status'],
  ['help-inventory', 'Inventory'],
  ['help-bom-builder', 'BoM Builder'],
  ['help-work-orders', 'Work Orders'],
  ['help-invoices', 'Invoices'],
  ['help-reports', 'Reports'],
  ['help-users-roles', 'Users & Roles'],
  ['help-action-log', 'Action Log'],
];

const RESTRICTED_TOC_ENTRY = ['help-bill-payments', 'Bill Payments'];

const TAIL_TOC = [
  ['help-faq', 'Frequently Asked Questions'],
  ['help-troubleshooting', 'Troubleshooting'],
];

/** @param {{ name: string, email: string, role: string|null }} user */
export function renderHelp(user) {
  const canSeeBillPayments = canViewModule('/bill-payments', user.role);
  const toc = [...TOC, ...(canSeeBillPayments ? [RESTRICTED_TOC_ENTRY] : []), ...TAIL_TOC];

  return `
    <div style="margin-bottom:20px">
      <h1 style="margin-bottom:4px">Help &amp; User Manual</h1>
      <p style="font-size:14px;color:var(--color-neutral-400);margin:0">A step-by-step guide to every screen in Inventory &amp; Stock Management, with real screenshots. New to the app? Start at <a href="#help-getting-started" data-toc-link>Getting Started</a>.</p>
    </div>

    <nav class="card elev-sm" style="padding:14px;margin-bottom:20px" aria-label="Table of contents">
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${toc
          .map(
            ([id, label]) =>
              `<a href="#${id}" data-toc-link class="tag tag-neutral" style="text-decoration:none;cursor:pointer">${escapeHtml(label)}</a>`
          )
          .join('')}
      </div>
    </nav>

    ${renderGettingStarted(canSeeBillPayments)}
    ${renderDashboard()}
    ${renderPoUpload()}
    ${renderOrderStatus()}
    ${renderMaterialInward()}
    ${renderInspection()}
    ${renderMasterMaterialStatus()}
    ${renderInventory()}
    ${renderBomBuilder()}
    ${renderWorkOrders()}
    ${renderInvoices()}
    ${renderReports()}
    ${renderUsersRoles()}
    ${renderActionLog()}
    ${canSeeBillPayments ? renderBillPayments() : ''}
    ${renderFaq(canSeeBillPayments)}
    ${renderTroubleshooting()}

    <p style="font-size:13px;color:var(--color-neutral-500);text-align:center;margin-top:8px">Signed in as ${escapeHtml(user.name)} (${escapeHtml(user.role || 'no role assigned')}). For anything not covered here, contact your admin.</p>
  `;
}

/** @param {boolean} canSeeBillPayments */
function renderGettingStarted(canSeeBillPayments) {
  const authorizedModules = canSeeBillPayments ? 'Invoices, Reports, Bill Payments' : 'Invoices, Reports';
  return section(
    'help-getting-started',
    'Getting Started',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">This app manages purchasing, material receiving/inspection, inventory, bills of materials, work orders, invoices, and reports for ASK Info-Solutions LLP. Everything is reached from the sidebar on the left (or the bottom tab bar on a phone).</p>

    ${h3('Signing in')}
    ${ol([
      'Open the app in your browser. The <strong>Sign In</strong> tab is selected by default.',
      'Click the <strong>Email</strong> field and type your email address.',
      'Click the <strong>Password</strong> field and type your password.',
      'Click the <strong>Sign In</strong> button.',
      'You land on the <a href="#help-dashboard" data-toc-link>Dashboard</a>. If your account has been deactivated, you\'ll see "This account is inactive. Contact your admin." instead — see <a href="#help-troubleshooting" data-toc-link>Troubleshooting</a>.',
    ])}
    ${img('01-login-signin.png', 'The Sign In screen, with the Email and Password fields and the Sign In button')}

    ${h3('Creating an account')}
    ${ol([
      'On the login screen, click the <strong>Sign Up</strong> tab.',
      'Fill in your <strong>Name</strong>, <strong>Email</strong>, and a <strong>Password</strong> (at least 6 characters).',
      'Click <strong>Create Account</strong>. You\'re signed in immediately and land on the Dashboard.',
    ])}
    ${img('02-login-signup.png', 'The Sign Up tab, showing Name, Email, and Password fields')}
    ${note('A brand-new account has no role yet, so almost every screen is hidden until an admin assigns you one from <a href="#help-users-roles" data-toc-link>Users &amp; Roles</a> — see the Dashboard below.')}

    ${h3('What you see depends on your role')}
    <p style="font-size:14px;color:var(--color-neutral-300);margin:0">The sidebar only ever shows the screens your role can use — nobody sees every menu item. The roles are: <strong>Admin</strong> (sees and manages everything), <strong>Purchase</strong> (PO Upload, Order Status), <strong>Store/Warehouse</strong> (Material Inward, Inventory, Work Orders), <strong>Inspector</strong> (Inspection), <strong>Accounts/Authorized</strong> (${authorizedModules}), and <strong>Production</strong> (Inventory, BoM Builder, Work Orders, Reports). If a screen you need is missing, ask an admin to check your role in <a href="#help-users-roles" data-toc-link>Users &amp; Roles</a>.</p>
    `
  );
}

function renderDashboard() {
  return section(
    'help-dashboard',
    'Dashboard',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin:0">Your landing page after signing in. It shows your name and your assigned role. Use the sidebar (left, or the bottom tabs on a phone) to go anywhere else in the app.</p>
    ${img('03-dashboard.png', 'The Dashboard, showing a welcome message, the signed-in role, and the full sidebar')}
    `
  );
}

function renderPoUpload() {
  return section(
    'help-po-upload',
    'PO Upload',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Turns an approved Purchase Order PDF into a saved record: upload the file, review the items it found (fixing anything wrong), link it to a Project and Vendor, then save.</p>

    ${h3('Step 1 — Upload the PDF')}
    ${ol([
      'Click <strong>Choose File</strong> under "Upload PO PDF" and pick the PDF from your computer.',
      'The app reads the file and tries to fill in the Line Items table below automatically (item name, quantity, rate) along with the PO Number and Order Date, where it can find them.',
      'If nothing was found, a message appears explaining that — you can still add every row by hand, or use <strong>Map Fields Manually</strong> (below) to build rows from the extracted text.',
    ])}

    ${h3('Step 2 — Check and fix the Line Items')}
    ${ol([
      'Every row is editable — click into <strong>Item</strong>, <strong>Qty</strong>, or <strong>Rate</strong> and correct anything the parser got wrong.',
      'Click <strong>+ Add Row</strong> to add a blank row by hand, or the 🗑 icon at the end of a row to remove it.',
      '<strong>Linked Item</strong> (optional): pick a matching entry from the Item Master dropdown so this purchase feeds the Inventory ledger once it\'s received. Click <strong>+ New Item</strong> if it doesn\'t exist yet, type a name, and click <strong>Add</strong>.',
      'The <strong>Computed total</strong> at the bottom of the table is quantity × rate summed across every row. If the PDF also stated a total and the two don\'t match, a warning appears — it doesn\'t block saving, just double-check the rows.',
    ])}
    ${img('04-po-upload.png', 'PO Upload with two reviewed line items, Details filled in, and the computed/PDF totals shown')}

    ${h3('Fill in the Details')}
    ${ol([
      '<strong>Project / Order</strong>: pick one from the dropdown, or click <strong>+ New</strong>, type a name, and click <strong>Add</strong> — required before saving.',
      '<strong>Vendor</strong> (optional): pick one, or click <strong>+ New</strong> next to it and fill in Name (required), GSTIN, and Contact.',
      '<strong>Order Date</strong>, <strong>PO Number</strong>, and <strong>Payment Terms (days)</strong> are pre-filled from the PDF where possible — all editable.',
    ])}

    ${h3('If the PDF layout wasn\'t recognized: Map Fields Manually')}
    ${ol([
      'Click <strong>Show</strong> next to "Map Fields Manually" to expand the panel (it opens automatically if nothing was parsed).',
      'If you need to start from pasted text instead of a PDF, paste it into the box and click <strong>Use this text</strong>.',
      'Click <strong>Map as item →</strong> on the raw line you want to turn into a row.',
      'Click <strong>Pick</strong> under <strong>Item Name</strong>, then click the word(s) in the line that make up the item\'s name (click again to unselect a word). Repeat for <strong>Qty</strong> and <strong>Rate</strong>, clicking exactly one word each.',
      'Click <strong>Add Row</strong> once all three are filled in — the row is added to the Line Items table above.',
      'If a Vendor is selected, click <strong>Remember this layout for &lt;Vendor&gt;</strong> so future uploads from them are parsed automatically next time.',
    ])}
    ${img('05-po-upload-map-fields.png', 'The Map Fields Manually panel: a raw text line with clickable words assigned to Item Name/Qty/Rate')}

    ${h3('Saving')}
    ${ol([
      'Click <strong>Save Purchase Order</strong> at the bottom of the page.',
      'If something required is missing (no Project, no line items, an invalid row), an error message appears and nothing is saved — fix it and click Save again.',
      'Once saved, the form clears and a confirmation message appears — find it afterwards on <a href="#help-order-status" data-toc-link>Order Status</a>.',
    ])}
    `
  );
}

function renderOrderStatus() {
  return section(
    'help-order-status',
    'Order Status',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Every Purchase Order you've saved, in one list, with its current status.</p>
    ${img('06-order-status.png', 'Order Status listing three purchase orders with different statuses, and filter controls above the table')}

    ${h3('Filtering the list')}
    ${ol([
      'Use <strong>From</strong> / <strong>To</strong> to narrow by order date.',
      'Use <strong>Project</strong> or <strong>Status</strong> to narrow further.',
      'Tick <strong>Show archived</strong> to include POs you\'ve deleted (see below).',
    ])}

    ${h3('Understanding the Status column')}
    <p style="font-size:14px;color:var(--color-neutral-300);margin:0">Status is calculated automatically from what's actually been received and inspected — you never set it by hand. <strong>To Be Received</strong> → nothing has arrived yet. <strong>Partially Received</strong> → some, but not all, of the ordered quantity has arrived. <strong>Material Received</strong> → everything has arrived but hasn't all been inspected yet. <strong>Received &amp; Inspected</strong> → fully received and inspected, with at least some quantity accepted. <strong>Rejected</strong> → fully received and inspected, with nothing accepted at all.</p>

    ${h3('Exporting and archiving')}
    ${ol([
      'Click <strong>Export CSV</strong> to download the filtered list as a spreadsheet.',
      'Click <strong>Delete</strong> on a row to archive that PO (a confirmation pop-up appears first) — this doesn\'t erase it, it just hides it from the list unless "Show archived" is ticked.',
    ])}
    `
  );
}

function renderMaterialInward() {
  return section(
    'help-material-inward',
    'Material Inward',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Log what physically arrived against a Purchase Order — a delivery can be partial, and you can log as many deliveries against one PO as needed until everything ordered has arrived.</p>

    ${h3('Logging a receipt')}
    ${ol([
      'Click the <strong>Purchase Order</strong> dropdown and select the PO the delivery is against (only POs that still have something pending show up here).',
      'Set the <strong>Received Date</strong> if it wasn\'t today.',
      'For each item in the Line Items table, type how much arrived in this delivery into <strong>Receiving Now</strong> — you can see what was <strong>Ordered</strong>, already <strong>Received</strong>, and still <strong>Pending</strong> for each. You can\'t enter more than what\'s pending.',
      'Add a note under <strong>Notes</strong> if useful (e.g. which truck, any damage seen).',
      'Click <strong>Log Receipt</strong>. The Inward History table below the form fills in with what you just logged.',
    ])}
    ${img('07-material-inward.png', 'Material Inward with a PO selected, one line item fully received and another being entered, plus the Inward History below')}
    ${note('Once an item is fully received, it moves on to <a href="#help-inspection" data-toc-link>Inspection</a> before it counts as usable stock.')}
    `
  );
}

function renderInspection() {
  return section(
    'help-inspection',
    'Inspection',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Every receipt logged in Material Inward waits here until it's inspected — accepted, rejected, or split between the two.</p>

    ${h3('Inspecting a receipt')}
    ${ol([
      'Find the row for the item you\'re inspecting and click <strong>Inspect</strong>.',
      'Type how many units to <strong>Accepted Qty</strong> and how many to <strong>Rejected Qty</strong> — together they must add up to exactly the Received Qty shown for that row.',
      'If you\'re rejecting any quantity, fill in <strong>Rejection Reason</strong> — it\'s required whenever Rejected Qty is more than zero.',
      'Click <strong>Save Inspection</strong>. The row disappears from this list (it\'s done) and the accepted quantity becomes usable stock, visible on <a href="#help-inventory" data-toc-link>Inventory</a>.',
    ])}
    ${img('08-inspection.png', 'A row opened for inspection, with Accepted Qty, Rejected Qty, and Rejection Reason filled in')}
    ${note('Click Cancel (same button, now relabeled) to close the form again without saving.')}
    `
  );
}

function renderMasterMaterialStatus() {
  return section(
    'help-master-material-status',
    'Master Material Status',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">A company-wide, read-only view of every PO line item's full receiving/inspection story in one row — Ordered, Received, Accepted, Rejected, and Pending quantities, plus that PO's overall status.</p>
    ${img('09-master-material-status.png', 'Master Material Status listing line items with their Ordered/Received/Accepted/Rejected/Pending quantities')}
    ${ol([
      'Use <strong>Project</strong> or <strong>Status</strong> to narrow the list.',
      'Click <strong>Export CSV</strong> to download it as a spreadsheet.',
    ])}
    `
  );
}

function renderInventory() {
  return section(
    'help-inventory',
    'Inventory',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Current stock for every item, including what's on hand, what's on hold for a Work Order, and what's actually free to use.</p>

    ${h3('Reading the table')}
    <p style="font-size:14px;color:var(--color-neutral-300);margin:0 0 8px"><strong>Current Stock</strong> is everything physically in the warehouse. <strong>Reserved</strong> is stock a Work Order is holding (see <a href="#help-work-orders" data-toc-link>Work Orders</a>). <strong>Available</strong> is Current minus Reserved — the amount you can actually use right now. A red <strong>Below reorder</strong> tag appears when Available drops under an item's Reorder Level.</p>
    ${ol([
      'Type in the <strong>Name</strong> box or pick a <strong>Category</strong> to narrow the list.',
      'Tick <strong>Below reorder level only</strong> to see just the items that need restocking.',
      'Click <strong>Ledger</strong> on any row to see every stock movement (in/out) recorded for that item.',
    ])}
    ${img('10-inventory.png', "An item's movement ledger expanded, with a manual stock-out movement being logged (Store/Admin only)")}

    ${h3('Logging a manual stock movement (Store/Admin only)')}
    ${ol([
      'Expand a row\'s <strong>Ledger</strong> as above.',
      'Choose <strong>In</strong> or <strong>Out</strong>, type the <strong>Quantity</strong>, and optionally a note explaining why (e.g. a correction, an opening balance, material issued to a job).',
      'Click <strong>Log Movement</strong>. Most stock actually moves automatically instead (an accepted inspection creates an "In" movement, recording BoM production creates "Out" movements) — use this only for corrections or cases nothing else covers.',
    ])}

    ${h3('Adding a new item')}
    ${ol([
      'Click <strong>+ New Item</strong> (Store/Admin only).',
      'Fill in <strong>Name</strong> (required), and optionally <strong>Category</strong>, <strong>Unit of Measure</strong>, and <strong>Reorder Level</strong> (the point below which it should show as "Below reorder").',
      'Click <strong>Add Item</strong>.',
    ])}
    ${img('11-inventory-new-item.png', 'The New Item form with Name, Category, and Reorder Level filled in')}
    `
  );
}

function renderBomBuilder() {
  return section(
    'help-bom-builder',
    'BoM Builder',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">A Bill of Materials (recipe) says what components go into producing one batch of an item. Admin/Production only.</p>
    ${img('12-bom-builder.png', 'The BoM Builder list of recipes, each showing what it produces and how many components it has')}

    ${h3('Creating a recipe')}
    ${ol([
      'Click <strong>+ New Recipe</strong>.',
      '<strong>Produces</strong>: pick the item this recipe makes (or click <strong>+ New Item</strong> to create one on the spot).',
      '<strong>Output Qty (per batch)</strong>: how many units one batch of this recipe produces.',
      '<strong>Name</strong>/<strong>Notes</strong> (optional): anything that helps identify this recipe, e.g. a revision number.',
      'Under <strong>Components</strong>, pick an item and a <strong>Qty per batch</strong> for each ingredient. Click <strong>+ Add Component</strong> for another row, or <strong>Remove</strong> to delete one.',
      'Click <strong>Save Recipe</strong>.',
    ])}
    ${img('13-bom-builder-new-recipe.png', 'The New Recipe form with an output item, quantity, and one component filled in')}

    ${h3('Recording production')}
    ${ol([
      'Click <strong>Details</strong> on a recipe to expand it.',
      'Type the <strong>Quantity Produced</strong> and an optional note, then click <strong>Record Production</strong>.',
      'The recipe\'s components are automatically deducted from stock and the output item\'s stock increases — if any component doesn\'t have enough stock, nothing is recorded and you\'ll see exactly which component is short.',
      'Click <strong>Edit</strong> to change a recipe, or <strong>Archive</strong> to retire it (it stops appearing in the active list, but its history is kept).',
    ])}
    ${img('14-bom-builder-detail.png', 'A recipe expanded: its components, the Record Production form, and its production history')}
    `
  );
}

function renderWorkOrders() {
  return section(
    'help-work-orders',
    'Work Orders',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Plan a production run before committing to it: see exactly what a quantity of an item would require — including nested sub-assemblies — netted against what's already in stock, then optionally hold ("reserve") that stock for it.</p>
    ${img('15-work-orders.png', 'The Work Orders list with one reserved and one open work order')}

    ${h3('Creating a Work Order')}
    ${ol([
      'Click <strong>+ New Work Order</strong>.',
      'Pick what to <strong>Produce</strong> and a <strong>Quantity</strong>.',
      'Click <strong>Check Availability</strong> to preview what this would take — the table shows each required item\'s <strong>Reservable</strong> (how much is available right now) and <strong>Shortfall</strong> (how much more you\'d need).',
      'Click <strong>Create Work Order</strong> to save it as <strong>Open</strong> — this doesn\'t hold any stock yet, it\'s just a plan.',
    ])}
    ${img('16-work-orders-preview.png', 'The New Work Order form with an item/quantity selected and the availability preview table shown, including a shortfall')}

    ${h3('Reserving stock')}
    ${ol([
      'Click <strong>Reserve Stock</strong> on an Open work order to actually hold the currently-available stock for it — this reduces <strong>Available</strong> everywhere else (see <a href="#help-inventory" data-toc-link>Inventory</a>) until the work order is cancelled.',
      'Click <strong>Cancel Work Order</strong> at any time to release the hold and mark it Cancelled.',
    ])}
    ${note('Reserving only holds stock — it doesn\'t consume it. Actually producing (and consuming components) happens on <a href="#help-bom-builder" data-toc-link>BoM Builder</a>\'s Record Production, one recipe at a time.')}
    `
  );
}

function renderInvoices() {
  return section(
    'help-invoices',
    'Invoices',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Link a vendor's invoice to one or more Purchase Orders and track when it's due and whether it's been paid. Admin/Accounts (Authorized) only.</p>
    ${img('17-invoices.png', 'The Invoices list with Overdue, Pending, and Paid rows, and filter controls above')}

    ${h3('Creating an invoice')}
    ${ol([
      'Click <strong>+ New Invoice</strong>.',
      'Pick the <strong>Vendor</strong> — <strong>Payment Terms</strong> auto-fills from that vendor\'s usual terms, and <strong>Due Date</strong> auto-computes from Invoice Date + Payment Terms (both stay editable).',
      'Fill in the <strong>Invoice Number</strong> (optional), <strong>Amount</strong>, and <strong>Notes</strong> (optional).',
      'Tick any Purchase Order(s) this invoice covers under "Link Purchase Orders" — one invoice can cover several POs.',
      'Click <strong>Save Invoice</strong>.',
    ])}
    ${img('18-invoices-new.png', 'The New Invoice form with a vendor selected, auto-filled payment terms/due date, and a PO checked')}

    ${h3('Marking paid and archiving')}
    ${ol([
      'Click <strong>Mark Paid</strong> on a row once payment is confirmed — its status changes to Paid and it stops counting as Overdue.',
      'Click <strong>Delete</strong> to archive an invoice (doesn\'t erase it — tick "Show archived" in the filters to see archived ones again).',
      'Click <strong>Export CSV</strong> to download the filtered list.',
    ])}
    ${note('Status is automatic: an unpaid invoice past its Due Date shows Overdue; before that, Pending; once Mark Paid is clicked, Paid — and it stays Paid even if the due date has passed.')}
    `
  );
}

function renderReports() {
  return section(
    'help-reports',
    'Reports',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Three read-only, exportable views built from the same live stock/work-order data. Admin/Authorized/Production.</p>
    ${ol([
      '<strong>Stock &amp; Reservations</strong>: every item with stock currently held by a Work Order. Click <strong>Held By</strong> on a row to see exactly which work order(s), and how much each holds.',
      '<strong>Shortages</strong>: every component still short somewhere in an open or reserved Work Order\'s requirements — a to-do list of what still needs procuring or producing.',
      '<strong>Below Reorder</strong>: every item whose available quantity has dropped under its reorder level — the same flag Inventory shows, as a focused list.',
    ])}
    ${img('19-reports-reservations.png', 'The Stock & Reservations tab with a row expanded to show which work order holds it')}
    ${img('20-reports-shortages.png', 'The Shortages tab listing a component short against an open work order')}
    ${img('21-reports-below-reorder.png', 'The Below Reorder tab listing an item under its reorder level')}
    ${note('Click one of the three tab buttons at the top to switch views; Export CSV always exports whichever tab is currently open.')}
    `
  );
}

function renderUsersRoles() {
  return section(
    'help-users-roles',
    'Users & Roles',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Admin-only: manage every user account and their role.</p>
    ${img('22-users-roles.png', 'The Users & Roles table with Role dropdowns, Status tags, and Deactivate/Activate buttons per row')}

    ${h3('Inviting a new user')}
    ${ol([
      'Click <strong>+ Add User</strong>.',
      'Fill in <strong>Name</strong> and <strong>Email</strong>.',
      'Pick a <strong>Role</strong> now, or leave "No role yet" and assign one later from the table.',
      'Click <strong>Send Invite</strong>. They receive an email to set their own password and can then sign in.',
    ])}
    ${img('23-users-roles-add-user.png', 'The Add User dialog with Name, Email, and Role filled in')}

    ${h3('Changing a role or deactivating someone')}
    ${ol([
      'Click the <strong>Role</strong> dropdown next to a user and pick a new one to change it immediately.',
      'Click <strong>Deactivate</strong> to block someone from signing in; click <strong>Activate</strong> to let them back in.',
    ])}
    ${note('You can\'t change your own role or your own status here — that\'s intentional, so nobody can accidentally lock themselves out. Ask another admin if you need your own account changed.')}
    `
  );
}

function renderActionLog() {
  return section(
    'help-action-log',
    'Action Log',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">Admin-only: an automatic, filterable record of every create/update/delete across the whole app — nobody has to remember to log anything, it's captured for you.</p>
    ${ol([
      'Filter by <strong>User</strong>, <strong>Record Type</strong>, <strong>Action</strong> (Created/Updated/Deleted), and a <strong>Date range</strong>.',
      'Click <strong>Details</strong> on a row to expand it and see exactly what changed, side by side — <strong>Before</strong> and <strong>After</strong>. Click <strong>Hide</strong> to collapse it again.',
      'Click <strong>Export CSV</strong> to download the filtered log.',
    ])}
    ${img('24-action-log.png', 'The Action Log with one row expanded to its before/after JSON detail')}
    `
  );
}

function renderBillPayments() {
  return section(
    'help-bill-payments',
    'Bill Payments',
    `
    <p style="font-size:14px;color:var(--color-neutral-300);margin-bottom:10px">A "bill" and an "invoice" are the same record in this app — this screen is a narrower, focused view of your Invoices for attaching the scanned bill document and marking it received once paid. Visible only to the Accounts/Authorized role (not even Admin sees this menu item, though an admin can still mark any invoice paid from <a href="#help-invoices" data-toc-link>Invoices</a>).</p>
    ${img('25-bill-payments.png', 'Bill Payments listing invoices with Attach/View/Remove file actions and a Mark Received button')}

    ${h3('Attaching a scanned bill')}
    ${ol([
      'Click <strong>Attach</strong> (or <strong>Replace</strong>, if one is already attached) on that invoice\'s row.',
      'Choose the scanned bill file (PDF or image) from your computer — it uploads right away.',
      'Click <strong>View</strong> at any time afterwards to open the attached file, or <strong>Remove</strong> to detach it.',
    ])}

    ${h3('Marking a bill received')}
    ${ol([
      'Once payment is confirmed, click <strong>Mark Received</strong> on that row.',
      'This is the exact same action as Invoices\' "Mark Paid" — the status updates everywhere in the app, not just here.',
    ])}
    ${note('To create a new invoice in the first place, or link it to Purchase Orders, use <a href="#help-invoices" data-toc-link>Invoices</a> — this screen only adds the file-attachment step.')}
    `
  );
}

const FAQ = [
  {
    q: 'I can\'t see most of the menu items — what\'s wrong?',
    a: 'Nothing is wrong — the sidebar only ever shows the screens your role is allowed to use (see "What you see depends on your role" under Getting Started). Ask an admin to check your role on the Users &amp; Roles screen.',
  },
  {
    q: 'I forgot my password. How do I reset it?',
    a: 'There isn\'t a self-service "forgot password" link yet. Contact your admin, who can help you regain access.',
  },
  {
    q: 'Why can\'t I change my own role, or deactivate my own account?',
    a: 'That\'s deliberate — it stops an admin from accidentally locking themselves out. Ask a different admin to make the change for you.',
  },
  {
    q: 'The PDF I uploaded didn\'t parse correctly — what do I do?',
    a: 'Every line item on PO Upload is directly editable, so just correct whatever\'s wrong by hand. For a PDF layout the parser doesn\'t recognize at all, use "Map Fields Manually" to build the rows by clicking words instead of retyping everything — see the PO Upload section above.',
  },
  {
    q: 'Why did a Purchase Order\'s status change without me touching it?',
    a: 'PO status isn\'t something anyone sets directly — it\'s recalculated automatically from what\'s actually been logged on Material Inward and Inspection, so it can never fall out of sync with the real receiving/inspection history.',
  },
  {
    q: 'What\'s the difference between "Received" and "Accepted" quantity?',
    a: '"Received" is how much physically arrived (logged on Material Inward). "Accepted" is how much of that passed inspection and became usable stock (logged on Inspection) — the two can differ if some of a delivery was rejected.',
  },
  {
    q: 'An item shows "Below reorder" even though Current Stock looks fine — why?',
    a: 'The reorder flag compares your reorder level against Available stock (Current minus whatever\'s currently reserved by a Work Order), not raw Current Stock — some of what you have on hand may already be held for a planned production run.',
  },
  {
    q: 'What does "Reserved" stock mean, and how do I free it up again?',
    a: 'It\'s stock a Work Order is holding for a planned production run — it\'s not consumed yet, just set aside so nothing else can use it. Cancel the work order (on the Work Orders screen) to release the hold.',
  },
  {
    q: 'A Work Order shows a shortfall — what happens if I create/reserve it anyway?',
    a: 'You can still create the Work Order — it\'s just a plan. But you can only reserve as much as is actually available; a shortfall means there isn\'t enough of that component in stock right now, and it stays open until more comes in (e.g. via a new Purchase Order and inspection).',
  },
  {
    q: 'Can I undo or reverse a recorded BoM production run?',
    a: 'No — there\'s no built-in "undo" for a production run. If you recorded one by mistake, log a correcting manual stock movement on the Inventory screen instead (an "In" to restore what was wrongly consumed, or an "Out" to correct the output item).',
  },
  {
    q: 'Why can I only "archive" a Purchase Order or Invoice, not delete it?',
    a: 'Archiving (soft delete) keeps the historical record intact instead of erasing it — it just hides the row from the normal list. Tick "Show archived" in that screen\'s filters to see it again.',
  },
  {
    q: 'How do I get data out of the app for Excel?',
    a: 'Look for an "Export CSV" button — Order Status, Master Material Status, Invoices, Reports, and Action Log all have one. It downloads a CSV file you can open directly in Excel or Google Sheets.',
  },
  {
    q: 'Can I use this app on my phone?',
    a: 'Yes — every screen adapts to a phone-sized layout, with the sidebar replaced by a scrollable tab bar at the bottom of the screen.',
  },
];

// Never merged into FAQ above — even a passing mention of Bill Payments
// must not appear anywhere in the help content for a non-authorized role
// (see the note on RESTRICTED_SECTION at the top of this file), so this
// item is only spliced in when canSeeBillPayments is true.
const RESTRICTED_FAQ_ITEM = {
  q: 'What\'s the difference between Invoices and Bill Payments?',
  a: 'They\'re the same underlying record — a "bill" is just this app\'s word for an invoice. Bill Payments is a narrower screen, visible only to the Accounts/Authorized role, focused on attaching the scanned bill document and marking it received; creating an invoice and linking it to Purchase Orders always happens on the Invoices screen.',
};

/** @param {boolean} canSeeBillPayments */
function renderFaq(canSeeBillPayments) {
  const faq = canSeeBillPayments ? [...FAQ, RESTRICTED_FAQ_ITEM] : FAQ;
  return section(
    'help-faq',
    'Frequently Asked Questions',
    `
    <div style="display:flex;flex-direction:column;gap:2px">
      ${faq.map(
        (item, i) => `
        <div style="border-bottom:1px solid var(--color-divider);padding:10px 0${i === faq.length - 1 ? ';border-bottom:none' : ''}">
          <button type="button" data-faq-question style="all:unset;display:flex;align-items:center;gap:8px;cursor:pointer;width:100%;font-size:14px;font-weight:500;color:var(--color-text)">
            <span data-faq-caret style="color:var(--color-accent);flex:none">▸</span>
            <span>${escapeHtml(item.q)}</span>
          </button>
          <div data-faq-answer class="hidden" style="padding:8px 0 0 22px;font-size:14px;color:var(--color-neutral-300)">${item.a}</div>
        </div>`
      ).join('')}
    </div>
    `
  );
}

function renderTroubleshooting() {
  return section(
    'help-troubleshooting',
    'Troubleshooting',
    `
    ${h3('"This account is inactive. Contact your admin."')}
    <p style="font-size:14px;color:var(--color-neutral-300)">An admin has deactivated your account. Ask an admin to reactivate you from <a href="#help-users-roles" data-toc-link>Users &amp; Roles</a>.</p>

    ${h3('A screen shows an error instead of my data')}
    <p style="font-size:14px;color:var(--color-neutral-300)">Click the <strong>Retry</strong> button shown with the error. If it keeps failing, check your internet connection, or contact your admin — the underlying service may be temporarily unavailable.</p>

    ${h3('I saved something but it doesn\'t appear in the list')}
    <p style="font-size:14px;color:var(--color-neutral-300)">Check whether a filter on that screen is hiding it — for example, a status or date-range filter can easily exclude something you just created. Clear the filters and look again.</p>

    ${h3('A button is greyed out and won\'t click')}
    <p style="font-size:14px;color:var(--color-neutral-300)">Most save/action buttons disable themselves briefly while they're saving (they usually relabel to "Saving…" or similar) — wait a moment. If a required field is empty or invalid, some forms also keep the button enabled but show an error message when you click it; read the message for what to fix.</p>
    `
  );
}
