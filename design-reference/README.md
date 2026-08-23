# Design reference — pending

The build brief points at a Claude Design mockup covering all 14 modules
(Dashboard, PO Upload, Order Status, Material Inward, Inspection, Master
Material Status, Inventory, BoM Builder, Work Orders, Invoices, Reports,
Users & Roles, Action Log, and the restricted Bill Payments module) as the
visual and layout source of truth for this app.

That mockup was not accessible when Phase 0 was built (the shared
claude.ai/design link isn't reachable from this environment, and no
exported screens were attached yet) — see the open items in the top-level
`README.md`. Phase 0's sidebar labels, spacing, and component styling
instead reuse the Task_Management (WorkSync) app's own "Nocturne" design
system verbatim (`src/styles/nocturne.css`, ported unchanged), as a
placeholder.

**Once the mockup is available**, drop its exported screens (or a `.dc.html`
export, same convention as `Task_Management/design-reference/Task
Tracker.dc.html`) in this folder, and the sidebar, per-module layouts,
table/filter patterns, and status color-coding should be reconciled against
it — likely requiring changes to `src/layout.js`'s `NAV_ITEMS` (icons are
currently missing entirely) and every placeholder screen as its phase
builds out the real UI.
