// ═══════════════════════════════════════════════════════
// DATA LAYER — Supabase + localStorage fallback
// ═══════════════════════════════════════════════════════
let sb = null;
let useSupabase = false;

// Safely get the createClient function regardless of how the CDN exposes it
function getCreateClient() {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    return window.supabase.createClient;
  }
  if (window.supabase && window.supabase.default && typeof window.supabase.default.createClient === 'function') {
    return window.supabase.default.createClient;
  }
  if (typeof createClient === 'function') {
    return createClient;
  }
  return null;
}

function initSupabase() {
  const url = localStorage.getItem('sb_url');
  const key = localStorage.getItem('sb_key');
  if (!url || !key) return;
  const fn = getCreateClient();
  if (!fn) { console.warn('Supabase library not loaded yet'); return; }
  try {
    sb = fn(url, key);
    useSupabase = true;
    updateDbPill(true);
  } catch(e) {
    console.error('Supabase init error:', e);
    useSupabase = false;
  }
}

function updateDbPill(connected) {
  const pill = document.getElementById('db-status-pill');
  if (!pill) return;
  if (connected) {
    pill.className = 'badge badge-green';
    pill.textContent = '✓ Supabase';
  } else {
    pill.className = 'badge badge-yellow';
    pill.textContent = '⚠ Local only';
  }
}

async function connectDb() {
  const urlEl = document.getElementById('sb-url');
  const keyEl = document.getElementById('sb-key');
  const btn = document.getElementById('btn-connect-db');
  if (!urlEl || !keyEl) { showError('Modal elements not found — try refreshing'); return; }

  const url = urlEl.value.trim().replace(/\/$/, '');
  const key = keyEl.value.trim();

  if (!url) { showError('Enter your Supabase project URL (e.g. https://xxxx.supabase.co)'); return; }
  if (!key) { showError('Enter your Supabase anon key'); return; }
  if (!url.startsWith('https://')) { showError('URL must start with https://'); return; }

  btn.innerHTML = '<span class="spinner"></span> Testing...';
  btn.disabled = true;

  try {
    // Test using plain fetch — avoids DataCloneError from Supabase client internals
    const testRes = await fetch(url + '/rest/v1/drivers?select=id&limit=1', {
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key
      }
    });
    if (testRes.status === 404 || testRes.status === 400) {
      const body = await testRes.json().catch(() => ({}));
      const msg = body.message || body.error || '';
      if (msg.toLowerCase().includes('relation') || msg.toLowerCase().includes('not found') || testRes.status === 404) {
        throw new Error('Tables not found. Please run the SQL setup script first: expand "Show SQL setup script" above, copy it, and run it in Supabase → SQL Editor.');
      }
      throw new Error('HTTP ' + testRes.status + ': ' + msg);
    }
    if (testRes.status === 401) throw new Error('Invalid anon key. Check you copied the "anon / public" key, not the service role key.');
    if (!testRes.ok) throw new Error('HTTP ' + testRes.status + ' — check your URL is correct.');

    // Connection good — now create the Supabase client
    const fn = getCreateClient();
    if (!fn) throw new Error('Supabase library not loaded. Refresh the page and try again.');
    const client = fn(url, key);

    localStorage.setItem('sb_url', url);
    localStorage.setItem('sb_key', key);
    sb = client;
    useSupabase = true;
    updateDbPill(true);
    closeDbConfig();
    showToast('Connected to Supabase! Data is now shared.', 'success');
    await loadAll();
    render();
  } catch(e) {
    showError('Connection failed: ' + e.message);
  } finally {
    btn.innerHTML = 'Connect & Test';
    btn.disabled = false;
  }
}

function showError(msg) {
  let el = document.getElementById('db-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'db-error';
    el.style.cssText = 'margin-top:12px; padding:10px 14px; background:#fef2f2; border:1px solid #fca5a5; border-radius:8px; font-size:13px; color:#991b1b; line-height:1.5;';
    const footer = document.querySelector('#db-modal .modal-footer');
    if (footer) footer.parentNode.insertBefore(el, footer);
  }
  el.textContent = msg;
  el.style.display = 'block';
}

function clearDb() {
  localStorage.removeItem('sb_url');
  localStorage.removeItem('sb_key');
  sb = null;
  useSupabase = false;
  updateDbPill(false);
  closeDbConfig();
  showToast('Disconnected — using local storage only', 'warning');
}

function showDbConfig() {
  document.getElementById('sb-url').value = localStorage.getItem('sb_url') || '';
  document.getElementById('sb-key').value = localStorage.getItem('sb_key') || '';
  const errEl = document.getElementById('db-error');
  if (errEl) errEl.style.display = 'none';
  document.getElementById('db-modal').style.display = 'flex';
}
function closeDbConfig() { document.getElementById('db-modal').style.display = 'none'; }

// ── Local Storage helpers ──
const LS = {
  get: (k) => { try { return JSON.parse(localStorage.getItem('fg_'+k) || '[]'); } catch { return []; } },
  set: (k, d) => localStorage.setItem('fg_'+k, JSON.stringify(d)),
  genId: () => crypto.randomUUID()
};

// ── In-memory store (populated on load) ──
let DRIVERS = [], VEHICLES = [], MAINTENANCE = [], BRAKE_TESTS = [], TYRE_RECORDS = [], DOT_INSPECTIONS = [], MILEAGE = [];

async function loadAll() {
  if (useSupabase && sb) {
    const [d,v,m,b,t,dot,mil] = await Promise.all([
      sb.from('drivers').select('*').order('created_at'),
      sb.from('vehicles').select('*').order('created_at'),
      sb.from('maintenance_records').select('*').order('created_at'),
      sb.from('brake_tests').select('*').order('created_at'),
      sb.from('tyre_records').select('*').order('created_at'),
      sb.from('dot_inspections').select('*').order('created_at'),
      sb.from('mileage_records').select('*').order('created_at'),
    ]);
    DRIVERS = d.data || []; VEHICLES = v.data || []; MAINTENANCE = m.data || [];
    BRAKE_TESTS = b.data || []; TYRE_RECORDS = t.data || []; DOT_INSPECTIONS = dot.data || []; MILEAGE = mil.data || [];
    // normalize snake_case from Supabase
    VEHICLES = VEHICLES.map(v => ({...v, truckNumber: v.truck_number, trailerNumber: v.trailer_number, assignedDriverId: v.assigned_driver_id}));
    MAINTENANCE = MAINTENANCE.map(r => ({...r, vehicleId: r.vehicle_id, serviceDate: r.service_date, nextInspectionDate: r.next_inspection_date}));
    BRAKE_TESTS = BRAKE_TESTS.map(r => ({...r, vehicleId: r.vehicle_id, testDate: r.test_date}));
    TYRE_RECORDS = TYRE_RECORDS.map(r => ({...r, vehicleId: r.vehicle_id, photoDate: r.photo_date}));
    DOT_INSPECTIONS = DOT_INSPECTIONS.map(r => ({...r, vehicleId: r.vehicle_id, driverId: r.driver_id, inspectionDate: r.inspection_date}));
    MILEAGE = MILEAGE.map(r => ({...r, vehicleId: r.vehicle_id, driverId: r.driver_id}));
  } else {
    DRIVERS = LS.get('drivers'); VEHICLES = LS.get('vehicles'); MAINTENANCE = LS.get('maintenance');
    BRAKE_TESTS = LS.get('brakes'); TYRE_RECORDS = LS.get('tyres'); DOT_INSPECTIONS = LS.get('dots'); MILEAGE = LS.get('mileage');
  }
}

function saveLocal() {
  LS.set('drivers', DRIVERS); LS.set('vehicles', VEHICLES); LS.set('maintenance', MAINTENANCE);
  LS.set('brakes', BRAKE_TESTS); LS.set('tyres', TYRE_RECORDS); LS.set('dots', DOT_INSPECTIONS); LS.set('mileage', MILEAGE);
}

// ── CRUD helpers ──
async function addDriver(name) {
  const rec = { id: LS.genId(), name, created_at: new Date().toISOString() };
  DRIVERS.push(rec);
  if (useSupabase) await sb.from('drivers').insert({id:rec.id, name, created_at:rec.created_at});
  else saveLocal();
  return rec;
}
async function updateDriver(id, name) {
  DRIVERS = DRIVERS.map(d => d.id === id ? {...d, name} : d);
  if (useSupabase) await sb.from('drivers').update({name}).eq('id', id);
  else saveLocal();
}
async function deleteDriver(id) {
  DRIVERS = DRIVERS.filter(d => d.id !== id);
  DOT_INSPECTIONS = DOT_INSPECTIONS.map(r => r.driverId === id ? {...r, driverId: null} : r);
  MILEAGE = MILEAGE.filter(r => r.driverId !== id);
  if (useSupabase) { await sb.from('drivers').delete().eq('id', id); }
  else saveLocal();
}
async function addVehicle(truckNumber, trailerNumber, assignedDriverId) {
  const rec = { id: LS.genId(), truckNumber, trailerNumber, assignedDriverId: assignedDriverId||null, created_at: new Date().toISOString() };
  VEHICLES.push(rec);
  if (useSupabase) await sb.from('vehicles').insert({id:rec.id, truck_number:truckNumber, trailer_number:trailerNumber, assigned_driver_id:assignedDriverId||null, created_at:rec.created_at});
  else saveLocal();
  return rec;
}
async function deleteVehicle(id) {
  VEHICLES = VEHICLES.filter(v => v.id !== id);
  MAINTENANCE = MAINTENANCE.filter(r => r.vehicleId !== id);
  BRAKE_TESTS = BRAKE_TESTS.filter(r => r.vehicleId !== id);
  TYRE_RECORDS = TYRE_RECORDS.filter(r => r.vehicleId !== id);
  DOT_INSPECTIONS = DOT_INSPECTIONS.filter(r => r.vehicleId !== id);
  MILEAGE = MILEAGE.filter(r => r.vehicleId !== id);
  if (useSupabase) {
    await Promise.all([
      sb.from('vehicles').delete().eq('id', id),
      sb.from('maintenance_records').delete().eq('vehicle_id', id),
      sb.from('brake_tests').delete().eq('vehicle_id', id),
      sb.from('tyre_records').delete().eq('vehicle_id', id),
      sb.from('dot_inspections').delete().eq('vehicle_id', id),
      sb.from('mileage_records').delete().eq('vehicle_id', id),
    ]);
  } else saveLocal();
}
async function addMaintenance(vehicleId, serviceDate, notes) {
  const next = new Date(serviceDate); next.setDate(next.getDate()+60);
  const rec = { id: LS.genId(), vehicleId, serviceDate, nextInspectionDate: next.toISOString().split('T')[0], notes: notes||null };
  MAINTENANCE.push(rec);
  if (useSupabase) await sb.from('maintenance_records').insert({id:rec.id, vehicle_id:vehicleId, service_date:serviceDate, next_inspection_date:rec.nextInspectionDate, notes:notes||null});
  else saveLocal();
}
async function deleteMaintenance(id) {
  MAINTENANCE = MAINTENANCE.filter(r => r.id !== id);
  if (useSupabase) await sb.from('maintenance_records').delete().eq('id', id);
  else saveLocal();
}
async function addBrakeTest(vehicleId, testDate, result, notes) {
  const rec = { id: LS.genId(), vehicleId, testDate, result, notes: notes||null };
  BRAKE_TESTS.push(rec);
  if (useSupabase) await sb.from('brake_tests').insert({id:rec.id, vehicle_id:vehicleId, test_date:testDate, result, notes:notes||null});
  else saveLocal();
}
async function deleteBrakeTest(id) {
  BRAKE_TESTS = BRAKE_TESTS.filter(r => r.id !== id);
  if (useSupabase) await sb.from('brake_tests').delete().eq('id', id);
  else saveLocal();
}
async function addTyreRecord(vehicleId, photoDate, readings) {
  const rec = { id: LS.genId(), vehicleId, photoDate, readings };
  TYRE_RECORDS.push(rec);
  if (useSupabase) await sb.from('tyre_records').insert({id:rec.id, vehicle_id:vehicleId, photo_date:photoDate, readings});
  else saveLocal();
}
async function deleteTyreRecord(id) {
  TYRE_RECORDS = TYRE_RECORDS.filter(r => r.id !== id);
  if (useSupabase) await sb.from('tyre_records').delete().eq('id', id);
  else saveLocal();
}
async function addDOTInspection(vehicleId, driverId, inspectionDate, result, notes) {
  const rec = { id: LS.genId(), vehicleId, driverId: driverId||null, inspectionDate, result, notes: notes||null };
  DOT_INSPECTIONS.push(rec);
  if (useSupabase) await sb.from('dot_inspections').insert({id:rec.id, vehicle_id:vehicleId, driver_id:driverId||null, inspection_date:inspectionDate, result, notes:notes||null});
  else saveLocal();
}
async function deleteDOTInspection(id) {
  DOT_INSPECTIONS = DOT_INSPECTIONS.filter(r => r.id !== id);
  if (useSupabase) await sb.from('dot_inspections').delete().eq('id', id);
  else saveLocal();
}
async function addMileage(vehicleId, driverId, mileage) {
  const rec = { id: LS.genId(), vehicleId, driverId, mileage, date: new Date().toISOString().split('T')[0] };
  MILEAGE.push(rec);
  if (useSupabase) await sb.from('mileage_records').insert({id:rec.id, vehicle_id:vehicleId, driver_id:driverId, mileage, date:rec.date});
  else saveLocal();
}

// ═══════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════
const AXLES = [
  { name: 'Steer Axle', sides: ['left','right'] },
  { name: 'Drive Axle 1', sides: ['left-outer','left-inner','right-inner','right-outer'] },
  { name: 'Drive Axle 2', sides: ['left-outer','left-inner','right-inner','right-outer'] },
  { name: 'Trailer Axle 1', sides: ['left-outer','left-inner','right-inner','right-outer'] },
  { name: 'Trailer Axle 2', sides: ['left-outer','left-inner','right-inner','right-outer'] },
];

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function today() { return new Date().toISOString().split('T')[0]; }

function getVehicleStatus(vid) {
  const brakes = BRAKE_TESTS.filter(b => b.vehicleId === vid).sort((a,b) => b.testDate.localeCompare(a.testDate));
  const tyres = TYRE_RECORDS.filter(t => t.vehicleId === vid).sort((a,b) => b.photoDate.localeCompare(a.photoDate));
  const maint = MAINTENANCE.filter(m => m.vehicleId === vid).sort((a,b) => b.serviceDate.localeCompare(a.serviceDate));
  const dots = DOT_INSPECTIONS.filter(d => d.vehicleId === vid).sort((a,b) => b.inspectionDate.localeCompare(a.inspectionDate));

  const lastBrake = brakes[0];
  const lastTyre = tyres[0];
  const lastDot = dots[0];

  const now = today();
  const brakeDays = lastBrake ? daysBetween(lastBrake.testDate, now) : 9999;
  const tyreDays = lastTyre ? daysBetween(lastTyre.photoDate, now) : 9999;

  const brakeOverdue = brakeDays > 42;
  const brakeDueSoon = brakeDays > 35 && !brakeOverdue;
  const tyreOverdue = tyreDays > 14;
  const hasOOS = lastDot && lastDot.result === 'oos';

  // Vicious circle: maintenance without brake test same day
  const viciousCircle = maint.some(m => !brakes.find(b => b.testDate === m.serviceDate));

  const critical = brakeOverdue || hasOOS;
  const warning = brakeDueSoon || tyreOverdue || viciousCircle;

  return { lastBrake, lastTyre, lastDot, maint: maint[0], brakeDays, tyreDays, brakeOverdue, brakeDueSoon, tyreOverdue, hasOOS, viciousCircle: viciousCircle && maint.length > 0, critical, warning };
}

// ═══════════════════════════════════════════════════════
// ROUTING
// ═══════════════════════════════════════════════════════
let currentPage = 'dashboard';
let currentVehicleId = null;
let currentVehicleTab = 'maintenance';
let calendarMonth = new Date();
calendarMonth.setDate(1);

const PAGE_TITLES = { dashboard:'Dashboard', vehicles:'Vehicles', drivers:'Drivers', calendar:'Calendar', reports:'Reports', portal:'Driver Portal', vehicle:'Vehicle Detail' };

function navigate(page, vehicleId) {
  currentPage = page;
  currentVehicleId = vehicleId || null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById('nav-' + page);
  if (navEl) navEl.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  render();
}

function render() {
  const c = document.getElementById('content');
  if (currentPage === 'dashboard') c.innerHTML = renderDashboard();
  else if (currentPage === 'vehicles') c.innerHTML = renderVehicles();
  else if (currentPage === 'vehicle') c.innerHTML = renderVehicleDetail();
  else if (currentPage === 'drivers') c.innerHTML = renderDrivers();
  else if (currentPage === 'calendar') c.innerHTML = renderCalendar();
  else if (currentPage === 'reports') c.innerHTML = renderReports();
  else if (currentPage === 'portal') c.innerHTML = renderPortal();
}

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
function renderDashboard() {
  const statuses = VEHICLES.map(v => ({ v, s: getVehicleStatus(v.id) }));
  const roadworthy = statuses.filter(x => !x.s.critical && !x.s.tyreOverdue).length;
  const critical = statuses.filter(x => x.s.critical).length;
  const oos = statuses.filter(x => x.s.hasOOS);
  const brakeOverdue = statuses.filter(x => x.s.brakeOverdue);
  const brakeDueSoon = statuses.filter(x => x.s.brakeDueSoon);
  const tyreOverdue = statuses.filter(x => x.s.tyreOverdue);
  const vicious = statuses.filter(x => x.s.viciousCircle);

  let html = `
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-icon" style="background:#dbeafe">🚛</div>
      <div><div class="stat-num">${VEHICLES.length}</div><div class="stat-label">Total vehicles</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:#dcfce7">✅</div>
      <div><div class="stat-num" style="color:var(--success)">${roadworthy}</div><div class="stat-label">Roadworthy</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:#fee2e2">⚠️</div>
      <div><div class="stat-num" style="color:var(--danger)">${critical}</div><div class="stat-label">Critical issues</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:#f3e8ff">👤</div>
      <div><div class="stat-num">${DRIVERS.length}</div><div class="stat-label">Drivers</div></div>
    </div>
  </div>`;

  // OOS alert
  if (oos.length > 0) {
    html += `<div class="alert alert-danger">
      <div>
        <div class="alert-title">🚨 Out of Service — DO NOT OPERATE</div>
        ${oos.map(x => `<a href="#" onclick="navigate('vehicle','${x.v.id}');return false" style="margin-right:8px">
          <span class="badge badge-red">Truck #${x.v.truckNumber}</span></a>`).join('')}
      </div>
    </div>`;
  }

  // Vicious circle
  if (vicious.length > 0) {
    html += `<div class="alert alert-warning">
      <div>
        <div class="alert-title">🔄 Vicious Circle Alert — Service without brake test on same day</div>
        ${vicious.map(x => `<a href="#" onclick="navigate('vehicle','${x.v.id}');return false">
          <span class="badge badge-yellow" style="margin-right:6px">Truck #${x.v.truckNumber}</span></a>`).join('')}
      </div>
    </div>`;
  }

  html += `<div class="two-col">`;

  // Brake overdue
  html += `<div class="card">
    <div class="card-header">🔴 Brake Inspection Overdue</div>
    <div class="card-body">`;
  if (brakeOverdue.length === 0) {
    html += `<div class="empty">All vehicles within 42-day schedule</div>`;
  } else {
    brakeOverdue.forEach(x => {
      html += `<div class="history-item" style="border-left:3px solid var(--danger); cursor:pointer" onclick="navigate('vehicle','${x.v.id}')">
        <div><div class="fw-600">Truck #${x.v.truckNumber}</div>
        <div class="text-sm">${x.s.lastBrake ? x.s.brakeDays + ' days since last test' : 'No test on record'}</div></div>
        <span class="badge badge-red">OVERDUE</span>
      </div>`;
    });
  }
  html += `</div></div>`;

  // Due soon
  html += `<div class="card">
    <div class="card-header">🟡 Brake Test Due Soon</div>
    <div class="card-body">`;
  if (brakeDueSoon.length === 0) {
    html += `<div class="empty">No vehicles due in next 7 days</div>`;
  } else {
    brakeDueSoon.forEach(x => {
      const daysLeft = 42 - x.s.brakeDays;
      html += `<div class="history-item" style="cursor:pointer" onclick="navigate('vehicle','${x.v.id}')">
        <div><div class="fw-600">Truck #${x.v.truckNumber}</div>
        <div class="text-sm">Due in ${daysLeft} day${daysLeft===1?'':'s'}</div></div>
        <span class="badge badge-yellow">DUE SOON</span>
      </div>`;
    });
  }
  html += `</div></div>`;

  // Tyre overdue
  html += `<div class="card">
    <div class="card-header">🟠 Tyre Check Overdue (&gt;14 days)</div>
    <div class="card-body">`;
  if (tyreOverdue.length === 0) {
    html += `<div class="empty">All tyre checks are current</div>`;
  } else {
    tyreOverdue.forEach(x => {
      html += `<div class="history-item" style="cursor:pointer" onclick="navigate('vehicle','${x.v.id}')">
        <div><div class="fw-600">Truck #${x.v.truckNumber}</div>
        <div class="text-sm">${x.s.lastTyre ? x.s.tyreDays + ' days since last check' : 'No check on record'}</div></div>
        <span class="badge badge-yellow">${x.s.tyreDays === 9999 ? 'NONE' : x.s.tyreDays + ' days'}</span>
      </div>`;
    });
  }
  html += `</div></div>`;

  // Recent activity
  const allRecent = [
    ...MAINTENANCE.map(r => ({ date: r.serviceDate, label: `Service – Truck #${VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'}`, type:'maint' })),
    ...BRAKE_TESTS.map(r => ({ date: r.testDate, label: `Brake ${r.result} – Truck #${VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'}`, type:'brake', pass: r.result==='pass' })),
  ].sort((a,b) => b.date.localeCompare(a.date)).slice(0,6);

  html += `<div class="card">
    <div class="card-header">📋 Recent Activity</div>
    <div class="card-body">`;
  if (allRecent.length === 0) {
    html += `<div class="empty">No activity yet — add vehicles and records to get started</div>`;
  } else {
    allRecent.forEach(r => {
      const badge = r.type === 'brake' ? (r.pass ? 'badge-green' : 'badge-red') : 'badge-blue';
      html += `<div class="history-item">
        <span>${r.label}</span>
        <span class="badge ${badge}">${fmtDate(r.date)}</span>
      </div>`;
    });
  }
  html += `</div></div></div>`;

  if (VEHICLES.length === 0) {
    html += `<div class="alert alert-success" style="margin-top:20px">
      <div>
        <div class="alert-title">👋 Welcome to FleetGuard!</div>
        Start by adding your drivers and vehicles. Then log service records, brake tests, and tyre checks.
        <br><a href="#" onclick="navigate('vehicles');return false" style="color:var(--primary); font-weight:600">→ Add your first vehicle</a>
      </div>
    </div>`;
  }

  return html;
}

// ═══════════════════════════════════════════════════════
// VEHICLES
// ═══════════════════════════════════════════════════════
function renderVehicles() {
  let html = `
  <div class="card mb-4" style="margin-bottom:20px; max-width:560px">
    <div class="card-header">🚛 Add Vehicle</div>
    <div class="card-body">
      <div class="form-grid form-grid-3" style="margin-bottom:12px">
        <div><label>Truck Number</label><input type="text" id="v-truck" placeholder="e.g. T001"/></div>
        <div><label>Trailer Number</label><input type="text" id="v-trailer" placeholder="e.g. TR001"/></div>
        <div><label>Assign Driver</label>
          <select id="v-driver">
            <option value="">— optional —</option>
            ${DRIVERS.map(d => `<option value="${d.id}">${d.name}</option>`).join('')}
          </select>
        </div>
      </div>
      <button class="btn btn-primary" onclick="doAddVehicle()">+ Add Vehicle</button>
    </div>
  </div>
  <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:14px">`;

  if (VEHICLES.length === 0) {
    html += `<div class="empty" style="grid-column:1/-1; padding:40px">No vehicles yet — add one above.</div>`;
  }
  VEHICLES.forEach(v => {
    const driver = DRIVERS.find(d => d.id === v.assignedDriverId);
    const s = getVehicleStatus(v.id);
    const statusBadge = s.critical ? `<span class="badge badge-red">Critical</span>`
      : s.warning ? `<span class="badge badge-yellow">Warning</span>`
      : `<span class="badge badge-green">OK</span>`;

    html += `<div class="card" style="cursor:pointer" onclick="navigate('vehicle','${v.id}')">
      <div class="card-body" style="padding:16px">
        <div class="flex-between mb-4" style="margin-bottom:10px">
          <div>
            <div class="fw-600" style="font-size:15px">Truck #${v.truckNumber}</div>
            <div class="text-sm">Trailer #${v.trailerNumber}</div>
          </div>
          <div style="display:flex; gap:6px; align-items:center">
            ${statusBadge}
            <button class="btn btn-ghost btn-sm btn-icon" onclick="event.stopPropagation(); doDeleteVehicle('${v.id}', '${v.truckNumber}')" title="Delete vehicle">🗑</button>
          </div>
        </div>
        ${driver ? `<div class="text-sm">👤 ${driver.name}</div>` : ''}
        <div class="status-row" style="margin-top:10px">
          <span class="status-pill ${s.brakeOverdue ? 'badge-red' : s.brakeDueSoon ? 'badge-yellow' : 'badge-green'}">🔧 Brakes ${s.lastBrake ? s.brakeDays+'d' : 'None'}</span>
          <span class="status-pill ${s.tyreOverdue ? 'badge-yellow' : 'badge-green'}">⭕ Tyres ${s.lastTyre ? s.tyreDays+'d' : 'None'}</span>
        </div>
      </div>
    </div>`;
  });

  html += `</div>`;
  return html;
}

async function doAddVehicle() {
  const truck = document.getElementById('v-truck').value.trim();
  const trailer = document.getElementById('v-trailer').value.trim();
  const driver = document.getElementById('v-driver').value;
  if (!truck || !trailer) { showToast('Enter truck and trailer numbers', 'danger'); return; }
  await addVehicle(truck, trailer, driver || null);
  showToast('Vehicle added!', 'success');
  render();
}

async function doDeleteVehicle(id, num) {
  const ok = await confirm2(`Delete Truck #${num}?`, 'This will also delete all associated maintenance, brake, tyre, DOT, and mileage records. This cannot be undone.');
  if (!ok) return;
  await deleteVehicle(id);
  showToast('Vehicle deleted', 'warning');
  if (currentPage === 'vehicle') navigate('vehicles');
  else render();
}

// ═══════════════════════════════════════════════════════
// VEHICLE DETAIL
// ═══════════════════════════════════════════════════════
function renderVehicleDetail() {
  const v = VEHICLES.find(v => v.id === currentVehicleId);
  if (!v) return `<div class="alert alert-danger">Vehicle not found. <a href="#" onclick="navigate('vehicles');return false">Back to vehicles</a></div>`;

  const driver = DRIVERS.find(d => d.id === v.assignedDriverId);
  const s = getVehicleStatus(v.id);
  const maint = MAINTENANCE.filter(r => r.vehicleId === v.id).sort((a,b) => b.serviceDate.localeCompare(a.serviceDate));
  const brakes = BRAKE_TESTS.filter(r => r.vehicleId === v.id).sort((a,b) => b.testDate.localeCompare(a.testDate));
  const tyres = TYRE_RECORDS.filter(r => r.vehicleId === v.id).sort((a,b) => b.photoDate.localeCompare(a.photoDate));
  const dots = DOT_INSPECTIONS.filter(r => r.vehicleId === v.id).sort((a,b) => b.inspectionDate.localeCompare(a.inspectionDate));

  const tabs = ['maintenance','brakes','tyres','dot'];
  const tabLabels = { maintenance:'🔧 Service', brakes:'🛑 Brakes', tyres:'⭕ Tyres', dot:'📋 DOT' };

  let html = `
  <div style="margin-bottom:16px; display:flex; align-items:center; gap:12px">
    <button class="btn btn-ghost btn-sm" onclick="navigate('vehicles')">← Back</button>
    <div>
      <div style="font-size:20px; font-weight:700">Truck #${v.truckNumber}</div>
      <div class="text-sm">Trailer #${v.trailerNumber}${driver ? ' · Driver: ' + driver.name : ''}</div>
    </div>
    <div style="margin-left:auto; display:flex; gap:8px">
      ${s.critical ? `<span class="badge badge-red">Critical</span>` : s.warning ? `<span class="badge badge-yellow">Warning</span>` : `<span class="badge badge-green">Roadworthy</span>`}
    </div>
  </div>

  <div class="tabs">
    ${tabs.map(t => `<button class="tab ${currentVehicleTab === t ? 'active' : ''}" onclick="setVTab('${t}')">${tabLabels[t]}</button>`).join('')}
  </div>`;

  if (currentVehicleTab === 'maintenance') {
    html += `<div class="two-col">
    <div class="card">
      <div class="card-header">Record Service</div>
      <div class="card-body">
        <div class="form-grid">
          <div><label>Service Date</label><input type="date" id="m-date" value="${today()}" max="${today()}"/></div>
          <div><label>Notes (optional)</label><textarea id="m-notes" rows="2" placeholder="Any notes..."></textarea></div>
        </div>
        <button class="btn btn-primary mt-4" style="margin-top:12px" onclick="doAddMaintenance('${v.id}')">Save Service Record</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header">Service History (${maint.length})</div>
      <div class="card-body">`;
    if (maint.length === 0) html += `<div class="empty">No records yet</div>`;
    maint.forEach(r => {
      html += `<div class="history-item">
        <div>
          <div class="fw-600">Service: ${fmtDate(r.serviceDate)}</div>
          <div class="text-sm">Next due: ${fmtDate(r.nextInspectionDate)}</div>
          ${r.notes ? `<div class="text-sm" style="margin-top:2px">${r.notes}</div>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteMaintenance('${r.id}')" title="Delete">🗑</button>
      </div>`;
    });
    html += `</div></div></div>`;
  }

  if (currentVehicleTab === 'brakes') {
    html += `<div class="two-col">
    <div class="card">
      <div class="card-header">Record Brake Test</div>
      <div class="card-body">
        <div class="form-grid">
          <div><label>Test Date</label><input type="date" id="b-date" value="${today()}" max="${today()}"/></div>
          <div>
            <label>Result</label>
            <div class="toggle-group">
              <button class="toggle-btn active-pass" id="btog-pass" onclick="setBrakeResult('pass')">✓ Pass</button>
              <button class="toggle-btn" id="btog-fail" onclick="setBrakeResult('fail')">✗ Fail</button>
            </div>
          </div>
          <div><label>Notes (optional)</label><textarea id="b-notes" rows="2" placeholder="Any notes..."></textarea></div>
        </div>
        <button class="btn btn-primary mt-4" style="margin-top:12px" onclick="doAddBrake('${v.id}')">Save Brake Test</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header">Brake Test History (${brakes.length})</div>
      <div class="card-body">`;
    if (brakes.length === 0) html += `<div class="empty">No tests recorded yet</div>`;
    brakes.forEach(r => {
      html += `<div class="history-item">
        <div>
          <div class="fw-600">${fmtDate(r.testDate)}</div>
          ${r.notes ? `<div class="text-sm">${r.notes}</div>` : ''}
        </div>
        <div style="display:flex; gap:8px; align-items:center">
          <span class="badge ${r.result==='pass'?'badge-green':'badge-red'}">${r.result.toUpperCase()}</span>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteBrake('${r.id}')" title="Delete">🗑</button>
        </div>
      </div>`;
    });
    html += `</div></div></div>`;
  }

  if (currentVehicleTab === 'tyres') {
    html += `<div class="two-col">
    <div class="card">
      <div class="card-header">Record Tyre Check</div>
      <div class="card-body">
        <div style="margin-bottom:12px">
          <label>Photo Date</label>
          <input type="date" id="t-date" value="${today()}" max="${today()}"/>
        </div>
        <div class="tyre-grid">`;
    AXLES.forEach((axle, ai) => {
      html += `<div class="axle-row">
        <div class="axle-name">${axle.name}</div>
        <div class="tyre-selects">`;
      axle.sides.forEach(pos => {
        html += `<div class="tyre-select-row">
          <label>${pos.replace('-','<br>')}</label>
          <select id="t-${ai}-${pos}" onchange="updateTyreDot(this, 't-dot-${ai}-${pos}')">
            <option value="good">Good</option>
            <option value="bad">Bad</option>
            <option value="uneven">Uneven</option>
          </select>
          <div class="tyre-dot dot-good" id="t-dot-${ai}-${pos}"></div>
        </div>`;
      });
      html += `</div></div>`;
    });
    html += `</div>
        <button class="btn btn-primary mt-4" style="margin-top:14px" onclick="doAddTyre('${v.id}')">Save Tyre Record</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header">Tyre History (${tyres.length})</div>
      <div class="card-body">`;
    if (tyres.length === 0) html += `<div class="empty">No tyre records yet</div>`;
    tyres.forEach(r => {
      const readings = Array.isArray(r.readings) ? r.readings : [];
      const hasBad = readings.some(rd => rd.status === 'bad');
      const hasUneven = readings.some(rd => rd.status === 'uneven');
      html += `<div class="history-item">
        <div>
          <div class="fw-600">Photo: ${fmtDate(r.photoDate)}</div>
          <div style="display:flex; gap:4px; margin-top:4px; flex-wrap:wrap">
            ${readings.map(rd => `<div class="tyre-dot ${rd.status==='good'?'dot-good':rd.status==='bad'?'dot-bad':'dot-uneven'}" title="${rd.position}: ${rd.status}"></div>`).join('')}
          </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center">
          ${hasBad ? `<span class="badge badge-red">Bad tyre</span>` : hasUneven ? `<span class="badge badge-yellow">Uneven</span>` : `<span class="badge badge-green">All good</span>`}
          <button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteTyre('${r.id}')" title="Delete">🗑</button>
        </div>
      </div>`;
    });
    html += `</div></div></div>`;
  }

  if (currentVehicleTab === 'dot') {
    html += `<div class="two-col">
    <div class="card">
      <div class="card-header">Record DOT Inspection</div>
      <div class="card-body">
        <div class="form-grid">
          <div><label>Inspection Date</label><input type="date" id="d-date" value="${today()}" max="${today()}"/></div>
          <div><label>Driver</label>
            <select id="d-driver">
              <option value="">— select driver —</option>
              ${DRIVERS.map(d => `<option value="${d.id}">${d.name}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Result</label>
            <div class="toggle-group">
              <button class="toggle-btn active-pass" id="dtog-pass" onclick="setDotResult('pass')">✓ Pass</button>
              <button class="toggle-btn" id="dtog-violation" onclick="setDotResult('violation')">⚠ Violation</button>
              <button class="toggle-btn" id="dtog-oos" onclick="setDotResult('oos')">🚫 OOS</button>
            </div>
          </div>
          <div><label>Notes (optional)</label><textarea id="d-notes" rows="2" placeholder="Any notes..."></textarea></div>
        </div>
        <button class="btn btn-primary mt-4" style="margin-top:12px" onclick="doAddDOT('${v.id}')">Save DOT Inspection</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header">DOT History (${dots.length})</div>
      <div class="card-body">`;
    if (dots.length === 0) html += `<div class="empty">No DOT inspections recorded</div>`;
    dots.forEach(r => {
      const dName = DRIVERS.find(d => d.id === r.driverId)?.name;
      html += `<div class="history-item">
        <div>
          <div class="fw-600">${fmtDate(r.inspectionDate)}</div>
          ${dName ? `<div class="text-sm">👤 ${dName}</div>` : ''}
          ${r.notes ? `<div class="text-sm">${r.notes}</div>` : ''}
        </div>
        <div style="display:flex; gap:6px; align-items:center">
          <span class="badge ${r.result==='pass'?'badge-green':r.result==='violation'?'badge-yellow':'badge-red'}">${r.result.toUpperCase()}</span>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteDOT('${r.id}')" title="Delete">🗑</button>
        </div>
      </div>`;
    });
    html += `</div></div></div>`;
  }

  return html;
}

let _brakeResult = 'pass';
let _dotResult = 'pass';

function setVTab(t) { currentVehicleTab = t; render(); }

function setBrakeResult(r) {
  _brakeResult = r;
  ['pass','fail'].forEach(x => {
    const el = document.getElementById('btog-' + x);
    if (el) el.className = 'toggle-btn' + (x === r ? ' active-' + x : '');
  });
}

function setDotResult(r) {
  _dotResult = r;
  ['pass','violation','oos'].forEach(x => {
    const el = document.getElementById('dtog-' + x);
    if (el) el.className = 'toggle-btn' + (x === r ? ' active-' + x : '');
  });
}

function updateTyreDot(sel, dotId) {
  const dot = document.getElementById(dotId);
  if (!dot) return;
  dot.className = 'tyre-dot ' + (sel.value === 'good' ? 'dot-good' : sel.value === 'bad' ? 'dot-bad' : 'dot-uneven');
}

async function doAddMaintenance(vid) {
  const date = document.getElementById('m-date').value;
  const notes = document.getElementById('m-notes').value.trim();
  if (!date) { showToast('Select a service date', 'danger'); return; }
  await addMaintenance(vid, date, notes || null);
  showToast('Service record saved!', 'success'); render();
}

async function doAddBrake(vid) {
  const date = document.getElementById('b-date').value;
  const notes = document.getElementById('b-notes').value.trim();
  if (!date) { showToast('Select a test date', 'danger'); return; }
  await addBrakeTest(vid, date, _brakeResult, notes || null);
  showToast('Brake test saved!', 'success'); render();
}

async function doAddTyre(vid) {
  const date = document.getElementById('t-date').value;
  if (!date) { showToast('Select a photo date', 'danger'); return; }
  const readings = [];
  AXLES.forEach((axle, ai) => {
    axle.sides.forEach(pos => {
      const el = document.getElementById(`t-${ai}-${pos}`);
      if (el) readings.push({ axleIndex: ai, position: pos, status: el.value });
    });
  });
  await addTyreRecord(vid, date, readings);
  showToast('Tyre record saved!', 'success'); render();
}

async function doAddDOT(vid) {
  const date = document.getElementById('d-date').value;
  const driver = document.getElementById('d-driver').value;
  const notes = document.getElementById('d-notes').value.trim();
  if (!date) { showToast('Select an inspection date', 'danger'); return; }
  await addDOTInspection(vid, driver || null, date, _dotResult, notes || null);
  showToast('DOT inspection saved!', 'success'); render();
}



async function doDeleteMaintenance(id) {
  const ok = await confirm2('Delete this service record?', 'This cannot be undone.');
  if (!ok) return;
  await deleteMaintenance(id); showToast('Deleted', 'warning'); render();
}
async function doDeleteBrake(id) {
  const ok = await confirm2('Delete this brake test?', 'This cannot be undone.');
  if (!ok) return;
  await deleteBrakeTest(id); showToast('Deleted', 'warning'); render();
}
async function doDeleteTyre(id) {
  const ok = await confirm2('Delete this tyre record?', 'This cannot be undone.');
  if (!ok) return;
  await deleteTyreRecord(id); showToast('Deleted', 'warning'); render();
}
async function doDeleteDOT(id) {
  const ok = await confirm2('Delete this DOT inspection?', 'This cannot be undone.');
  if (!ok) return;
  await deleteDOTInspection(id); showToast('Deleted', 'warning'); render();
}

// ═══════════════════════════════════════════════════════
// DRIVERS
// ═══════════════════════════════════════════════════════
function renderDrivers() {
  let html = `
  <div class="card mb-4" style="margin-bottom:20px; max-width:480px">
    <div class="card-header">👤 Add Driver</div>
    <div class="card-body">
      <div style="display:flex; gap:10px">
        <input type="text" id="d-name" placeholder="Full name" style="flex:1" onkeydown="if(event.key==='Enter')doAddDriver()"/>
        <button class="btn btn-primary" onclick="doAddDriver()">+ Add</button>
      </div>
    </div>
  </div>
  <div class="card" style="max-width:480px">
    <div class="card-header">All Drivers (${DRIVERS.length})</div>
    <div class="card-body">`;

  if (DRIVERS.length === 0) {
    html += `<div class="empty">No drivers added yet</div>`;
  }
  DRIVERS.forEach(d => {
    const vehicles = VEHICLES.filter(v => v.assignedDriverId === d.id).map(v => `Truck #${v.truckNumber}`).join(', ');
    html += `<div class="history-item" id="driver-row-${d.id}">
      <div id="driver-view-${d.id}" style="flex:1; display:flex; align-items:center; gap:10px">
        <div>
          <div class="fw-600">${d.name}</div>
          ${vehicles ? `<div class="text-sm">${vehicles}</div>` : ''}
        </div>
      </div>
      <div id="driver-edit-${d.id}" style="flex:1; display:none; gap:8px; align-items:center">
        <input type="text" value="${d.name}" id="dedit-${d.id}" style="flex:1"/>
        <button class="btn btn-success btn-sm" onclick="doUpdateDriver('${d.id}')">Save</button>
        <button class="btn btn-ghost btn-sm" onclick="cancelEditDriver('${d.id}')">Cancel</button>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0" id="driver-btns-${d.id}">
        <button class="btn btn-ghost btn-sm" onclick="startEditDriver('${d.id}')">✏ Edit</button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteDriver('${d.id}', '${d.name.replace(/'/g,"\\'")}')">🗑</button>
      </div>
    </div>`;
  });

  html += `</div></div>`;
  return html;
}

async function doAddDriver() {
  const name = document.getElementById('d-name').value.trim();
  if (!name) { showToast('Enter a driver name', 'danger'); return; }
  await addDriver(name);
  document.getElementById('d-name').value = '';
  showToast('Driver added!', 'success'); render();
}

function startEditDriver(id) {
  document.getElementById('driver-view-' + id).style.display = 'none';
  document.getElementById('driver-edit-' + id).style.display = 'flex';
  document.getElementById('driver-btns-' + id).style.display = 'none';
  document.getElementById('dedit-' + id).focus();
}
function cancelEditDriver(id) {
  document.getElementById('driver-view-' + id).style.display = 'flex';
  document.getElementById('driver-edit-' + id).style.display = 'none';
  document.getElementById('driver-btns-' + id).style.display = 'flex';
}
async function doUpdateDriver(id) {
  const name = document.getElementById('dedit-' + id).value.trim();
  if (!name) { showToast('Name cannot be empty', 'danger'); return; }
  await updateDriver(id, name);
  showToast('Driver updated!', 'success'); render();
}
async function doDeleteDriver(id, name) {
  const ok = await confirm2(`Delete driver "${name}"?`, 'This driver will be removed from all vehicles and their mileage/DOT records will be unlinked.');
  if (!ok) return;
  await deleteDriver(id);
  showToast('Driver deleted', 'warning'); render();
}

// ═══════════════════════════════════════════════════════
// CALENDAR — with month navigation (BUG FIX)
// ═══════════════════════════════════════════════════════
function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = today();

  // Build events
  const events = [];
  VEHICLES.forEach(v => {
    const brakes = BRAKE_TESTS.filter(b => b.vehicleId === v.id).sort((a,b) => b.testDate.localeCompare(a.testDate));
    const maint = MAINTENANCE.filter(m => m.vehicleId === v.id).sort((a,b) => b.serviceDate.localeCompare(a.serviceDate));
    if (brakes[0]) {
      const d = new Date(brakes[0].testDate); d.setDate(d.getDate()+42);
      events.push({ date: d.toISOString().split('T')[0], label: `Truck #${v.truckNumber} brake due`, type: 'brake' });
    }
    if (maint[0]) {
      events.push({ date: maint[0].nextInspectionDate, label: `Truck #${v.truckNumber} inspection`, type: 'maint' });
    }
  });

  const monthName = calendarMonth.toLocaleDateString('en-US', { month:'long', year:'numeric' });

  let html = `
  <div class="card" style="margin-bottom:20px">
    <div class="card-body">
      <div class="cal-header">
        <button class="btn btn-ghost btn-sm" onclick="calPrev()">← Prev</button>
        <div class="cal-month-title">${monthName}</div>
        <button class="btn btn-ghost btn-sm" onclick="calNext()">Next →</button>
      </div>
      <div class="cal-grid">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-day-header">${d}</div>`).join('')}
        ${Array(firstDay).fill('<div></div>').join('')}`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayEvents = events.filter(e => e.date === dateStr);
    const isToday = dateStr === todayStr;
    html += `<div class="cal-day ${isToday ? 'today' : ''} ${dayEvents.length ? 'has-events' : ''}">
      <div class="cal-day-num">${d}</div>
      ${dayEvents.map(e => `<div class="cal-event cal-event-${e.type}" title="${e.label}">${e.label.split(' ').slice(0,2).join(' ')}</div>`).join('')}
    </div>`;
  }

  html += `</div></div></div>

  <div class="card">
    <div class="card-header">📋 All Upcoming Events</div>
    <div class="card-body">`;

  const upcoming = events.filter(e => e.date >= todayStr).sort((a,b) => a.date.localeCompare(b.date));
  if (upcoming.length === 0) {
    html += `<div class="empty">No upcoming events</div>`;
  }
  upcoming.forEach(e => {
    const daysAway = daysBetween(todayStr, e.date);
    html += `<div class="history-item">
      <span>${e.label}</span>
      <div style="display:flex; gap:8px; align-items:center">
        <span class="text-sm">${fmtDate(e.date)}</span>
        <span class="badge ${daysAway <= 7 ? 'badge-red' : daysAway <= 14 ? 'badge-yellow' : 'badge-blue'}">${daysAway === 0 ? 'Today' : daysAway + 'd'}</span>
      </div>
    </div>`;
  });

  html += `</div></div>`;
  return html;
}

function calPrev() { calendarMonth.setMonth(calendarMonth.getMonth()-1); render(); }
function calNext() { calendarMonth.setMonth(calendarMonth.getMonth()+1); render(); }

// ═══════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════
function renderReports() {
  const statuses = VEHICLES.map(v => ({ v, s: getVehicleStatus(v.id) }));
  const roadworthy = statuses.filter(x => !x.s.critical && !x.s.tyreOverdue).length;
  const pending = VEHICLES.length - roadworthy;
  const brakePass = BRAKE_TESTS.filter(b => b.result === 'pass').length;
  const brakeFail = BRAKE_TESTS.filter(b => b.result === 'fail').length;
  const dotPass = DOT_INSPECTIONS.filter(d => d.result === 'pass').length;
  const dotViol = DOT_INSPECTIONS.filter(d => d.result === 'violation').length;
  const dotOOS = DOT_INSPECTIONS.filter(d => d.result === 'oos').length;

  const maxBar = Math.max(brakePass, brakeFail, 1);

  let html = `
  <div class="stats-grid" style="margin-bottom:24px">
    <div class="stat-card"><div class="stat-icon" style="background:#dbeafe">🚛</div><div><div class="stat-num">${VEHICLES.length}</div><div class="stat-label">Vehicles</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#dcfce7">🔧</div><div><div class="stat-num">${MAINTENANCE.length}</div><div class="stat-label">Service records</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#fef3c7">🛑</div><div><div class="stat-num">${BRAKE_TESTS.length}</div><div class="stat-label">Brake tests</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#f3e8ff">📋</div><div><div class="stat-num">${DOT_INSPECTIONS.length}</div><div class="stat-label">DOT inspections</div></div></div>
  </div>

  <div class="two-col">
  <div class="card">
    <div class="card-header">Fleet Roadworthiness</div>
    <div class="card-body">
      <div style="display:flex; gap:16px; align-items:flex-end">
        <div style="flex:1">
          <div class="chart-bar-wrap">
            <div class="chart-bar-col">
              <div class="chart-bar-val" style="color:var(--success)">${roadworthy}</div>
              <div class="chart-bar" style="background:var(--success); height:${VEHICLES.length ? (roadworthy/VEHICLES.length)*100 : 0}%"></div>
              <div class="chart-bar-label">Roadworthy</div>
            </div>
            <div class="chart-bar-col">
              <div class="chart-bar-val" style="color:var(--danger)">${pending}</div>
              <div class="chart-bar" style="background:var(--danger); height:${VEHICLES.length ? (pending/VEHICLES.length)*100 : 0}%"></div>
              <div class="chart-bar-label">Pending</div>
            </div>
          </div>
        </div>
        <div style="font-size:13px; color:var(--text2); min-width:120px">
          <div><span style="color:var(--success); font-weight:700">${VEHICLES.length ? Math.round(roadworthy/VEHICLES.length*100) : 0}%</span> roadworthy</div>
          <div style="margin-top:4px">${VEHICLES.length} total vehicles</div>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">Brake Test Results</div>
    <div class="card-body">
      <div class="chart-bar-wrap">
        <div class="chart-bar-col">
          <div class="chart-bar-val" style="color:var(--success)">${brakePass}</div>
          <div class="chart-bar" style="background:var(--success); height:${Math.round(brakePass/maxBar*100)}%"></div>
          <div class="chart-bar-label">Pass</div>
        </div>
        <div class="chart-bar-col">
          <div class="chart-bar-val" style="color:var(--danger)">${brakeFail}</div>
          <div class="chart-bar" style="background:var(--danger); height:${Math.round(brakeFail/maxBar*100)}%"></div>
          <div class="chart-bar-label">Fail</div>
        </div>
      </div>
      <div class="text-sm" style="margin-top:8px">Pass rate: <strong>${BRAKE_TESTS.length ? Math.round(brakePass/BRAKE_TESTS.length*100) : 0}%</strong></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">DOT Inspection Results</div>
    <div class="card-body">
      <div class="chart-bar-wrap">
        ${[{l:'Pass', v:dotPass, c:'var(--success)'},{l:'Violation', v:dotViol, c:'var(--warning)'},{l:'OOS', v:dotOOS, c:'var(--danger)'}].map(b => {
          const m = Math.max(dotPass, dotViol, dotOOS, 1);
          return `<div class="chart-bar-col">
            <div class="chart-bar-val" style="color:${b.c}">${b.v}</div>
            <div class="chart-bar" style="background:${b.c}; height:${Math.round(b.v/m*100)}%"></div>
            <div class="chart-bar-label">${b.l}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">Per-Vehicle Summary</div>
    <div class="card-body" style="padding:0">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Truck</th><th>Last brake</th><th>Last tyre</th><th>Status</th></tr></thead>
          <tbody>
            ${VEHICLES.length === 0 ? `<tr><td colspan="4" class="empty">No vehicles</td></tr>` : VEHICLES.map(v => {
              const s = getVehicleStatus(v.id);
              return `<tr style="cursor:pointer" onclick="navigate('vehicle','${v.id}')">
                <td><strong>Truck #${v.truckNumber}</strong></td>
                <td>${s.lastBrake ? fmtDate(s.lastBrake.testDate) : '—'}</td>
                <td>${s.lastTyre ? fmtDate(s.lastTyre.photoDate) : '—'}</td>
                <td><span class="badge ${s.critical?'badge-red':s.warning?'badge-yellow':'badge-green'}">${s.critical?'Critical':s.warning?'Warning':'OK'}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>
  </div>`;
  return html;
}

// ═══════════════════════════════════════════════════════
// DRIVER PORTAL
// ═══════════════════════════════════════════════════════
function renderPortal() {
  let html = `
  <div style="max-width:520px; margin:0 auto">
    <div style="text-align:center; padding:20px 0 24px">
      <div style="font-size:40px; margin-bottom:8px">🛡️</div>
      <div style="font-size:20px; font-weight:700">Driver Portal</div>
      <div class="text-sm">Submit tyre checks and mileage</div>
    </div>

    <div id="portal-success" style="display:none" class="alert alert-success">
      <div><div class="alert-title">✅ Submitted successfully!</div>Your report has been saved.</div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header">Who are you?</div>
      <div class="card-body">
        <div class="form-grid form-grid-2">
          <div><label>Your Name</label>
            <select id="p-driver">
              <option value="">— select —</option>
              ${DRIVERS.map(d => `<option value="${d.id}">${d.name}</option>`).join('')}
            </select>
          </div>
          <div><label>Vehicle</label>
            <select id="p-vehicle">
              <option value="">— select —</option>
              ${VEHICLES.map(v => `<option value="${v.id}">Truck #${v.truckNumber}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header">📍 Current Mileage</div>
      <div class="card-body">
        <input type="number" id="p-mileage" placeholder="e.g. 125000" min="0"/>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header">⭕ Tyre Check</div>
      <div class="card-body">
        <div style="margin-bottom:12px">
          <label>Photo Date</label>
          <input type="date" id="p-tyredate" value="${today()}" max="${today()}"/>
        </div>
        <div class="tyre-grid">`;

  AXLES.forEach((axle, ai) => {
    html += `<div class="axle-row">
      <div class="axle-name">${axle.name}</div>
      <div class="tyre-selects">`;
    axle.sides.forEach(pos => {
      html += `<div class="tyre-select-row">
        <label>${pos.replace('-','/')}</label>
        <select id="p-t-${ai}-${pos}">
          <option value="good">Good</option>
          <option value="bad">Bad</option>
          <option value="uneven">Uneven</option>
        </select>
      </div>`;
    });
    html += `</div></div>`;
  });

  html += `</div>
      </div>
    </div>

    <button class="btn btn-primary" style="width:100%; padding:14px; font-size:15px" onclick="doSubmitPortal()">
      Submit Report
    </button>
  </div>`;
  return html;
}

async function doSubmitPortal() {
  const driverId = document.getElementById('p-driver').value;
  const vehicleId = document.getElementById('p-vehicle').value;
  if (!driverId || !vehicleId) { showToast('Select your name and vehicle', 'danger'); return; }

  const mileage = parseInt(document.getElementById('p-mileage').value);
  const tyreDate = document.getElementById('p-tyredate').value;

  if (mileage > 0) await addMileage(vehicleId, driverId, mileage);

  if (tyreDate) {
    const readings = [];
    AXLES.forEach((axle, ai) => {
      axle.sides.forEach(pos => {
        const el = document.getElementById(`p-t-${ai}-${pos}`);
        if (el) readings.push({ axleIndex: ai, position: pos, status: el.value });
      });
    });
    await addTyreRecord(vehicleId, tyreDate, readings);
  }

  // Reset form (BUG FIX: was not resetting tyre readings before)
  document.getElementById('p-mileage').value = '';
  document.getElementById('p-tyredate').value = today();
  document.getElementById('p-driver').value = '';
  document.getElementById('p-vehicle').value = '';
  AXLES.forEach((axle, ai) => {
    axle.sides.forEach(pos => {
      const el = document.getElementById(`p-t-${ai}-${pos}`);
      if (el) el.value = 'good';
    });
  });

  const succ = document.getElementById('portal-success');
  if (succ) { succ.style.display = 'flex'; setTimeout(() => { succ.style.display = 'none'; }, 4000); }
  showToast('Report submitted!', 'success');
}

// ═══════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════

// Toast
let toastTimer;
function showToast(msg, type='success') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 18px;border-radius:10px;font-weight:600;font-size:13px;z-index:1000;box-shadow:0 4px 16px rgba(0,0,0,.15);transition:opacity .3s;';
    document.body.appendChild(toast);
  }
  const colors = { success:'background:#15803d;color:#fff', danger:'background:#dc2626;color:#fff', warning:'background:#d97706;color:#fff' };
  toast.style.cssText += ';' + (colors[type] || colors.success);
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// Confirm dialog
async function confirm2(title, body) {
  return new Promise(resolve => {
    window._confirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = body;
    document.getElementById('confirm-modal').style.display = 'flex';
  });
}
function confirmResolve(val) {
  document.getElementById('confirm-modal').style.display = 'none';
  if (window._confirmResolve) { window._confirmResolve(val); window._confirmResolve = null; }
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
async function init() {
  initSupabase();
  await loadAll();
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  render();

  // Auto-refresh every 30s if using Supabase
  setInterval(async () => {
    if (useSupabase) { await loadAll(); render(); }
  }, 30000);
}

init();
