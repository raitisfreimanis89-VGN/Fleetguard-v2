# Porting v2 into the live application

The v2 design system is an **upgrade kit for the running app**, not a
replacement for it. Every page under `v2/` is a static mock-up with invented
fleet data and no Supabase, no auth and no write path. The real application is
`index.html` + `js/app.js` + `js/reminders.js`, and it stays the application.
Porting means one thing only: **a render function starts emitting v2 markup
against the same live data it already had.**

Nothing in a port may touch data loading, validation, compliance maths, SMS,
edge functions or the schema. Those are the parts the DOT audit depends on.

---

## 1. Which stylesheets may be loaded into `index.html`

**All of them except one.**

| Sheet | Live app | Why |
|---|---|---|
| `v2-staging-reset.css` | **never** | The only file with global selectors — `*`, `body`. It exists so the standalone `v2/*.html` pages can own their `<body>`. In the live app it would repaint everything from `#10131a` to `#00050d`, break the `.light` theme and reset the box model under `styles.css`. |
| every other `v2-*.css` | safe | Every selector is `.v2-` prefixed or scoped under `.v2-app`; every custom property is `--v2-`. Nothing can collide with `css/styles.css`, which keeps sole ownership of the unprefixed names (`.card`, `.tab`, `.grid`, `.badge`, `.brand`). |

This was not always true. `v2-shell.css` used to carry those four global rules
itself, which quarantined the entire shell layer — 60 selectors, the whole
sidebar/topbar/nav/page-header — behind 4 lines. They now live in
`v2-staging-reset.css` and their scoped equivalents (`.v2-app *`,
`.v2-app [hidden]`, `.v2-app a`, and the ground/type on `.v2-app` itself) stay
in the shell, so the shell is adoptable.

**Verify before adding any new sheet to the kit** — this must print `0`:

```bash
node v2/tools/check-isolation.js
```

## 2. The two integration modes

**`.v2-region` — a page ported inside production's existing shell.** What the
three shipped ports do. The render function returns v2 markup wrapped in
`.v2-region`, which `v2-bridge.css` gives the v2 ground and the anchor reset,
because production's sidebar and topbar are still the ones on screen. This is
the incremental mode: one page at a time, no chrome change, nothing else on the
site affected.

**`.v2-app` — the live app adopts the v2 shell.** Not done yet, and now
possible. `v2-shell.css` can be linked into `index.html` today with zero effect
(proved: 119 elements, 23 computed properties each, 0 changed — production
emits no `.v2-app` element, so every rule is inert until the markup exists).
Adopting it means rewriting the `#sidebar` / `#topbar` markup in `index.html`
to v2 classes and re-binding `navigate()`, `toggleNav()`, `closeNav()` and
`toggleTheme()`. It is a separate, deliberate step — do not stumble into it.

Once mode 2 lands, `.v2-region` in `v2-bridge.css` retires: `.v2-app` supplies
the ground and the anchor reset for everything inside it.

## 3. The contract a port must not break

Presentation changes. Everything the rest of the app reaches for stays.

- **Element ids are API.** Other functions do `getElementById`. `renderVehicles`
  keeps `v-truck`, `v-trailer`, `v-driver`, `v-dispatcher`, `v-annual`,
  `vcard-<id>`, `vview-<id>`, `vedit-<id>`, `ve-*-<id>`; `renderInspections`
  keeps `sl-vehicle`, `pti-bulk-btn`, `pti-queue-status`. Rename one and the
  feature dies silently — no error, just a button that does nothing.
- **Delegated hooks are API.** `render()` binds `.mark-repaired-btn` by
  `querySelectorAll` after every render and reads `dataset.insp`. The class and
  the `data-insp` attribute are both load-bearing.
- **Inline handlers stay inline.** `onclick="doSendLinkFromPicker()"`,
  `onclick="openInspection('<id>')"`. Converting them to listeners is a
  behaviour change dressed as a cleanup.
- **Deferred calls stay.** `setTimeout(loadPtiQueueStatus, 50)` inside the
  admin branch of `renderInspections`.
- **Role gates stay where they are.** `isAdmin()` wraps the send console and
  the repair button. A v2 layout must not hoist a control out of its gate.
- **`renderDrivers` additionally**: the phone column is admin-gated, backed by
  the `driver_phones` RLS policy and an E.164 `CHECK` constraint. Presentation
  only — do not touch the query or the format.

## 4. Verifying a port changed nothing but pixels

```bash
node v2/tools/verify-logic-untouched.js        # byte-compares every named function against main
```

It extracts each named function from `main:js/app.js` and from the working tree
and byte-compares them, grouped so a failure names the capability at risk. The
three shipped ports return **41 of 41 byte-identical, unexpected changes:
NONE** — PTI/SMS sending, the defect repair flow, driver portal submissions,
the compliance engine, all 10 database writes, auth/load/routing, and the six
render functions not yet ported. `js/reminders.js`, the 11 edge functions and
`gvoice-sms-service/` are untouched by a port and so are out of its scope.

Re-run it after every port; it exits non-zero on any unexpected change. A diff
in anything other than the render function you are porting means the port went
too far.

## 5. State

| Page | Render function | Status |
|---|---|---|
| Dashboard | `renderDashboard` | ported |
| Vehicles | `renderVehicles` | ported |
| Inspections | `renderInspections` | ported |
| Drivers | `renderDrivers` | v2 design exists — not ported |
| Calendar | `renderCalendar` | v2 design exists — not ported |
| Reports | `renderReports` | v2 design exists — not ported |
| Dispatch Board | `renderDispatcherBoard` | v2 design exists — not ported |
| Reminders | `renderReminders` (`js/reminders.js`) | v2 design exists — not ported |
| Vehicle detail | `renderVehicleDetail` | **no v2 design** |
| Driver portal | `renderPortal` | **no v2 design** |
| Users | `renderUsers` / `renderUsersAsync` | **no v2 design** |
| Inspection modal | `renderInspectionModal` | **no v2 design** |

Add the page's component sheet to the `<link>` block in `index.html` as its
port lands; that block is ordered after `css/styles.css` so the `--v2-*` tokens
resolve.

**Open item:** the standalone `v2/*.html` pages are published and serve invented
fleet data to anyone who finds them. Retire them once the pages they mock have
been ported.
