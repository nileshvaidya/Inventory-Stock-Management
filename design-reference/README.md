# Design reference

The build brief originally pointed at a Claude Design mockup covering all
14 modules as the visual and layout source of truth to build against. That
mockup was never accessible over the course of the build (the shared
claude.ai/design link isn't reachable from this environment, and no
exported screens were ever attached) — every phase built instead against
the Task_Management (WorkSync) app's own "Nocturne" design system, ported
verbatim (`src/styles/nocturne.css`), as a placeholder. That pre-build
mockup is not coming at this point; all 10 phases are already built.

**`screens/`** is a retroactive substitute instead: a design reference
generated *after* the fact, documenting the app's real, already-built UI —
not a pre-build spec, and not the original Claude Design export. It's a
multi-artboard Design Components canvas (`.dc.html` per screen +
`canvas.json`, same format as `Task_Management/design-reference/Task
Tracker.dc.html`) covering Login, Dashboard, Invoices, Work Orders, Action
Log, the restricted Bill Payments screen, Users & Roles, and a mobile
view — built by reading the real tokens and markup directly out of
`src/styles/nocturne.css` and `src/layout.js`/`src/screens/*.js`, not
invented. Published for interactive viewing (pan/zoom, per-artboard PNG/PDF
export) at:

https://claude.ai/code/artifact/7bb4b753-b1dc-4400-ad18-639e1905b851

If this app is ever redesigned against a real mockup later, treat these
files the same way the original placeholder note did: reconcile
`src/layout.js`'s `NAV_ITEMS` (icons are still missing entirely) and each
screen's layout/table/filter/status-color patterns against the new source
of truth.
