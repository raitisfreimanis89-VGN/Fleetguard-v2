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

## 0. Skin first, port second

The upgrade splits into two jobs with wildly different costs, and it is worth
being deliberate about which one a given page actually needs.

**The skin — `v2/css/v2-skin.css`.** `css/styles.css` is already fully
tokenised: `.card` reads `var(--surface-container)`, `.btn-primary` reads
`var(--primary)`, `.badge-green` reads `var(--success)`. Remapping ~30 token
values repaints every one of those rules, on **every page at once**, including
the ones nobody has ported. No JavaScript, no markup, no element ids, no
handlers — therefore none of the contract risk that section 3 exists to
manage. Measured across eight views: **0 new contrast failures, 4 pre-existing
ones fixed.**

**The port — a render function rewritten to emit v2 markup.** This is the only
way to get the things tokens cannot express: the Dashboard's stat tiles, the
Inspections defect cards, the Drivers status column, the fleet grid. It costs
a per-page rewrite and carries every risk in sections 3 and 4.

Do the skin once, then port only where the new *structure* earns it. A page
whose layout is already fine gets most of the visual upgrade from the skin
alone, and porting it spends real risk for very little.

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
ten shipped ports do. The render function returns v2 markup wrapped in
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

This list is enforced, not just documented — `check-contracts.js` in section 4
fails the build on any of it. Read it anyway, because knowing *why* a hook is
load-bearing is what stops you writing a port that satisfies the checker and
still breaks.

- **Element ids are API.** Other functions do `getElementById`. `renderVehicles`
  keeps `v-truck`, `v-trailer`, `v-driver`, `v-dispatcher`, `v-annual`,
  `vcard-<id>`, `vview-<id>`, `vedit-<id>`, `ve-*-<id>`; `renderInspections`
  keeps `sl-vehicle`, `pti-bulk-btn`, `pti-queue-status`. Rename one and the
  feature dies silently — no error, just a button that does nothing. The guard
  in `loadPtiQueueStatus()` is the shape to keep in mind:

  ```js
  const el = document.getElementById('pti-queue-status');
  if (!el || !sb || !isAdmin()) return;        // typo the id and this is a no-op
  ```
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
- **Toggled elements must keep their display type.** `startEditDriver` sets
  `driver-edit-<id>` to `display:flex` and `cancelEditDriver` sets
  `driver-view-<id>` and `driver-btns-<id>` back to `flex`; `startEditVehicle`
  uses `block` for `vview-<id>`. The handler hardcodes the value, so a v2 class
  that lays the element out as a grid will be overridden into flex the first
  time someone clicks Edit, and the layout will break only in that state.
  `.v2-drv` and `.v2-actions` are both `display:flex`, which is why the Drivers
  port could use them directly.
- **A v2 mockup may show data the live page does not have — check before you
  build it.** The v2 Drivers design has a Cell column that the live page had no
  data for: `loadAll()` never fetched `driver_phones`. It was left out of the
  first port for that reason, then added deliberately as a feature (see section
  7), which required a new query rather than new markup. The general rule holds:
  a control the data cannot feed is worse than no control, because it renders
  and silently does nothing.

## 4. Verifying a port changed nothing but pixels

Three checks, all exit non-zero on failure. Run them after every port.

```bash
node v2/tools/check-isolation.js           # no v2 sheet can leak into the live app
node v2/tools/verify-logic-untouched.js    # no logic moved while markup moved
node v2/tools/check-contracts.js           # no DOM hook was dropped
```

**`verify-logic-untouched.js`** extracts each named function from
`main:js/app.js` and from the working tree and byte-compares them, grouped so a
failure names the capability at risk. The four shipped ports return **40 of 40
byte-identical, unexpected changes: NONE** — PTI/SMS sending, the defect repair
flow, driver portal submissions, the compliance engine, all 10 database writes,
auth/load/routing, and the five render functions not yet ported.
`js/reminders.js`, the 11 edge functions and `gvoice-sms-service/` are untouched
by a port and so are out of its scope.

**`check-contracts.js`** is the one that catches the silent failures. A port is
*supposed* to rewrite markup, so a diff tells you nothing; this extracts the
contract surface — ids, `data-*` attributes, inline handlers, and the classes
the codebase actually queries — from the baseline and from the port, and reports
what the baseline emitted and the port no longer does. Styling classes are
ignored, because `.btn` becoming `.v2-btn-send` is the work; `.mark-repaired-btn`
is not, because `render()` binds it by `querySelectorAll`. The four shipped
ports keep **43 of 43 contracts, dropped: NONE**.

It also resolves every literal `getElementById` in the codebase against the
markup something actually emits. Five currently do not resolve; `login-db-setup`
is a documented guard for a removed element (`js/app.js:71`) and the other four
belong to two orphaned functions covered by a separate cleanup — see section 6.

Verify the checkers themselves after changing them. Both have been confirmed to
fail on injected faults: `check-isolation.js` on a `body` rule, an `a` rule, a
`.light .card` rule and an `h1` nested inside `@media`; `check-contracts.js` on
a typo'd id, a dropped delegated class and an emptied inline handler.

A diff in anything other than the render function you are porting means the port
went too far.

**None of this replaces logging in.** These checks prove a port did not change
behaviour; they cannot prove the behaviour was right to begin with, and they
never see real data. Empty states, long names, null `assignedDriverId`, and the
dispatcher-versus-admin split still need a human with a session.

## 5. State

| Page | Render function | Status |
|---|---|---|
| Dashboard | `renderDashboard` | ported |
| Vehicles | `renderVehicles` | ported |
| Inspections | `renderInspections` | ported |
| Drivers | `renderDrivers` | ported |
| Calendar | `renderCalendar` | ported |
| Reports | `renderReports` | ported |
| Dispatch Board | `renderDispatcherBoard` | ported |
| Reminders | `renderReminders` (`js/reminders.js`) | ported, all four tabs |
| Vehicle detail | `renderVehicleDetail` | ported (no v2 mock-up; mapped onto existing components) |
| Driver portal | `renderPortal` | **no v2 design** |
| Users | `renderUsers` / `renderUsersAsync` | **no v2 design** |
| Inspection modal | `renderInspectionModal` | **no v2 design** |

Add the page's component sheet to the `<link>` block in `index.html` as its
port lands; that block is ordered after `css/styles.css` so the `--v2-*` tokens
resolve.

## 6. Open items

- **Light mode: done.** `v2-tokens.css` carries a `.light` block, and the
  sweep now measures 0 AA failures across the sidebar and all nine ported pages
  in *both* themes. Four things had to be understood, and only the first was
  the palette:

  1. **The accent ramp reverses roles.** Each hue does double duty — text on a
     light ground, and a solid fill under white text. Text on the darkest light
     ground (`--v2-surface-3`, #e4e6ed) is the tighter constraint, so every
     base hue is the lightest tone on its ramp that clears 4.5:1 there, and the
     fill duty comes free. Consequence: light-mode amber reads brown and green
     reads forest. That is arithmetic, not taste. An earlier draft kept the
     hues bright on the theory that they "fill dots and bars rather than
     carrying text"; the sweep found sixteen `color: var(--tc)` rules and
     falsified it.

  2. **Depth effects were hardcoded, so no token remap could reach them.**
     Five scrims were literal `rgba(0, 5, 13, α)` and four raised grounds were
     literal `rgba(255, 255, 255, α)`. In light mode the first painted a
     near-black veil over white cards (1.09:1 on the Guides tags) and the
     second painted white on white, deleting the hover affordance. Both now go
     through `--v2-well-*` / `--v2-lift-*`, split into a channel triplet and a
     multiplier so the alpha stays at the call site and a row at .45 keeps its
     relative step over its hover at .7 in either theme. The three
     `inset 0 1px 0 rgba(255,255,255,.0x)` sheens are left alone on purpose:
     vanishing on white is correct for a top-edge highlight.

  3. **Two subtrees must keep the dark palette, and `:root` hands it to them
     with no duplicated values.** `v2-tokens.css` opens
     `:root, .light .v2-sidebar, .light .v2-tool-card {`, which outranks the
     `.light` block at (0,2,0) inside those subtrees only. The sidebar,
     because production keeps a dark rail in light mode too (its own
     `--sidebar-bg` stays #1a1f2e); the Guides tool cards, because their
     substrate is a photograph and a photograph does not change with the theme.

  4. **The force-dark rule is gone in effect.** `.light .v2-region` survives in
     `v2-bridge.css` but now resolves to the light ground; see the comment
     there.

- **How the Guides card question was actually settled.** Text on those cards
  sits over artwork, and two measurement approaches disagreed for a long time.
  A CSS-layer sweep says the cards pass — it composites the card gradient and
  never sees the photograph. A canvas that redrew the photo, its filter and
  both scrim gradients said everything failed at 1.00:1 — but it failed its own
  validation on three of six cards, so its numbers meant nothing either. What
  settled it was measuring the *veil alpha* under each text run, by multiplying
  the transmittances of the two scrim layers: titles sit at 0.10–0.42 and body
  copy at 0.22–0.75, so the photograph is genuinely visible behind the text on
  every card. That calculation is trustworthy where the pixel model was not,
  because it needs no image, no filter and no layer order — the product of
  transmittances is the same whichever way round the layers stack. The fix
  follows from the finding: hand those cards the dark palette rather than tune
  nine scrim variables per card and bury the artwork.

- **Two contrast bugs the light theme exposed rather than caused.** Both were
  already wrong in dark mode. `.v2-region a` in `v2-bridge.css` scored (0,1,1)
  and so outranked `.v2-btn` at (0,1,0), meaning every Guides card button
  inherited the card's body ink instead of its on-accent ink — 2.26:1 in dark,
  1.62:1 in light. It is now `:where(.v2-region a)` at zero specificity, which
  is safe because no app sheet declares an anchor rule at all. And the
  dispatcher board's unknown-dispatcher avatar was emitting an inline
  `style="background:var(--v2-surface-3)"` instead of the `.is-none` class that
  exists for it, so it kept `--v2-ink-on-accent` and rendered white-on-white.

- **A note on measuring the sidebar.** The first sidebar sweep reported the
  user avatar at 1.04:1 in dark mode. That was a false positive: the simplified
  stack walker used for it did not read gradients, and the avatar is
  gradient-filled — exactly the trap the comment beside `.v2-user-avatar` in
  `v2-shell.css` describes. The comment caught it. Any sweep run against this
  app has to be gradient-aware or it will report noise.
- **Verified as admin against the live database, including the write paths.**
  Every ported page renders on real data, and the contracts the checkers can
  only assert statically have now been exercised for real: Mark repaired, Edit
  truck then save, a driver phone edit through RLS, and a schedule change all
  land in the database. That closes the question of whether the element ids,
  the delegated `.mark-repaired-btn` binding and the inline handlers survived
  the ports.
- **The PTI link send works from the ported page, so the SMS bot is intact.**
  This was the highest-stakes contract in the whole exercise and the one whose
  failure would have been silent: `#sl-vehicle`, `doSendLinkFromPicker()`,
  `#pti-bulk-btn`, `#pti-queue-status` and the deferred
  `setTimeout(loadPtiQueueStatus, 50)` all had to survive a full markup
  rewrite, and a typo in any one of them would have produced a button that
  simply did nothing. A link sent from the ported UI reached a real driver.
- **The dispatcher path has still never run for real.** It is a materially
  different app — no add forms, no Cell column, no Reminders, dispatcherNotice
  banners in place of controls — and has only been exercised by overriding
  `isAdmin()` in a console. This is the remaining verification gap before
  merging to `main`.
- **Two reachable pages are still un-ported.** `renderVehicleDetail` is reached
  by clicking any truck row on Vehicles, Reports or the Dispatch drill-down,
  and is where brake tests, service records and DOT inspections are entered;
  `renderInspectionModal` opens from the Pre-Trip table. Neither has a v2
  mock-up, so both need the same treatment the Reminders tabs got: mapped onto
  the existing component vocabulary rather than designed from nothing.
  `renderUsers` and `renderPortal` are NOT in this category — `navigate()`
  refuses both for every role, so they cannot be reached at all.
- **The standalone `v2/*.html` pages are published and serve invented fleet
  data** to anyone who finds the URL. They are reference designs now, not
  products. Retire each one as the real page it mocks is ported, or drop them
  from the deploy in the meantime.
- **Two orphaned functions in `js/app.js`.** `doAddMaintenance` (line 1510) and
  `doAddMileage` (line 1515) have no callers and read ids nothing emits —
  `m-date`, `m-notes`, `mil-driver`, `mil-val`. `doAddMaintenance` was
  superseded by `doAddUnifiedService` directly above it; `doAddMileage` would
  throw on null if it were ever wired up. The database writes they wrap,
  `addMaintenance()` and `addMileage()`, are both live and must stay. Pre-dates
  the port; tracked separately.
- **Pre-existing contrast**: `.nav-item.active` and `.nav-icon` sit at 3.56:1
  in `css/styles.css`.
- **The three newly-visible Guides cards need a contrast pass.** Toll, Traffic
  and States hotlinked Unsplash, so `img-src 'self'` blocked them outright and
  nobody ever saw them in the app. They are local assets now and they render —
  but unlike PTI, Weight & Axle and CAT Scale they have no constrained scrim
  solve: they set only `--art-lift` and inherit the default gradient, which was
  never measured against their photographs. Their titles run to 42-52% of the
  card width, where the horizontal scrim has faded to roughly 0.6-0.76 alpha,
  over images lifted 1.45-1.7x.

  Two independent measurements of these cards disagreed with each other by a
  wide margin on identical inputs, so no ratio is asserted here. What is known:
  the three tuned cards carry recorded solves (PTI worst run 4.84:1, axle
  4.77:1, both in rest and hover) and these three carry none. They need the
  same treatment before this page is called finished.

  Worth knowing while doing it: `.v2-art-scale` has a deliberately TRANSPARENT
  horizontal scrim — all five stops at alpha 0 — because the CAT Scale card is
  framed so a road sign stays unobscured. That is intentional and documented in
  v2-cards.css; do not fix it by copying another card's values.

- **Three Unsplash hotlinks** in `v2-cards.css` (toll, traffic, states) — remote
  dependencies in a page that otherwise ships its own assets.

## 7. Driver cell numbers

Added after the Drivers port, as a feature rather than a port — it needed a new
query, not new markup. Three things about it are worth keeping written down.

**Writes go to the table, never through `broadcast-sms`.** That function has an
`update_phone` action which looks like the obvious API, and it is not usable
from the browser: it authenticates on a shared `GV_SERVICE_SECRET`, so calling
it from front-end JavaScript would mean shipping that secret to every user,
along with the ability to add and delete drivers, blast SMS to the whole fleet
and read every number on file. RLS is the correct door. `phones_insert_admin`
and `phones_update_admin` both require `is_admin()`, so a dispatcher who forges
the call is refused by the database rather than by this code.

**`PHONES_AVAILABLE` is not an authorisation check.** The select policy is
`FOR SELECT TO authenticated USING (is_admin())`, which returns a dispatcher
**zero rows and no error** — so `PHONES_AVAILABLE` is true for them too, just
with an empty map. Gating the column on it alone rendered the Cell column for
dispatchers with "No number" on every row and an Add button their write RLS
would refuse. The gate is `showPhones = isAdmin() && PHONES_AVAILABLE`:
availability answers *did the table respond*, `isAdmin()` answers *may this
person see it*.

**Normalisation mirrors the edge function line for line** — 10 digits assumed
US, 11 leading 1 prefixed, anything else must already start with `+`. A number
typed in the UI and a number typed into the SMS tooling therefore land
identically. The database has the last word regardless:
`CHECK (phone_number ~ '^\+[1-9]\d{7,14}$')` from migration 002 refuses a bad
value even if the client is bypassed.

One footnote for whoever reads migration 002 and worries: it carries
`REVOKE SELECT (phone_number) ... FROM authenticated`, and the comment beside it
implies direct selects will fail. They do not. A column-level `REVOKE` cannot
subtract from a table-level `GRANT` in PostgreSQL, so the table-level grant
Supabase issues still permits the read — which is why `js/reminders.js` has read
this column successfully since migration 002, and why `PHONES_AVAILABLE` comes
back true. RLS is what actually restricts it, and RLS is sufficient. The
`get_driver_phone()` RPC in that migration is therefore unused.
