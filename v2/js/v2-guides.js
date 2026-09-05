/* ==========================================================================
   FleetGuard v2 — hero status widgets
   --------------------------------------------------------------------------
   STAGING ONLY. Lifted from the inline <script> at the bottom of production
   guides.html. The data layer is unchanged: same endpoints, same event list,
   same severity ranking, same grouping, same 5-minute refresh, same refusal
   to claim anything it has not actually fetched. Only the DOM targets differ.

   Three deliberate differences from the production copy:

     1. Rows are built with createElement/textContent instead of innerHTML.
        NWS is a government feed, but it is still remote text landing in the
        page, and this file is new code — it may as well be immune rather
        than merely trusted. Matches the esc() discipline applied across the
        production pages, without needing esc().

     2. It is an external file with no inline handlers, so this page needs no
        'unsafe-inline' in a CSP. Production still needs it for its onclick=
        attributes; v2 does not add to that debt.

     3. The tile recolours from live data (see [data-state] in v2-hero.css),
        so a quiet day is green, a failed fetch is grey, and only real alerts
        are amber or red.
   ========================================================================== */

(function () {
  'use strict';

  /* ── 511 wiring point — still deliberately unconnected ──────────────────
     When a real feed exists, call setRoadFeed(text) with data actually
     fetched from it. Until then nothing claims road conditions: a compliance
     page telling a driver a pass is clear, on no evidence, is worse than
     saying nothing at all.

     *** UNITED STATES ONLY. Canadian data is never requested or shown. ***
     This fleet does not run Canada, so every feed added here MUST pass
     through usOnly() below. Two independent guards, because one is not
     enough:
       1. Requests are clamped to the CONUS bounding box, so cross-border
          data is not even asked for.
       2. Results are filtered against an ALLOW-list of US jurisdictions
          built at runtime from the provider's own country field. An
          allow-list, not a deny-list — if a provider adds a new Canadian
          province tomorrow it is excluded by default rather than leaking
          through until someone notices.

     TRAP, do not remove: road511 uses the code "CA" for CALIFORNIA.
     Canada is identified by country:"CA", never by the jurisdiction code.
     Filtering on the bare string "CA" silently drops California — a state
     this fleet very much does run. Filter on country, never on the code.
     "OSM-NA" is excluded too: its country is "NA" (North America), so it
     cannot be guaranteed US-only.                                        */
  var US_BBOX = '-125,24,-66.5,49.4';        // continental US
  var _usCodes = null;                        // allow-list, cached per load

  async function usJurisdictions() {
    if (_usCodes) return _usCodes;
    var r = await fetch('https://map.road511.com/api/v1/jurisdictions');
    var all = await r.json();
    _usCodes = new Set(all.filter(function (j) { return j.country === 'US'; })
                          .map(function (j) { return j.code; }));
    return _usCodes;
  }

  // Every 511 feed result must go through this before it can reach the DOM.
  async function usOnly(items) {
    var ok = await usJurisdictions();
    return (items || []).filter(function (e) {
      var j = e.jurisdiction || e.source;
      return j && ok.has(j);            // unknown jurisdiction => dropped
    });
  }
  window.usOnly = usOnly;
  window.US_BBOX = US_BBOX;

  /* ── NWS active alerts ──────────────────────────────────────────────────
     api.weather.gov is an official US government API: no key, no
     registration, CORS open, and it is not going to disappear. It is US-only
     by definition, so the Canada guard above does not apply to it — and must
     not be bolted on: NWS features carry no .jurisdiction or .source field,
     so routing them through usOnly() would drop every alert and leave the
     tile permanently reading "no alerts". usOnly() is for road511.

     Filtering by EVENT TYPE nationwide rather than by state keeps the
     payload tiny — blizzards and tornadoes are rare, so a quiet day is a
     few KB. Filtering by state would pull every heat advisory in the
     country and cost 100x more for less relevance. */
  var NWS_EVENTS = [
    'Tornado Warning', 'Tornado Watch', 'Blizzard Warning', 'Ice Storm Warning',
    'Winter Storm Warning', 'Winter Storm Watch', 'High Wind Warning',
    'Dust Storm Warning', 'Blowing Dust Advisory', 'Freezing Rain Advisory',
    'Winter Weather Advisory', 'Extreme Cold Warning'
  ];
  var SEV_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

  var tileEl = document.getElementById('v2-wx');
  var valEl  = document.getElementById('v2-wx-value');
  var subEl  = document.getElementById('v2-wx-sub');
  var listEl = document.getElementById('v2-alerts');
  var togEl  = document.getElementById('v2-wx-toggle');
  var footEl = document.getElementById('v2-alerts-foot');
  var stampEl = document.getElementById('v2-sys-updated');

  if (!tileEl) return;                   // shell-only page: nothing to drive

  var expanded = false, groups = [], lastOk = null;

  function iconFor(ev) {
    if (/Tornado/i.test(ev)) return '🌪️';
    if (/Wind|Dust/i.test(ev)) return '💨';
    return '❄️';
  }

  // Zone ids look like .../zones/forecast/WYZ278 or .../county/KSC009
  function statesOf(p) {
    var out = {};
    (p.affectedZones || []).forEach(function (z) {
      var m = z.match(/\/([A-Z]{2})[ZC]\d+$/);
      if (m) out[m[1]] = 1;
    });
    return Object.keys(out);
  }

  function fmtEnd(iso) {
    if (!iso) return '';
    var d = new Date(iso), now = new Date();
    if (isNaN(d)) return '';
    var sameDay = d.toDateString() === now.toDateString();
    var t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return 'until ' + (sameDay ? t : d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + t);
  }

  function span(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function renderAlerts() {
    listEl.textContent = '';
    if (!groups.length) { listEl.hidden = true; footEl.hidden = true; return; }

    var show = expanded ? groups : groups.slice(0, 3);
    show.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'v2-alert-row'
        + (g.sev === 'Extreme' ? ' is-extreme' : (g.sev === 'Severe' ? ' is-severe' : ''));
      row.appendChild(span('v2-alert-ic', iconFor(g.event)));
      row.appendChild(span('v2-alert-ev', g.event));
      row.appendChild(span('v2-alert-n', String(g.n)));
      row.appendChild(span('v2-alert-st', g.states.join(' ') || '—'));
      row.appendChild(span('v2-alert-when', fmtEnd(g.ends)));
      listEl.appendChild(row);
    });

    listEl.hidden = false;
    footEl.hidden = false;
    togEl.hidden = groups.length <= 3;
    togEl.textContent = expanded ? 'Show less' : ('Show all ' + groups.length);
  }

  function setTile(state, value, sub) {
    tileEl.setAttribute('data-state', state);
    valEl.textContent = value;
    subEl.textContent = sub;
  }

  function stamp() {
    if (!stampEl) return;
    if (!lastOk) { stampEl.textContent = 'Awaiting first check'; return; }
    var s = Math.round((Date.now() - lastOk) / 1000);
    stampEl.textContent = 'Last checked: '
      + (s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago');
  }

  async function loadAlerts() {
    try {
      var url = 'https://api.weather.gov/alerts/active?status=actual&event='
              + NWS_EVENTS.map(encodeURIComponent).join(',');
      var r = await fetch(url, { headers: { 'Accept': 'application/geo+json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      var feats = j.features || [];

      var by = {};
      feats.forEach(function (f) {
        var p = f.properties, k = p.event;
        if (!by[k]) by[k] = { event: k, n: 0, states: {}, sev: 'Unknown', ends: null };
        var g = by[k];
        g.n++;
        statesOf(p).forEach(function (s) { g.states[s] = 1; });
        if ((SEV_RANK[p.severity] ?? 4) < (SEV_RANK[g.sev] ?? 4)) g.sev = p.severity;
        if (p.ends && (!g.ends || new Date(p.ends) < new Date(g.ends))) g.ends = p.ends;
      });
      groups = Object.keys(by).map(function (k) {
        by[k].states = Object.keys(by[k].states).sort();
        return by[k];
      }).sort(function (a, b) {
        return (SEV_RANK[a.sev] ?? 4) - (SEV_RANK[b.sev] ?? 4) || b.n - a.n;
      });

      lastOk = Date.now();
      stamp();

      if (!feats.length) {
        setTile('calm', 'No active alerts', 'National Weather Service reports no severe weather nationwide.');
        renderAlerts();
        return;
      }

      var states = {};
      groups.forEach(function (g) { g.states.forEach(function (s) { states[s] = 1; }); });
      var nStates = Object.keys(states).length;

      setTile(
        groups[0].sev === 'Extreme' ? 'extreme' : 'alert',
        feats.length + ' Active ' + (feats.length === 1 ? 'Alert' : 'Alerts'),
        'Severe weather in ' + nStates + ' ' + (nStates === 1 ? 'state' : 'states') + '.'
      );
      renderAlerts();
    } catch (e) {
      // Stay honest: never imply conditions were checked when they were not.
      groups = [];
      renderAlerts();
      setTile('offline', 'Conditions unavailable',
        'Could not reach the National Weather Service — open the 511 map for conditions.');
    }
  }

  togEl.addEventListener('click', function () {
    expanded = !expanded;
    renderAlerts();
  });

  loadAlerts();
  setInterval(loadAlerts, 5 * 60 * 1000);   // refresh every 5 minutes
  setInterval(stamp, 30 * 1000);            // keep the "last checked" honest
})();


/* ==========================================================================
   Category filter, search and sort
   --------------------------------------------------------------------------
   Separate IIFE on purpose: the block above returns early on a page with no
   weather tile, and the filter must not be taken down with it.

   Filtering matches production's behaviour — same data-title keyword strings,
   same "hide a section header once nothing under it survives" rule — but
   toggles el.hidden instead of writing style.display, which is why
   v2-shell.css carries [hidden]{display:none!important}. Without that rule
   the display:flex on these components would win and nothing would hide.
   ========================================================================== */

(function () {
  'use strict';

  /* Scoped to #v2-sections because the tabs themselves also carry data-cat.
     Matching on the attribute rather than a component class means the big
     art-backed cards (.v2-tool-card) and the compact list rows (.v2-row)
     filter, count and sort through exactly the same code. */
  var cards   = [].slice.call(document.querySelectorAll('#v2-sections [data-cat]'));
  var secs    = [].slice.call(document.querySelectorAll('.v2-section'));
  var tabs    = [].slice.call(document.querySelectorAll('.v2-tab'));
  var q       = document.getElementById('v2-q');
  var sortSel = document.getElementById('v2-sort');
  var empty   = document.getElementById('v2-empty');
  var emptyMsg = document.getElementById('v2-empty-msg');
  var resetEl = document.getElementById('v2-reset');
  var placeholder = document.getElementById('v2-placeholder');

  if (!tabs.length || !cards.length) return;

  var cat = 'all', term = '';

  /* Counts come from the DOM, never from the markup. A category with no cards
     yet is disabled rather than hidden, so the finished shape stays visible
     during review and lights up on its own when its section is added. */
  function countFor(c) {
    return c === 'all'
      ? cards.length
      : cards.filter(function (x) { return x.dataset.cat === c; }).length;
  }
  tabs.forEach(function (t) {
    var n = countFor(t.dataset.cat);
    t.querySelector('.v2-tab-n').textContent = n;
    if (n === 0 && t.dataset.cat !== 'all') {
      t.disabled = true;
      t.title = 'No resources in this category yet';
    }
  });

  // A card titles with <h3>; a row titles with .v2-row-title.
  function titleOf(c) {
    var h = c.querySelector('h3, .v2-row-title');
    return h ? h.textContent.trim() : '';
  }

  function hay(c) {
    return ((c.dataset.title || '') + ' ' + titleOf(c)).toLowerCase();
  }

  function apply() {
    var shown = 0;
    cards.forEach(function (c) {
      var okCat  = (cat === 'all' || c.dataset.cat === cat);
      var okTerm = !term || hay(c).indexOf(term) > -1;
      var show   = okCat && okTerm;
      c.hidden = !show;
      if (show) shown++;
    });

    // Drop a section header once nothing under it survives the filter.
    secs.forEach(function (s) {
      var any = [].slice.call(s.querySelectorAll('[data-cat]'))
                  .some(function (c) { return !c.hidden; });
      s.hidden = !any;
    });

    empty.hidden = shown > 0;
    if (!shown) {
      emptyMsg.textContent = term
        ? 'Nothing matches “' + term + '”.'
        : 'Nothing in this category yet.';
    }

    // The build-progress note is only meaningful on the unfiltered view.
    if (placeholder) placeholder.hidden = (cat !== 'all' || !!term);
  }

  /* Sorts within each section rather than across all of them — the sections
     are the grouping, so flattening them would throw away the category
     structure the tabs above depend on. */
  function applySort() {
    var mode = sortSel ? sortSel.value : 'default';
    secs.forEach(function (s) {
      var grid = s.querySelector('.v2-tool-grid, .v2-row-grid');
      if (!grid) return;
      var items = [].slice.call(grid.querySelectorAll('[data-cat]'));
      if (mode === 'default') {
        items.forEach(function (c) { c.style.order = ''; });
        return;
      }
      items.slice().sort(function (a, b) {
        var an = titleOf(a).toLowerCase();
        var bn = titleOf(b).toLowerCase();
        return mode === 'az' ? an.localeCompare(bn) : bn.localeCompare(an);
      }).forEach(function (c, i) { c.style.order = i; });
    });
  }

  function selectTab(t) {
    if (!t || t.disabled) return;
    tabs.forEach(function (x) {
      var on = x === t;
      x.classList.toggle('is-active', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    cat = t.dataset.cat;
    apply();
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { selectTab(t); });
  });

  // "View All Tools" / "View All Maps" select that category rather than
  // jumping to an anchor that is already on screen.
  [].slice.call(document.querySelectorAll('.v2-section-link')).forEach(function (a) {
    a.addEventListener('click', function (e) {
      var sec = a.closest('.v2-section');
      var want = sec && sec.dataset.section;
      var tab = tabs.filter(function (t) { return t.dataset.cat === want; })[0];
      if (tab && !tab.disabled) {
        e.preventDefault();
        selectTab(tab);
      }
    });
  });

  if (q) {
    q.addEventListener('input', function () {
      term = q.value.trim().toLowerCase();
      apply();
    });
  }

  if (resetEl) {
    resetEl.addEventListener('click', function () {
      if (q) q.value = '';
      term = '';
      selectTab(tabs[0]);
      if (q) q.focus();
    });
  }

  if (sortSel) sortSel.addEventListener('change', applySort);

  // ⌘K / Ctrl-K matches the hint rendered in the search box; "/" and Escape
  // match what production already trained people on.
  window.addEventListener('keydown', function (e) {
    if (!q) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); q.focus(); q.select(); return;
    }
    if (e.key === '/' && document.activeElement !== q) {
      e.preventDefault(); q.focus(); return;
    }
    if (e.key === 'Escape' && document.activeElement === q) {
      q.value = ''; term = ''; apply(); q.blur();
    }
  });

  apply();
  applySort();
})();
