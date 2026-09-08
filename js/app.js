// ═══════════════════════════════════════════════════════
// AUTH LAYER
// ═══════════════════════════════════════════════════════
let sb = null;
let currentUser = null;
let currentRole = null;

function getCreateClient() {
  if (window.supabase && typeof window.supabase.createClient === 'function') return window.supabase.createClient;
  if (window.supabase?.default?.createClient) return window.supabase.default.createClient;
  if (typeof createClient === 'function') return createClient;
  return null;
}

async function initAuth() {
  const HARDCODED_URL = 'https://tmpdsiuadafbkmldvlki.supabase.co';
  const HARDCODED_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRtcGRzaXVhZGFmYmttbGR2bGtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2OTA1MzcsImV4cCI6MjA5MTI2NjUzN30.EpALvafgN7q0HAgS1K286IU7B2xGrkQQwpriMOvAr6o';
  const url = HARDCODED_URL;
  const key = HARDCODED_KEY;
  const fn = getCreateClient();
  if (!fn) { showLoginScreen('db'); return; }
  try {
    sb = fn(url, key);
    const { data: { session } } = await sb.auth.getSession();
    if (session) { await setUserFromSession(session); }
    else { showLoginScreen(); }
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) { await setUserFromSession(session); }
      else if (event === 'SIGNED_OUT') { currentUser = null; currentRole = null; showLoginScreen(); }
    });
  } catch(e) { showLoginScreen('db'); }
}

async function setUserFromSession(session) {
  currentUser = session.user;
  try {
    const { data } = await sb.from('profiles').select('role, banned_at').eq('id', currentUser.id).single();
    if (data?.banned_at) { await sb.auth.signOut(); showLoginScreen(); return; }
    currentRole = data?.role || 'dispatcher';
  } catch(e) { await sb.auth.signOut(); showLoginScreen(); return; }
  hideLoginScreen();
  await loadAll();
  restoreNavState();
  render();
  syncNavChrome();
  updateUserBar();
}

async function signIn() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  if (!email || !password) { errEl.textContent='Enter email and password.'; errEl.style.display='block'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in...';
  errEl.style.display = 'none';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { errEl.textContent='Invalid email or password.'; errEl.style.display='block'; btn.disabled=false; btn.innerHTML='Sign In'; }
}

async function signOut() {
  await sb.auth.signOut();
  localStorage.removeItem('sb_key');
  localStorage.removeItem('sb_url');
}

function showLoginScreen(mode) {
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  // login-db-setup was removed; guard against its absence and always fall back to the sign-in form.
  const dbSetup = document.getElementById('login-db-setup');
  const formSection = document.getElementById('login-form-section');
  const showDb = mode === 'db' && !!dbSetup;
  if (dbSetup) dbSetup.style.display = showDb ? 'block' : 'none';
  if (formSection) formSection.style.display = showDb ? 'none' : 'block';
}

function hideLoginScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

function updateUserBar() {
  const pill = document.getElementById('user-pill');
  const roleBadge = document.getElementById('role-badge');
  if (pill && currentUser) pill.textContent = currentUser.email;
  if (roleBadge && currentRole) {
    roleBadge.textContent = currentRole==='admin' ? '👑 Admin' : '👁 Dispatcher';
    roleBadge.className = 'badge ' + (currentRole==='admin' ? 'badge-blue' : 'badge-gray');
  }
}

function isAdmin() { return currentRole === 'admin'; }

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }


// ═══════════════════════════════════════════════════════
// DATA LAYER
// ═══════════════════════════════════════════════════════
let DRIVERS=[], VEHICLES=[], MAINTENANCE=[], BRAKE_TESTS=[], TYRE_RECORDS=[], DOT_INSPECTIONS=[], MILEAGE=[], SERVICE_RECORDS=[], INSPECTIONS=[], LINK_SENDS=[], SCHEDULES=[], GLOBAL_SCHED=[];
// Flipped on by loadAll() once inspections carries the migration-011 repair
// columns. Gates every part of the defect-repair feature.
let REPAIRS_AVAILABLE=false;
// Same idea for vehicles.annual_inspection_expiry (migration 012).
let ANNUAL_AVAILABLE=false;
// Driver cell numbers (migration 002). Two things worth knowing here:
//
//   1. driver_phones is admin-only by RLS ("phones_select_admin" USING is_admin()),
//      so a dispatcher's SELECT returns zero rows, PHONES_AVAILABLE stays false
//      and the Cell column is never rendered for them. The gate is the
//      database's, not this file's — which is the whole reason numbers are kept
//      off the drivers table.
//   2. js/reminders.js already declares a top-level `DRIVER_PHONES`. Both files
//      are plain scripts sharing one global scope, so a second `let DRIVER_PHONES`
//      here would be a SyntaxError that stops the entire application from
//      parsing. Hence the different name.
let PHONES_BY_DRIVER={};
let PHONES_AVAILABLE=false;
// Certificate expiry warning windows.
const ANNUAL_WARN_DAYS=30;   // amber from here
const ANNUAL_CRIT_DAYS=7;    // red from here, and red once expired

// ── Inspection intervals: one resolution chain for the whole app ─────────────
//   1. vehicle-specific row  (vehicle_effective_schedules — ladder already applied)
//   2. fleet default row     (reminder_schedules WHERE vehicle_id IS NULL)
//   3. the constants below   (last resort, only if no global row exists)
//
// Step 2 was added 2026-07-29. Previously the dashboard skipped straight to the
// constants, so fleet policy lived in three places — here, the digest, and the
// global rows driving the SMS bot — and they drifted: brakes read 42 here but 35
// in the digest and bot, tyres 7 here but 14 in the digest. Reading the global
// rows makes one UPDATE move every system together.
const SCHED_DEFAULTS={
  brake_service : {interval:30, warn:7},  // brakeOverdue >30, dueSoon >23
  dot_inspection: {interval:90, warn:7},  // yard/periodic: serviceOverdue >90, dueSoon >83
  tyre_check    : {interval:7,  warn:0},  // tyreOverdue >=7
};
function vehSched(vehicleId,type){
  const def=SCHED_DEFAULTS[type];
  // 1. this truck's own row (new-truck exemption etc.) — already ladder-resolved
  const row=SCHEDULES.find(s=>s.vehicle_id===vehicleId&&s.reminder_type===type&&s.enabled!==false);
  if(row&&row.interval_days>0) return {interval:row.interval_days,warn:row.warning_days_before??def.warn,custom:true};
  // 2. fleet default from the database — the same row the SMS bot reads
  const g=GLOBAL_SCHED.find(s=>s.reminder_type===type&&s.enabled!==false);
  if(g&&g.interval_days>0) return {interval:g.interval_days,warn:g.warning_days_before??def.warn,custom:false};
  // 3. constants, only when no global row has been configured
  return {interval:def.interval,warn:def.warn,custom:false};
}
// True only while a new-truck ladder is still stepping down. Once every ladder is
// exhausted the row survives on the fleet interval, so `custom` stays true — this
// is what the NEW TRUCK watermark keys off, so the mark clears itself on expiry.
function onNewTruckLadder(vehicleId){
  return SCHEDULES.some(s=>s.vehicle_id===vehicleId&&s.enabled!==false
    &&Array.isArray(s.step_intervals)&&s.step_intervals.length>0
    &&(s.completed_since_exemption??0)<s.step_intervals.length);
}

async function loadAll() {
  if (!sb) return;
  const [d,v,m,b,t,dot,mil,svc,insp,vex,rep,ls,sch,gsch,ph] = await Promise.all([
    sb.from('drivers').select('id,name,on_vacation,created_at').order('created_at'),
    sb.from('vehicles').select('id,truck_number,trailer_number,assigned_driver_id,assigned_dispatcher,created_at').order('created_at'),
    sb.from('maintenance_records').select('id,vehicle_id,service_date,next_inspection_date,notes').order('created_at'),
    sb.from('brake_tests').select('id,vehicle_id,test_date,result,notes').order('created_at'),
    sb.from('tyre_records').select('id,vehicle_id,photo_date,readings').order('created_at'),
    sb.from('dot_inspections').select('id,vehicle_id,driver_id,inspection_date,result,notes').order('created_at'),
    sb.from('mileage_records').select('id,vehicle_id,driver_id,mileage,date').order('created_at'),
    sb.from('service_records').select('id,vehicle_id,service_date,result,notes').order('created_at'),
    sb.from('inspections').select('id,ref,vehicle_id,driver_id,truck_number,trailer_number,submitted_at,duration_sec,odometer,overall_result,tyres_flagged,checks_failed').order('submitted_at',{ascending:false}).limit(500),
    // Same guarded-separate-query pattern as the repair columns below: folding
    // annual_inspection_expiry into the vehicles select above would fail the
    // WHOLE vehicles fetch with 42703 before migration 012, emptying the fleet
    // everywhere in the app. Split, a missing column costs only this one pill.
    sb.from('vehicles').select('id,annual_inspection_expiry').order('created_at'),
    // Repair columns live in a SEPARATE query on purpose. They arrive with
    // migration 011, and folding them into the select above would make the
    // whole inspections fetch fail with 42703 until that migration is applied —
    // blanking the PTI pills and Inspections page fleet-wide. Split this way,
    // a missing column costs only the defect-tracking feature.
    sb.from('inspections').select('id,repair_status,repaired_at,repair_notes').order('submitted_at',{ascending:false}).limit(500),
    sb.from('link_sends').select('driver_id,vehicle_id,status,created_at').order('created_at',{ascending:false}).limit(1000),
    sb.from('vehicle_effective_schedules').select('vehicle_id,reminder_type,interval_days,warning_days_before,enabled,step_intervals,completed_since_exemption'),
    // Fleet defaults. Guarded like the rest: if this fails, GLOBAL_SCHED stays
    // empty and vehSched falls through to the constants, i.e. today's behaviour.
    sb.from('reminder_schedules').select('reminder_type,interval_days,warning_days_before,enabled').is('vehicle_id',null),
    // Driver cell numbers. Guarded and separate for the same reason as the
    // repair and annual columns above: this is the one table in the set that
    // a dispatcher is not allowed to read at all, and folding it into the
    // drivers select would fail the WHOLE drivers fetch for them and empty the
    // fleet everywhere. Split, a refused read costs only the Cell column.
    // Same shape js/reminders.js has read since migration 002.
    sb.from('driver_phones').select('driver_id,phone_number,verified'),
  ]);
  // Guard: only overwrite each array if the query succeeded.
  // Supabase returns {data:null, error:{...}} on failure — never wipe live data with a failed response.
  if (!d.error && d.data) DRIVERS = d.data;
  if (!v.error && v.data) VEHICLES = v.data.map(v=>({...v,truckNumber:v.truck_number,trailerNumber:v.trailer_number,assignedDriverId:v.assigned_driver_id,assignedDispatcher:v.assigned_dispatcher||''}));
  if (!m.error && m.data) MAINTENANCE = m.data.map(r=>({...r,vehicleId:r.vehicle_id,serviceDate:r.service_date,nextInspectionDate:r.next_inspection_date}));
  if (!b.error && b.data) BRAKE_TESTS = b.data.map(r=>({...r,vehicleId:r.vehicle_id,testDate:r.test_date}));
  if (!t.error && t.data) TYRE_RECORDS = t.data.map(r=>({...r,vehicleId:r.vehicle_id,photoDate:r.photo_date}));
  if (!dot.error && dot.data) DOT_INSPECTIONS = dot.data.map(r=>({...r,vehicleId:r.vehicle_id,driverId:r.driver_id,inspectionDate:r.inspection_date}));
  if (!mil.error && mil.data) MILEAGE = mil.data.map(r=>({...r,vehicleId:r.vehicle_id,driverId:r.driver_id}));
  if (!svc.error && svc.data) SERVICE_RECORDS = svc.data.map(r=>({...r,vehicleId:r.vehicle_id,serviceDate:r.service_date}));
  // inspections table may not exist until migration 003 is applied — guarded like the rest
  if (!insp.error && insp.data) INSPECTIONS = insp.data.map(r=>({...r,vehicleId:r.vehicle_id,driverId:r.driver_id,truckNumber:r.truck_number,trailerNumber:r.trailer_number,submittedAt:r.submitted_at,durationSec:r.duration_sec,overallResult:r.overall_result,tyresFlagged:r.tyres_flagged,checksFailed:r.checks_failed}));
  // Annual DOT expiry arrives with migration 012; until then the column is
  // absent, ANNUAL_AVAILABLE stays false and the pill is simply not rendered.
  ANNUAL_AVAILABLE = !vex.error && !!vex.data;
  if (ANNUAL_AVAILABLE) {
    const byId = new Map(vex.data.map(r=>[r.id,r.annual_inspection_expiry]));
    VEHICLES.forEach(v=>{ v.annualExpiry = byId.get(v.id) ?? null; });
  }
  // Defect tracking switches itself on only once migration 011 has been applied.
  // Until then REPAIRS_AVAILABLE stays false and isOpenDefect() returns false for
  // everything, so status, pills and buttons behave exactly as they do today —
  // rather than marking every historical defect red with no way to clear it.
  REPAIRS_AVAILABLE = !rep.error && !!rep.data;
  if (REPAIRS_AVAILABLE) {
    const byId = new Map(rep.data.map(r=>[r.id,r]));
    INSPECTIONS.forEach(r=>{
      const x = byId.get(r.id);
      r.repairStatus = x?.repair_status ?? null;
      r.repairedAt   = x?.repaired_at   ?? null;
      r.repairNotes  = x?.repair_notes  ?? null;
    });
  }
  // link_sends: now admin+dispatcher readable (RLS 005) — powers "last PTI link sent" on the vehicle PTI tab
  if (!ls.error && ls.data) LINK_SENDS = ls.data.map(r=>({...r,driverId:r.driver_id,vehicleId:r.vehicle_id,createdAt:r.created_at}));
  // vehicle_effective_schedules (migration 009) already resolves the new-truck
  // ladder to the interval that applies today, so nothing is computed here.
  // Guarded like the rest — a failed fetch leaves SCHEDULES as-is, and an empty
  // SCHEDULES simply means every truck uses the fleet defaults.
  if (!sch.error && sch.data) SCHEDULES = sch.data;
  if (!gsch.error && gsch.data) GLOBAL_SCHED = gsch.data;
  // A dispatcher gets an empty set here rather than an error, so treat "no rows
  // and no error" as available-but-empty and let RLS decide what is visible.
  // Reset the map on failure instead of leaving a stale one behind: a phone the
  // current session is no longer entitled to read must not stay on screen.
  PHONES_AVAILABLE = !ph.error && !!ph.data;
  PHONES_BY_DRIVER = {};
  if (PHONES_AVAILABLE) ph.data.forEach(r=>{ PHONES_BY_DRIVER[r.driver_id]={number:r.phone_number,verified:!!r.verified}; });
}

// ── Driver cell numbers ─────────────────────────────────────────────────────
// Normalisation deliberately mirrors the update_phone action in
// supabase/functions/broadcast-sms/index.ts line for line, so a number typed
// here and a number typed into the SMS tooling land in the database identically.
// The database has the last word either way: driver_phones.phone_number carries
// CHECK (phone_number ~ '^\+[1-9]\d{7,14}$') from migration 002, so a bad value
// is refused server-side even if this function were bypassed.
function normalizePhoneE164(raw){
  const s=String(raw==null?'':raw).trim();
  const digits=s.replace(/\D/g,'');
  if(digits.length===10) return '+1'+digits;
  if(digits.length===11&&digits[0]==='1') return '+'+digits;
  return s.startsWith('+')?s:'';
}
function isE164(p){ return /^\+[1-9]\d{7,14}$/.test(p); }
// Display format for a US number; anything else is shown as stored.
function fmtPhone(p){
  const m=/^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p||''));
  return m?`(${m[1]}) ${m[2]}-${m[3]}`:String(p||'');
}

// Writes go straight to the table, not through broadcast-sms. That function
// authenticates with a shared GV_SERVICE_SECRET, and putting that secret in
// front-end JavaScript would hand every user of this app the ability to blast
// SMS to the whole fleet and read every number on file. RLS is the correct
// door: "phones_insert_admin" / "phones_update_admin" both require is_admin(),
// so a dispatcher who forges this call is refused by the database.
async function doSaveDriverPhone(id){
  if(!isAdmin())return;
  const el=document.getElementById('dphone-'+id); if(!el||!sb)return;
  const raw=el.value.trim();
  const driver=DRIVERS.find(d=>d.id===id);
  // Empty field clears the number — the way to remove one without a second control.
  if(raw===''){
    if(!PHONES_BY_DRIVER[id]){ cancelEditPhone(id); return; }
    const ok=await confirm2(`Remove cell number for "${driver?driver.name:'this driver'}"?`,'They will stop receiving PTI links and SMS reminders.');
    if(!ok)return;
    const {error}=await sb.from('driver_phones').delete().eq('driver_id',id);
    if(error){showToast('Could not remove number: '+error.message,'danger');return;}
    delete PHONES_BY_DRIVER[id];
    showToast('Cell number removed','warning'); render(); return;
  }
  const phone=normalizePhoneE164(raw);
  if(!isE164(phone)){showToast('Enter a valid number, e.g. (262) 555-0142','danger');return;}
  const now=new Date().toISOString();
  // driver_id is the PRIMARY KEY, so one upsert covers both add and edit.
  // verified resets to false: a changed number has not been confirmed by the
  // driver yet, which is exactly what the SMS side assumes.
  const {error}=await sb.from('driver_phones')
    .upsert({driver_id:id,phone_number:phone,verified:false,updated_at:now},{onConflict:'driver_id'});
  if(error){showToast('Could not save number: '+error.message,'danger');return;}
  PHONES_BY_DRIVER[id]={number:phone,verified:false};
  showToast('Cell number saved','success'); render();
}
// The restored value is 'inline-flex', not 'flex': .v2-phone and .v2-phone-none
// are both inline-flex in v2-drivers.css, and forcing them to block-level flex
// would silently relayout the cell the first time anyone cancelled an edit.
// Same class of bug as startEditDriver hardcoding 'flex' — see v2/PORTING.md.
function startEditPhone(id){
  const v=document.getElementById('phone-view-'+id),e=document.getElementById('phone-edit-'+id);
  if(!v||!e)return;
  v.style.display='none'; e.style.display='inline-flex';
  const i=document.getElementById('dphone-'+id); if(i){i.focus();i.select();}
}
function cancelEditPhone(id){
  const v=document.getElementById('phone-view-'+id),e=document.getElementById('phone-edit-'+id);
  if(!v||!e)return;
  v.style.display='inline-flex'; e.style.display='none';
  const i=document.getElementById('dphone-'+id);
  if(i) i.value=PHONES_BY_DRIVER[id]?PHONES_BY_DRIVER[id].number:'';
}

async function addDriver(name) {
  const rec={id:crypto.randomUUID(),name,created_at:new Date().toISOString()};
  DRIVERS.push(rec); await sb.from('drivers').insert({id:rec.id,name,created_at:rec.created_at}); return rec;
}
async function updateDriver(id,name) { DRIVERS=DRIVERS.map(d=>d.id===id?{...d,name}:d); await sb.from('drivers').update({name}).eq('id',id); }
async function toggleDriverVacation(id,onVacation){ DRIVERS=DRIVERS.map(d=>d.id===id?{...d,on_vacation:onVacation}:d); await sb.from('drivers').update({on_vacation:onVacation}).eq('id',id); render(); }
async function deleteDriver(id) {
  DRIVERS=DRIVERS.filter(d=>d.id!==id); DOT_INSPECTIONS=DOT_INSPECTIONS.map(r=>r.driverId===id?{...r,driverId:null}:r); MILEAGE=MILEAGE.filter(r=>r.driverId!==id);
  await sb.from('drivers').delete().eq('id',id);
}
async function addVehicle(truckNumber,trailerNumber,assignedDriverId,assignedDispatcher,annualExpiry) {
  const rec={id:crypto.randomUUID(),truckNumber,trailerNumber,assignedDriverId:assignedDriverId||null,assignedDispatcher:assignedDispatcher||'',annualExpiry:annualExpiry||null,created_at:new Date().toISOString()};
  const row={id:rec.id,truck_number:truckNumber,trailer_number:trailerNumber,assigned_driver_id:assignedDriverId||null,assigned_dispatcher:assignedDispatcher||'',created_at:rec.created_at};
  // Only send the column when migration 012 has landed — including it earlier
  // would fail the whole insert and block adding trucks entirely.
  if(ANNUAL_AVAILABLE&&annualExpiry) row.annual_inspection_expiry=annualExpiry;
  VEHICLES.push(rec); await sb.from('vehicles').insert(row); return rec;
}
async function updateVehicle(id,truckNumber,trailerNumber,assignedDriverId,assignedDispatcher) {
  VEHICLES=VEHICLES.map(v=>v.id===id?{...v,truckNumber,trailerNumber,assignedDriverId:assignedDriverId||null,assignedDispatcher:assignedDispatcher||''}:v);
  await sb.from('vehicles').update({truck_number:truckNumber,trailer_number:trailerNumber,assigned_driver_id:assignedDriverId||null,assigned_dispatcher:assignedDispatcher||''}).eq('id',id);
}
async function deleteVehicle(id) {
  VEHICLES=VEHICLES.filter(v=>v.id!==id); MAINTENANCE=MAINTENANCE.filter(r=>r.vehicleId!==id); BRAKE_TESTS=BRAKE_TESTS.filter(r=>r.vehicleId!==id);
  TYRE_RECORDS=TYRE_RECORDS.filter(r=>r.vehicleId!==id); DOT_INSPECTIONS=DOT_INSPECTIONS.filter(r=>r.vehicleId!==id); MILEAGE=MILEAGE.filter(r=>r.vehicleId!==id); SERVICE_RECORDS=SERVICE_RECORDS.filter(r=>r.vehicleId!==id);
  await Promise.all([sb.from('vehicles').delete().eq('id',id),sb.from('maintenance_records').delete().eq('vehicle_id',id),sb.from('brake_tests').delete().eq('vehicle_id',id),sb.from('tyre_records').delete().eq('vehicle_id',id),sb.from('dot_inspections').delete().eq('vehicle_id',id),sb.from('mileage_records').delete().eq('vehicle_id',id),sb.from('service_records').delete().eq('vehicle_id',id)]);
}
async function addMaintenance(vehicleId,serviceDate,notes) {
  const next=new Date(serviceDate); next.setDate(next.getDate()+60);
  const rec={id:crypto.randomUUID(),vehicleId,serviceDate,nextInspectionDate:next.toISOString().split('T')[0],notes:notes||null};
  MAINTENANCE.push(rec); await sb.from('maintenance_records').insert({id:rec.id,vehicle_id:vehicleId,service_date:serviceDate,next_inspection_date:rec.nextInspectionDate,notes:notes||null});
}
async function deleteMaintenance(id) { MAINTENANCE=MAINTENANCE.filter(r=>r.id!==id); await sb.from('maintenance_records').delete().eq('id',id); }
async function addBrakeTest(vehicleId,testDate,result,notes) {
  const rec={id:crypto.randomUUID(),vehicleId,testDate,result,notes:notes||null};
  BRAKE_TESTS.push(rec); await sb.from('brake_tests').insert({id:rec.id,vehicle_id:vehicleId,test_date:testDate,result,notes:notes||null});
}
async function deleteBrakeTest(id) { BRAKE_TESTS=BRAKE_TESTS.filter(r=>r.id!==id); await sb.from('brake_tests').delete().eq('id',id); }
async function addTyreRecord(vehicleId,photoDate,readings) {
  const rec={id:crypto.randomUUID(),vehicleId,photoDate,readings};
  TYRE_RECORDS.push(rec); await sb.from('tyre_records').insert({id:rec.id,vehicle_id:vehicleId,photo_date:photoDate,readings});
}
async function deleteTyreRecord(id) { TYRE_RECORDS=TYRE_RECORDS.filter(r=>r.id!==id); await sb.from('tyre_records').delete().eq('id',id); }
async function addServiceRecord(vehicleId,serviceDate,result,notes) {
  const rec={id:crypto.randomUUID(),vehicleId,serviceDate,result,notes:notes||null};
  SERVICE_RECORDS.push(rec); await sb.from('service_records').insert({id:rec.id,vehicle_id:vehicleId,service_date:serviceDate,result,notes:notes||null});
}
async function deleteServiceRecord(id) { SERVICE_RECORDS=SERVICE_RECORDS.filter(r=>r.id!==id); await sb.from('service_records').delete().eq('id',id); }
async function addDOTInspection(vehicleId,driverId,inspectionDate,result,notes) {
  const rec={id:crypto.randomUUID(),vehicleId,driverId:driverId||null,inspectionDate,result,notes:notes||null};
  DOT_INSPECTIONS.push(rec); await sb.from('dot_inspections').insert({id:rec.id,vehicle_id:vehicleId,driver_id:driverId||null,inspection_date:inspectionDate,result,notes:notes||null});
}
async function deleteDOTInspection(id) { DOT_INSPECTIONS=DOT_INSPECTIONS.filter(r=>r.id!==id); await sb.from('dot_inspections').delete().eq('id',id); }
async function addMileage(vehicleId,driverId,mileage) {
  const rec={id:crypto.randomUUID(),vehicleId,driverId,mileage,date:new Date().toISOString().split('T')[0]};
  MILEAGE.push(rec); await sb.from('mileage_records').insert({id:rec.id,vehicle_id:vehicleId,driver_id:driverId,mileage,date:rec.date});
}
async function loadAllUsers() {
  if(!sb||!isAdmin()) return [];
  const {data}=await sb.from('user_activity').select('id,email,role,last_sign_in_at,banned_at');
  return data||[];
}
function fmtCSTDate(iso){
  if(!iso) return {date:'—',time:'—',status:'none'};
  const d=new Date(iso);
  const now=new Date();
  const diffDays=Math.floor((now-d)/(1000*60*60*24));
  const date=d.toLocaleDateString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric'});
  const time=d.toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',hour12:true});
  const status=diffDays===0?'today':diffDays<=7?'week':'old';
  return{date,time,status};
}
async function updateUserRole(userId,role) { await sb.from('profiles').update({role}).eq('id',userId); }

// ═══════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════
const AXLES=[
  {name:'Steer Axle',sides:['left','right']},
  {name:'Drive Axle 1',sides:['left-outer','left-inner','right-inner','right-outer']},
  {name:'Drive Axle 2',sides:['left-outer','left-inner','right-inner','right-outer']},
  {name:'Trailer Axle 1',sides:['left-outer','left-inner','right-inner','right-outer']},
  {name:'Trailer Axle 2',sides:['left-outer','left-inner','right-inner','right-outer']},
];
function daysBetween(a,b){if(a==null||b==null||a===''||b==='')return null;function toLocal(d){var s=String(d).split('T')[0];var p=s.split('-');if(p.length!==3||isNaN(+p[0])||isNaN(+p[1])||isNaN(+p[2]))return new Date('invalid');return new Date(+p[0],+p[1]-1,+p[2]);}var diff=toLocal(b)-toLocal(a);if(isNaN(diff))return null;return Math.round(diff/86400000);}
function fmtDate(s){if(!s)return'—';return new Date(s).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});}
function today(){return new Date().toISOString().split('T')[0];}
function dispatcherNotice(){return`<div class="dispatcher-notice">👁 View only — contact an admin to make changes</div>`;}

function getVehicleStatus(vid){
  const brakes=BRAKE_TESTS.filter(b=>b.vehicleId===vid).sort((a,b)=>b.testDate.localeCompare(a.testDate));
  const tyres=TYRE_RECORDS.filter(t=>t.vehicleId===vid).sort((a,b)=>b.photoDate.localeCompare(a.photoDate));
  const maint=MAINTENANCE.filter(m=>m.vehicleId===vid).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
  const dots=DOT_INSPECTIONS.filter(d=>d.vehicleId===vid).sort((a,b)=>b.inspectionDate.localeCompare(a.inspectionDate));
  const svcs=SERVICE_RECORDS.filter(s=>s.vehicleId===vid).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
  const preTrips=INSPECTIONS.filter(i=>i.vehicleId===vid).sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')));
  const lastBrake=brakes[0],lastTyre=tyres[0],lastDot=dots[0],lastService=svcs[0],lastPreTrip=preTrips[0];
  const now=today();
  const brakeDays=lastBrake?daysBetween(lastBrake.testDate,now):null;
  const tyreDays=lastTyre?daysBetween(lastTyre.photoDate,now):null;
  // FIX: fall back to maintenance record date if no service_records entry exists
  const lastMaint=maint[0];
  const serviceRefDate=lastService?.serviceDate||lastMaint?.serviceDate||null;
  const serviceDays=serviceRefDate?daysBetween(serviceRefDate,now):null;
  // Thresholds come from reminder_schedules when this vehicle has its own row, else the
  // fleet defaults in SCHED_DEFAULTS (42/60/7) — identical to the previous hardcoded values.
  // Tyres stay on the weekly default so the card matches the SMS reminder bot (2026-07-03).
  const bSch=vehSched(vid,'brake_service'),sSch=vehSched(vid,'dot_inspection'),tSch=vehSched(vid,'tyre_check');
  const brakeOverdue=brakeDays>bSch.interval,brakeDueSoon=brakeDays>bSch.interval-bSch.warn&&!brakeOverdue,tyreOverdue=tyreDays>=tSch.interval;
  const serviceOverdue=serviceDays>sSch.interval,serviceDueSoon=serviceDays>sSch.interval-sSch.warn&&!serviceOverdue;
  // Removed 2026-08-18: the maintenance record's next_inspection_date (baked as
  // service+60 at creation) duplicated the yard/periodic cadence and contradicted
  // the 90-day Service pill (serviceDays vs sSch.interval), flagging green trucks
  // as Warning. The Service pill is now the single source of truth; the stored
  // next_inspection_date remains as info in the Service history only.
  const hasOOS=lastDot&&lastDot.result==='oos';
  const viciousCircle=maint.some(m=>!brakes.find(b=>b.testDate===m.serviceDate));
  // An unresolved pre-trip defect makes the truck critical: the driver reported
  // it, the record is signed and GPS-stamped, so dispatching on green would be
  // indefensible. 'minor' is proportionate — a warning, not a stop.
  // Annual DOT certificate. daysBetween(from,to) counts forward, so expiry->today
  // is positive once it has lapsed and negative while it is still valid.
  const _veh=VEHICLES.find(x=>x.id===vid);
  const annualExpiry=_veh?.annualExpiry||null;
  const annualDaysLeft=annualExpiry?-daysBetween(annualExpiry,now):null;
  const annualExpired=annualDaysLeft!==null&&annualDaysLeft<0;
  const annualDueSoon=annualDaysLeft!==null&&annualDaysLeft>=0&&annualDaysLeft<=ANNUAL_WARN_DAYS;

  const openDefect=openDefectFor(vid);
  const defectCritical=!!openDefect&&openDefect.overallResult==='defect';
  const defectMinor   =!!openDefect&&openDefect.overallResult==='minor';
  // An expired annual certificate is an out-of-service item at roadside, so it
  // is critical. Approaching expiry is a warning — there is still time to book.
  const critical=brakeOverdue||serviceOverdue||defectCritical||annualExpired,warning=brakeDueSoon||tyreOverdue||viciousCircle||defectMinor||annualDueSoon; // OOS is a silent record now — never drives critical/red (2026-07-01)
  return{lastBrake,lastTyre,lastDot,lastService,maint:maint[0],brakeDays,tyreDays,serviceDays,brakeOverdue,brakeDueSoon,tyreOverdue,serviceOverdue,serviceDueSoon,hasOOS,viciousCircle:viciousCircle&&maint.length>0,critical,warning,lastPreTrip,preTripToday:!!(lastPreTrip&&String(lastPreTrip.submittedAt||'').split('T')[0]===now),
    brakeInterval:bSch.interval,serviceInterval:sSch.interval,tyreInterval:tSch.interval,customSchedule:bSch.custom||sSch.custom||tSch.custom,newTruck:onNewTruckLadder(vid),
    openDefect,defectCritical,defectMinor,
    annualExpiry,annualDaysLeft,annualExpired,annualDueSoon};
}

// ═══════════════════════════════════════════════════════
// PRE-TRIP INSPECTIONS (driver portal results)
// ═══════════════════════════════════════════════════════
const DRIVER_FN_BASE='https://tmpdsiuadafbkmldvlki.supabase.co/functions/v1';
// A pre-trip defect stays OPEN until someone explicitly repairs or defers it.
// repair_status is absent on rows written before migration 011 and on every new
// submission, so NULL must read as open — anything else would silently treat an
// untouched defect as resolved.
function isOpenDefect(r){
  if(!REPAIRS_AVAILABLE) return false;   // migration 011 not applied yet
  return (r.overallResult==='defect'||r.overallResult==='minor')
      && (r.repairStatus==null||r.repairStatus==='open');
}
// Newest unresolved pre-trip defect for a vehicle, or null.
function openDefectFor(vehicleId){
  return INSPECTIONS
    .filter(r=>r.vehicleId===vehicleId&&isOpenDefect(r))
    .sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')))[0]||null;
}

// Annual DOT certificate pill. Renders nothing at all until migration 012 is
// applied. A vehicle with no date recorded shows grey "not set" — an unknown
// expiry must never read as green, since that is the state an officer fines.
function annualPill(s,compact){
  if(!ANNUAL_AVAILABLE) return '';
  const sz=compact?' style="font-size:9px"':'';
  if(!s.annualExpiry) return `<span class="status-pill badge-gray"${sz} title="Annual DOT inspection expiry not recorded">📅 Annual ${compact?'—':'not set'}</span>`;
  const d=s.annualDaysLeft;
  const cls=s.annualExpired||d<=ANNUAL_CRIT_DAYS?'badge-red':d<=ANNUAL_WARN_DAYS?'badge-yellow':'badge-green';
  const txt=s.annualExpired?`EXPIRED ${Math.abs(d)}d`:`${d}d`;
  return `<span class="status-pill ${cls}"${sz} title="Annual DOT inspection expires ${fmtDate(s.annualExpiry)}">📅 ${compact?'':'Annual '}${txt}</span>`;
}

function inspDur(s){ if(s==null) return '—'; const m=Math.floor(s/60),x=s%60; return m+'m '+(x<10?'0':'')+x+'s'; }
function inspDT(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }

function renderInspections(){
  const rows=INSPECTIONS.slice().sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')));
  const todayStr=today();
  const todayCount=rows.filter(i=>String(i.submittedAt||'').split('T')[0]===todayStr).length;
  const defectCount=rows.filter(i=>i.overallResult==='defect').length;
  const openRows=rows.filter(isOpenDefect);

  // v2 components against live data. Styles: v2-tokens + v2-bridge +
  // v2-inspections.css (+ v2-vehicles.css for the field/select controls).
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    pulse:'<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    wrench:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
    user:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    alert:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
    check:'<path d="m5 12 5 5L20 7"/>',
    list:'<path d="M9 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/>',
  };

  let html='<div class="v2-region">';


  html+='<div class="v2-page-head"><h1>Pre-Trip Inspections</h1>'
    +'<p>Driver walk-around submissions, and the defects still waiting on a repair.</p></div>';

  // ── Tier 1: pulse counters + send console ────────────────────────────────
  // The console leads, matching v2/inspections.html. It answers "what is the
  // state of the fleet today" before the page shows individual faults, and it
  // is where the only controls on the page live.
  html+='<section class="v2-console-row" aria-label="Inspection console">';
  html+='<article class="v2-console v2-accent-cyan"><div class="v2-console-head">'
    +'<span class="v2-console-ic">'+_sv(_IC.pulse)+'</span><h2>Live inspection pulse</h2></div>'
    +'<div class="v2-console-body"><div class="v2-pulse-grid">'
      +'<div class="v2-pulse-stat v2-accent-cyan"><span class="v2-pulse-num">'+rows.length+'</span><span class="v2-pulse-label">Total</span></div>'
      +'<div class="v2-pulse-stat '+(todayCount?'v2-accent-green':'v2-accent-blue')+'"><span class="v2-pulse-num">'+todayCount+'</span><span class="v2-pulse-label">Today</span></div>'
      +'<div class="v2-pulse-stat '+(openRows.length?'v2-accent-red':'v2-accent-green')+'"><span class="v2-pulse-num">'+openRows.length+'</span><span class="v2-pulse-label">Unrepaired</span></div>'
      +'<div class="v2-pulse-stat '+(defectCount?'v2-accent-red':'v2-accent-green')+'"><span class="v2-pulse-num">'+defectCount+'</span><span class="v2-pulse-label">With defects</span></div>'
    +'</div></div></article>';

  if(isAdmin()){
    const opts=VEHICLES.filter(v=>v.assignedDriverId).map(v=>{
      const d=DRIVERS.find(x=>x.id===v.assignedDriverId);
      return '<option value="'+v.id+'">Truck #'+esc(v.truckNumber)+(d?' &middot; '+esc(d.name):'')+'</option>';
    }).join('');
    html+='<article class="v2-console v2-accent-primary"><div class="v2-console-head">'
      +'<span class="v2-console-ic">'+_sv(_IC.send)+'</span><h2>Send PTI link</h2>'
      +'<span class="v2-console-note">Admin only</span></div>'
      +'<div class="v2-console-body"><div class="v2-send-row">'
        +'<div class="v2-field"><label for="sl-vehicle">Send pre-trip link to a driver</label>'
        +'<span class="v2-select-wrap"><select class="v2-select" id="sl-vehicle">'
        +'<option value="">&mdash; select truck &mdash;</option>'+opts+'</select>'
        +_sv('<path d="m6 9 6 6 6-6"/>','1.8')+'</span></div>'
        +'<button class="v2-btn-send" type="button" onclick="doSendLinkFromPicker()">'+_sv(_IC.send,'2')+'Send link</button>'
      +'</div>'
      +'<div style="display:flex;gap:var(--v2-s3);align-items:center;flex-wrap:wrap;margin-top:var(--v2-s4)">'
        +'<button id="pti-bulk-btn" class="v2-btn-ghost" type="button" onclick="doBulkSendAll()">'+_sv(_IC.send,'1.8')+'Send PTI link to ALL drivers</button>'
        // loadPtiQueueStatus() writes innerHTML here, including its own
        // Cancel-pending button, so the element must keep this exact id.
        +'<span class="v2-console-note" id="pti-queue-status" style="text-transform:none;letter-spacing:0"></span>'
      +'</div>'
      +'<p class="v2-send-notice">Links are sent only when you click here &mdash; never automatically. Bulk sends go out in waves of 5 every 5 minutes.</p>'
      +'</div></article>';
    setTimeout(loadPtiQueueStatus,50);
  }
  html+='</section>';

  // ── Tier 2: open defects ─────────────────────────────────────────────────
  // An unrepaired defect is the only thing here that needs action today, and
  // it is what the CSA driver-observed category is scored on.
  if(openRows.length){
    html+='<section class="v2-defect-grid" aria-label="Open defects">';
    openRows.forEach(r=>{
      const dName=DRIVERS.find(d=>d.id===r.driverId)?.name;
      const ageDays=r.submittedAt?daysBetween(String(r.submittedAt).split('T')[0],today()):null;
      const flags=[];
      if(r.tyresFlagged) flags.push(r.tyresFlagged+' tyre'+(r.tyresFlagged>1?'s':''));
      if(r.checksFailed) flags.push(r.checksFailed+' check'+(r.checksFailed>1?'s':''));
      const isDefect=r.overallResult==='defect';
      html+='<article class="v2-defect '+(isDefect?'v2-accent-red':'v2-accent-amber')+'">'
        +'<div class="v2-defect-head"><span class="v2-defect-id">'
          +'<span class="v2-defect-truck">Truck #'+esc(r.truckNumber||'—')+'</span>'
          +'<span class="v2-defect-when">Reported '+inspDT(r.submittedAt)+'</span>'
        +'</span><span class="v2-chip-status '+(isDefect?'is-defect':'is-minor')+'">'+(isDefect?'Defect':'Minor')+'</span></div>'
        +'<div class="v2-defect-meta">'
          +'<span class="v2-defect-line">'+_sv(_IC.user)+(dName?esc(dName):'&mdash;')+'</span>'
          +'<span class="v2-defect-line">'+_sv(_IC.alert)+'<span class="v2-defect-issues">'+(flags.join(' &middot; ')||'&mdash;')+'</span></span>'
        +'</div>'
        +'<div class="v2-defect-foot">'
          // class AND data-insp both required: render() binds this by
          // querySelectorAll('.mark-repaired-btn') and reads dataset.insp.
          +(isAdmin()?'<button class="v2-btn-repair mark-repaired-btn" type="button" data-insp="'+esc(r.id)+'">'+_sv(_IC.check,'2.2')+'Mark repaired</button>':'')
          +(ageDays>0?'<span class="v2-chip-status is-flag">'+ageDays+'d open</span>':'')
        +'</div></article>';
    });
    html+='</section>';
  }

  // ── Tier 3: the full inspection stream ───────────────────────────────────
  html+='<section class="v2-table-card" aria-label="Pre-trip inspections">'
    +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.list)+'</span>'
    +'<h2>Driver pre-trip inspections</h2></div>'
    +'<div class="v2-table-wrap"><table class="v2-table"><thead><tr>'
    +'<th>When</th><th>Truck</th><th>Driver</th><th>Result</th><th>Tyres</th><th>Checks</th><th>Walk-around</th><th>Ref</th>'
    +'</tr></thead><tbody>';
  if(rows.length===0){
    html+='<tr><td colspan="8" style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No inspections yet.'
      +(isAdmin()?' Send a driver a link above to get the first one.':'')+'</td></tr>';
  }
  rows.slice(0,200).forEach(i=>{
    const d=DRIVERS.find(x=>x.id===i.driverId);
    const tone=i.overallResult==='defect'?'is-defect':i.overallResult==='minor'?'is-minor':'is-pass';
    const label=i.overallResult==='defect'?'Defect':i.overallResult==='minor'?'Minor':'Roadworthy';
    // renderInspections() has always flagged anything under 120s as suspiciously
    // quick. That threshold is separate from the driver score's 60/180 band.
    const quick=i.durationSec!=null&&i.durationSec<120;
    html+='<tr onclick="openInspection(\''+i.id+'\')" style="cursor:pointer" title="Open full inspection">'
      +'<td class="v2-td-when">'+inspDT(i.submittedAt)+'</td>'
      +'<td class="v2-td-truck">#'+esc(i.truckNumber||'')+'</td>'
      +'<td class="v2-td-driver">'+esc(d?d.name:'—')+'</td>'
      +'<td><span class="v2-chip-status '+tone+'">'+label+'</span></td>'
      +'<td>'+(i.tyresFlagged?'<span style="color:var(--v2-red-hi)">'+i.tyresFlagged+' flagged</span>':'<span style="color:var(--v2-green-hi)">OK</span>')+'</td>'
      +'<td>'+(i.checksFailed?'<span style="color:var(--v2-red-hi)">'+i.checksFailed+' failed</span>':'<span style="color:var(--v2-green-hi)">OK</span>')+'</td>'
      +'<td style="white-space:nowrap">'+inspDur(i.durationSec)+(quick?' <span title="Completed very quickly" style="color:var(--v2-amber-hi)">&#9888;</span>':'')+'</td>'
      +'<td class="v2-td-ref">'+esc(i.ref||'')+'</td>'
    +'</tr>';
  });
  html+='</tbody></table></div></section>';

  html+='</div>';
  return html;
}

async function doSendLink(driverId,vehicleId,truck){
  // admin OR dispatcher may send — server (driver-send-link) is the real gate. Governance updated 2026-07-01.
  if(!currentRole){ showToast('Sign in to send','danger'); return; }
  if(!driverId){ showToast('That truck has no assigned driver','danger'); return; }
  try{
    const { data:{ session } } = await sb.auth.getSession();
    const token=session&&session.access_token;
    if(!token){ showToast('Session expired — sign in again','danger'); return; }
    const r=await fetch(DRIVER_FN_BASE+'/driver-send-link',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({driverId,vehicleId:vehicleId||null})});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j.ok) showToast('Pre-trip link sent to '+(j.sentTo||'driver')+(truck?(' (Truck #'+truck+')'):''),'success');
    else showToast(j.error||('Send failed — HTTP '+r.status),'danger');
  }catch(e){ showToast('Send failed: '+((e&&e.message)||'network'),'danger'); }
}
// Texts the driver to route for PM service (oil change) at any TA or Love's.
// Confirmed first: this reaches a real phone, and an accidental click is a
// driver diverting to a truck stop for nothing.
async function doSendPM(driverId,vehicleId,truck){
  // Admin-only, matching driver-send-pm's server-side gate. This check is just
  // UX — the function rejects non-admins regardless of what the browser does.
  if(!isAdmin()){ showToast('Admins only','danger'); return; }
  if(!driverId){ showToast('That truck has no assigned driver','danger'); return; }
  const ok=await confirm2(
    `Text the driver about PM service${truck?` on Truck #${truck}`:''}?`,
    'Asks them to route to any TA or Love\'s for an oil change ASAP and send the receipt. Sends immediately, and records you as the sender.',
    '📲 Send PM text','btn btn-primary');
  if(!ok) return;
  try{
    const { data:{ session } } = await sb.auth.getSession();
    const token=session&&session.access_token;
    if(!token){ showToast('Session expired — sign in again','danger'); return; }
    const r=await fetch(DRIVER_FN_BASE+'/driver-send-pm',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({driverId,vehicleId:vehicleId||null})});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j.ok) showToast('PM request sent to '+(j.sentTo||'driver')+(truck?(' (Truck #'+truck+')'):''),'success');
    else showToast(j.error||('Send failed — HTTP '+r.status),'danger');
  }catch(e){ showToast('Send failed: '+((e&&e.message)||'network'),'danger'); }
}

async function doSendLinkFromPicker(){
  const sel=document.getElementById('sl-vehicle'); const vid=sel?sel.value:'';
  if(!vid){ showToast('Pick a truck first','danger'); return; }
  const v=VEHICLES.find(x=>x.id===vid);
  if(!v||!v.assignedDriverId){ showToast('That truck has no assigned driver','danger'); return; }
  doSendLink(v.assignedDriverId,vid,v.truckNumber);
}

// ── Bulk PTI rollout: preview → confirm → enqueue; bot drains 5/5min ──
async function ptiQueueCall(token,action){
  const r=await fetch(DRIVER_FN_BASE+'/pti-queue',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({action})});
  const j=await r.json().catch(()=>({}));
  return {httpOk:r.ok,status:r.status,...j};
}
async function doBulkSendAll(){
  if(!isAdmin()){ showToast('Admins only','danger'); return; }
  const btn=document.getElementById('pti-bulk-btn'); if(btn)btn.disabled=true;
  try{
    const { data:{ session } } = await sb.auth.getSession();
    const token=session&&session.access_token;
    if(!token){ showToast('Session expired — sign in again','danger'); return; }
    const p=await ptiQueueCall(token,'preview');
    if(!p.httpOk||!p.ok){ showToast(p.error||('Preview failed — HTTP '+p.status),'danger'); return; }
    if(!p.eligible){ showToast('No eligible drivers — everyone is covered or on hold','info'); return; }
    const s=p.skipped||{};
    const ok=await confirm2(`Queue PTI links for ${p.eligible} of ${p.total} drivers?`,
      `Skipped: ${s.recentPTI||0} inspected in last 3 days · ${s.linkSentRecently||0} got a link in last 24h · ${s.vacation||0} on vacation · ${s.smsHold||0} SMS hold · ${s.noPhone||0} no phone · ${s.noVehicle||0} no truck · ${s.alreadyQueued||0} already queued. Links go out 5 every 5 minutes (~${Math.ceil(p.eligible/5)*5} min total).`,
      '📨 Queue '+p.eligible+' links','btn btn-primary');
    if(!ok) return;
    const j=await ptiQueueCall(token,'enqueue');
    if(j.httpOk&&j.ok){ showToast(j.queued+' links queued — sending in waves of 5','success'); loadPtiQueueStatus(); }
    else showToast(j.error||'Enqueue failed','danger');
  }catch(e){ showToast('Bulk send failed: '+((e&&e.message)||'network'),'danger'); }
  finally{ if(btn)btn.disabled=false; }
}
async function doBulkCancel(){
  if(!isAdmin()) return;
  const ok=await confirm2('Cancel all pending PTI links?','Links already sent are not affected — only the ones still waiting in the queue.','Cancel pending','btn btn-danger');
  if(!ok) return;
  try{
    const { data:{ session } } = await sb.auth.getSession();
    const token=session&&session.access_token;
    if(!token){ showToast('Session expired — sign in again','danger'); return; }
    const j=await ptiQueueCall(token,'cancel');
    if(j.httpOk&&j.ok){ showToast(j.cancelled+' pending links cancelled','success'); loadPtiQueueStatus(); }
    else showToast(j.error||'Cancel failed','danger');
  }catch(e){ showToast('Cancel failed: '+((e&&e.message)||'network'),'danger'); }
}
async function loadPtiQueueStatus(){
  const el=document.getElementById('pti-queue-status'); if(!el||!sb||!isAdmin())return;
  try{
    // guarded if table missing (pre-migration) — same convention as INSPECTIONS
    const {data,error}=await sb.from('pti_send_queue').select('status');
    if(error||!data){ el.textContent=''; return; }
    const c={pending:0,sent:0,failed:0};
    data.forEach(r=>{ if(c[r.status]!=null)c[r.status]++; });
    el.innerHTML=(c.pending+c.sent+c.failed)===0?'':
      `Queue: <b>${c.pending}</b> pending · <b style="color:var(--success)">${c.sent}</b> sent`
      +(c.failed?` · <b style="color:var(--danger)">${c.failed} failed</b>`:'')
      +(c.pending?` <button class="btn btn-ghost btn-sm" style="margin-left:6px" onclick="doBulkCancel()">✕ Cancel pending</button>`:'');
  }catch(e){}
}

// ── Inspection detail view (click a row to open the full pre-trip) ──
const TYRE_POS_LABEL={left:'Left',right:'Right','left-outer':'Left Outer','left-inner':'Left Inner','right-inner':'Right Inner','right-outer':'Right Outer'};
async function openInspection(id){
  let d=null;
  try{
    const res=await sb.from('inspections')
      .select('id,ref,truck_number,trailer_number,driver_id,vehicle_id,started_at,submitted_at,duration_sec,odometer,gps_lat,gps_lng,gps_accuracy,overall_result,tyres_flagged,checks_failed,signature_url,notes,details')
      .eq('id',id).maybeSingle();
    if(res.error||!res.data){ showToast('Could not load inspection','danger'); return; }
    d=res.data;
  }catch(e){ showToast('Could not load inspection','danger'); return; }
  // private photos/signature → short-lived signed URLs
  const paths=[];
  if(d.signature_url) paths.push(d.signature_url);
  ((d.details&&d.details.tyres)||[]).forEach(t=>{ if(t.photoUrl) paths.push(t.photoUrl); });
  ((d.details&&d.details.checks)||[]).forEach(c=>{ if(c.photoUrl) paths.push(c.photoUrl); });
  const signed={};
  if(paths.length){
    try{
      const { data:urls }=await sb.storage.from('inspection-photos').createSignedUrls(paths,3600);
      (urls||[]).forEach(u=>{ if(u&&u.signedUrl&&!u.error) signed[u.path]=u.signedUrl; });
    }catch(e){ /* photos just won't show */ }
  }
  renderInspectionModal(d,signed);
}
function inspThumb(path,signed){
  if(!path||!signed[path]) return '';
  return `<a href="${signed[path]}" target="_blank" rel="noopener" title="Open full image"><img src="${signed[path]}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--border);vertical-align:middle"/></a>`;
}
function renderInspectionModal(d,signed){
  const tyres=(d.details&&d.details.tyres)||[];
  let tyreHtml='';
  AXLES.forEach((axle,ai)=>{
    const rows=axle.sides.map(pos=>{
      const t=tyres.find(x=>x.axleIndex===ai&&x.position===pos)||{};
      const tread=t.rating==='fail'?'<span style="color:var(--danger);font-weight:700">Fail</span>':t.rating==='pass'?'<span style="color:var(--success)">Pass</span>':'<span class="text-sm">—</span>';
      const pres=t.pressure==='low'?'<span style="color:var(--warning);font-weight:700">Low</span>':t.pressure==='good'?'<span style="color:var(--success)">Good</span>':'<span class="text-sm">—</span>';
      return `<tr><td style="padding:3px 8px">${TYRE_POS_LABEL[pos]||esc(pos)}</td><td style="padding:3px 8px">${tread}</td><td style="padding:3px 8px">${pres}</td><td style="padding:3px 8px;text-align:right">${inspThumb(t.photoUrl,signed)}</td></tr>`;
    }).join('');
    tyreHtml+=`<div style="font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin:10px 0 2px">${esc(axle.name)}</div><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>`;
  });
  const checks=(d.details&&d.details.checks)||[];
  const checkHtml=checks.length?checks.map(c=>{
    const r=c.result==='fail'?'<span class="badge badge-red">Fail</span>':c.result==='pass'?'<span class="badge badge-green">Pass</span>':c.result==='na'?'<span class="badge badge-gray">N/A</span>':'<span class="text-sm">—</span>';
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><strong>${esc(c.label||c.id||'')}</strong><span>${r}${c.severity?` <span class="badge badge-yellow">${esc(c.severity)}</span>`:''}</span></div>${c.note?`<div class="text-sm" style="margin-top:4px">${esc(c.note)}</div>`:''}${inspThumb(c.photoUrl,signed)?`<div style="margin-top:6px">${inspThumb(c.photoUrl,signed)}</div>`:''}</div>`;
  }).join(''):'<div class="text-sm">No checks recorded</div>';
  const sig=d.signature_url&&signed[d.signature_url]?`<img src="${signed[d.signature_url]}" style="max-width:280px;width:100%;background:#fff;border-radius:8px;border:1px solid var(--border)"/>`:'<span class="text-sm">— not captured —</span>';
  const gps=(d.gps_lat&&d.gps_lng)?`<a href="https://maps.google.com/?q=${d.gps_lat},${d.gps_lng}" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:none">📍 ${(+d.gps_lat).toFixed(5)}, ${(+d.gps_lng).toFixed(5)}</a>`:'—';
  const drv=DRIVERS.find(x=>x.id===d.driver_id);
  const rb=d.overall_result==='defect'?'badge-red':d.overall_result==='minor'?'badge-yellow':'badge-green';
  const dur=d.duration_sec!=null?(Math.floor(d.duration_sec/60)+'m '+String(d.duration_sec%60).padStart(2,'0')+'s'):'—';
  const quick=d.duration_sec!=null&&d.duration_sec<120;
  const hdr=(t)=>`<div class="card-header" style="padding:14px 0 6px"><span class="card-header-accent"></span>${t}</div>`;
  const html=`<div class="modal-overlay" id="insp-modal" onclick="if(event.target===this)closeInspectionModal()">
    <div class="modal" style="max-width:680px">
      <div class="modal-header"><span>📋 Pre-Trip · ${esc(d.ref||'')}</span><button class="btn btn-ghost btn-sm" onclick="closeInspectionModal()" style="font-size:18px;line-height:1;padding:2px 9px">×</button></div>
      <div class="modal-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px 16px;font-size:13px;margin-bottom:6px">
          <div><span class="text-sm">Truck</span><br><strong>#${esc(d.truck_number||'—')}${d.trailer_number?' · '+esc(d.trailer_number):''}</strong></div>
          <div><span class="text-sm">Driver</span><br><strong>${esc(drv?drv.name:'—')}</strong></div>
          <div><span class="text-sm">Result</span><br><span class="badge ${rb}">${esc(d.overall_result||'')}</span></div>
          <div><span class="text-sm">Submitted</span><br><strong>${inspDT(d.submitted_at)}</strong></div>
          <div><span class="text-sm">Odometer</span><br><strong>${d.odometer?Number(d.odometer).toLocaleString():'—'}</strong></div>
          <div><span class="text-sm">Walk-around</span><br><strong>${dur}</strong>${quick?' <span style="color:var(--warning)" title="Completed very quickly — verify it was a real walk-around">⚠</span>':''}</div>
          <div style="grid-column:1/-1"><span class="text-sm">Location</span><br>${gps}</div>
        </div>
        ${hdr('Tyres — tread / pressure')}
        ${tyreHtml}
        ${hdr('Safety checks')}
        ${checkHtml}
        ${hdr('Driver signature')}
        ${sig}
        ${d.notes?hdr('Driver notes')+`<div class="text-sm">${esc(d.notes)}</div>`:''}
      </div>
    </div></div>`;
  closeInspectionModal();
  const tmp=document.createElement('div'); tmp.innerHTML=html;
  if(tmp.firstElementChild) document.body.appendChild(tmp.firstElementChild);
}
function closeInspectionModal(){ const m=document.getElementById('insp-modal'); if(m) m.remove(); }

// ═══════════════════════════════════════════════════════
// ROUTING
// ═══════════════════════════════════════════════════════
let currentPage='dashboard',currentVehicleId=null,currentVehicleTab='maintenance';
let currentDispatcherFilter=null;
let calendarMonth=new Date(); calendarMonth.setDate(1);
const PAGE_TITLES={dashboard:'Dashboard',vehicles:'Vehicles',drivers:'Drivers',calendar:'Calendar',reports:'Reports',inspections:'Pre-Trip Inspections',portal:'Driver Portal',vehicle:'Vehicle Detail',users:'User Management','dispatcher-board':'Dispatch Board',reminders:'Reminders',guides:'Guides'};

// ── Navigation state persistence ──
// Remember where the user was so a manual refresh doesn't dump them back on the
// Dashboard. Saved on every render, restored once after data has loaded.
const NAV_KEY='fg_nav_v1';
function saveNavState(){
  try{
    localStorage.setItem(NAV_KEY,JSON.stringify({
      page:currentPage,
      vehicleId:currentVehicleId,
      vehicleTab:currentVehicleTab,
      dispatcherFilter:currentDispatcherFilter,
    }));
  }catch(e){}
}
function restoreNavState(){
  try{
    const raw=localStorage.getItem(NAV_KEY); if(!raw) return;
    const s=JSON.parse(raw)||{};
    if(PAGE_TITLES[s.page]) currentPage=s.page;
    currentVehicleId=s.vehicleId||null;
    if(s.vehicleTab) currentVehicleTab=s.vehicleTab;
    currentDispatcherFilter=s.dispatcherFilter||null;
    // Drop views the current role can't open, or a vehicle that no longer exists.
    if(['vehicles','drivers','reminders'].includes(currentPage)&&!isAdmin()) currentPage='dashboard';
    if(currentPage==='vehicle'&&!VEHICLES.some(v=>v.id===currentVehicleId)){ currentPage='dashboard'; currentVehicleId=null; }
  }catch(e){}
}
function syncNavChrome(){
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  const navEl=document.getElementById('nav-'+currentPage);
  if(navEl) navEl.classList.add('active');
  const t=document.getElementById('page-title');
  if(t) t.textContent=PAGE_TITLES[currentPage]||currentPage;
}

function navigate(page,vehicleId){
  if(page==='users') return;    // Users page hidden for everyone
  if(page==='portal') return;   // Driver Portal hidden for everyone
  if(page==='reminders'&&!isAdmin()) return;
  // Dispatchers may only see Dashboard, Calendar, Reports, Dispatch Board
  if((page==='vehicles'||page==='drivers')&&!isAdmin()) return;
  if(page!=='dispatcher-board') currentDispatcherFilter=null;
  currentPage=page; currentVehicleId=vehicleId||null;
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  const navEl=document.getElementById('nav-'+page);
  if(navEl) navEl.classList.add('active');
  document.getElementById('page-title').textContent=PAGE_TITLES[page]||page;
  render();
}

function render(){
  const c=document.getElementById('content');
  // Users + Driver Portal hidden for everyone — redirect to dashboard
  if(currentPage==='users'||currentPage==='portal') currentPage='dashboard';
  // Dispatchers may not open Vehicles list or Drivers — redirect
  if(!isAdmin()&&(currentPage==='vehicles'||currentPage==='drivers')) currentPage='dashboard';
  if(currentPage==='dashboard') c.innerHTML=renderDashboard();
  else if(currentPage==='vehicles') c.innerHTML=renderVehicles();
  else if(currentPage==='vehicle') c.innerHTML=renderVehicleDetail();
  else if(currentPage==='drivers') c.innerHTML=renderDrivers();
  else if(currentPage==='calendar') c.innerHTML=renderCalendar();
  else if(currentPage==='reports') c.innerHTML=renderReports();
  else if(currentPage==='inspections') c.innerHTML=renderInspections();
  else if(currentPage==='portal'&&currentRole!=='dispatcher') c.innerHTML=renderPortal();
  else if(currentPage==='users') renderUsersAsync();
  else if(currentPage==='dispatcher-board') c.innerHTML=renderDispatcherBoard();
  else if(currentPage==='reminders'&&isAdmin()){loadReminders().then(()=>{c.innerHTML=renderReminders();});}
  // Guides was a standalone document opened in a new tab. It renders in-app
  // now; the weather tile fills itself in afterwards, and the filter is
  // re-applied so a category survives leaving the page and coming back.
  else if(currentPage==='guides'){ c.innerHTML=renderGuides(); guidesFilter(); guidesLoadWeather(); }
  // Bound after every render: the button lives in markup rebuilt each time.
  // data-* + addEventListener rather than an inline onclick, so ids never reach
  // a JS string context.
  document.querySelectorAll('.mark-repaired-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{e.stopPropagation();doMarkRepaired(btn.dataset.insp);});
  });
  const usersNav=document.getElementById('nav-users');
  if(usersNav) usersNav.style.display='none';       // Users hidden for everyone
  const remindersNav=document.getElementById('nav-reminders');
  if(remindersNav) remindersNav.style.display=isAdmin()?'flex':'none';
  const portalNav=document.getElementById('nav-portal');
  if(portalNav) portalNav.style.display='none';     // Driver Portal hidden for everyone
  // Vehicles + Drivers: admin only (dispatchers see Dashboard/Calendar/Reports/Dispatch Board)
  const vehiclesNav=document.getElementById('nav-vehicles');
  if(vehiclesNav) vehiclesNav.style.display=isAdmin()?'flex':'none';
  const driversNav=document.getElementById('nav-drivers');
  if(driversNav) driversNav.style.display=isAdmin()?'flex':'none';
  saveNavState();
}

async function renderUsersAsync(){
  document.getElementById('content').innerHTML=await renderUsers();
  document.querySelectorAll('.del-user-btn').forEach(btn=>{
    btn.addEventListener('click',()=>doDeleteUser(btn.dataset.uid, btn.dataset.email));
  });
}

// ═══════════════════════════════════════════════════════
// DISPATCHER BOARD
// ═══════════════════════════════════════════════════════
function renderDispatcherBoard(){
  // v2 components against live data. Styles: v2-dispatch.css + v2-filter.css
  // (+ v2-shell.css for .v2-page-head / .v2-sr-only).
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.8')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    truck:'<path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l3 3v5h-2"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    arrow:'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    back:'<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
  };
  const _ini=n=>String(n||'').trim().split(/\s+/).map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'?';

  const names=[...new Set(VEHICLES.map(v=>v.assignedDispatcher).filter(n=>n&&n.trim()!=''))].sort();
  const unassigned=VEHICLES.filter(v=>!v.assignedDispatcher||v.assignedDispatcher.trim()==='');
  const _vacSet=new Set(DRIVERS.filter(d=>d.on_vacation).map(d=>d.id));

  // One status strip, used by both views. The tone words come straight from
  // getVehicleStatus(); nothing here recomputes compliance.
  // Titles spell out what the letter and the number mean — production showed a
  // bare emoji and "34d", which reads like a countdown when it is days ELAPSED.
  const _strip=s=>{
    const cell=(k,tone,val,title)=>'<span class="v2-sp '+tone+'" title="'+esc(title)+'"><span class="v2-sp-k">'+k+'</span><span class="v2-sp-v">'+val+'</span></span>';
    const d=n=>n!==null&&n!==undefined?n+'d':'&mdash;';
    const bTone=s.brakeOverdue?'is-crit':s.brakeDueSoon?'is-warn':'is-ok';
    const tTone=s.tyreOverdue?'is-warn':'is-ok';
    const sTone=s.serviceOverdue?'is-crit':s.serviceDueSoon?'is-warn':'is-ok';
    return '<span class="v2-strip">'
      +cell('B',bTone,d(s.brakeDays),'Brakes — '+(s.brakeDays!==null?s.brakeDays+' days since last test':'no test on file')+(s.brakeOverdue?': OVERDUE':s.brakeDueSoon?': due soon':': in date'))
      +cell('T',tTone,d(s.tyreDays),'Tyres — '+(s.tyreDays!==null?s.tyreDays+' days since last check':'no check on file')+(s.tyreOverdue?': OVERDUE':': in date'))
      +cell('S',sTone,d(s.serviceDays),'Service — '+(s.serviceDays!==null?s.serviceDays+' days since last yard visit':'no visit on file')+(s.serviceOverdue?': OVERDUE':s.serviceDueSoon?': due soon':': in date'))
      +cell('P',s.preTripToday?'is-ok':'is-warn',s.preTripToday?'&check;':'&mdash;',s.preTripToday?'Pre-trip inspection filed today':'No pre-trip inspection today')
      +'</span>';
  };

  // ── FILTERED VIEW: one dispatcher's fleet ─────────────────────────────────
  if(currentDispatcherFilter!==null){
    const dispName=currentDispatcherFilter;
    const fleet=VEHICLES.filter(v=>v.assignedDispatcher===dispName);
    let html='<div class="v2-region">';
    html+='<div class="v2-page-head" style="display:flex;align-items:center;gap:var(--v2-s5);margin-bottom:var(--v2-s6)">'
      +'<button class="v2-btn-ghost" type="button" onclick="currentDispatcherFilter=null;render()">'
      +_sv(_IC.back,'2')+'All dispatchers</button>'
      +'<span style="display:flex;align-items:center;gap:var(--v2-s3)">'
        +'<span class="v2-disp-avatar">'+esc(_ini(dispName))+'</span>'
        +'<span class="v2-disp-id"><span class="v2-disp-name">'+esc(dispName)+'</span>'
        +'<span class="v2-disp-meta">'+fleet.length+' truck'+(fleet.length!==1?'s':'')+' assigned</span></span>'
      +'</span></div>';
    if(fleet.length===0){
      html+='<div class="v2-empty" style="padding:var(--v2-s10);text-align:center;color:var(--v2-ink-3)">No trucks assigned to '+esc(dispName)+'</div>';
      return html+'</div>';
    }
    html+='<div class="v2-board">';
    fleet.forEach(v=>{
      const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
      const isVac=_vacSet.has(v.assignedDriverId);
      if(isVac){
        html+='<article class="v2-disp-card" style="opacity:.6;cursor:pointer" onclick="navigate(\'vehicle\',\''+v.id+'\')">'
          +'<header class="v2-disp-head"><span class="v2-truck-ic">'+_sv(_IC.truck)+'</span>'
          +'<span class="v2-disp-id"><span class="v2-disp-name">Truck #'+esc(v.truckNumber)+'</span>'
          +'<span class="v2-disp-meta">Trailer #'+esc(v.trailerNumber||'—')+(driver?' &middot; '+esc(driver.name):'')+'</span></span>'
          +'<span class="v2-vac-tag">Vacation</span></header>'
          +'<div class="v2-disp-stats"><span class="v2-disp-meta">Frozen &mdash; no alerts while on vacation</span></div>'
          +'</article>';
        return;
      }
      const st=getVehicleStatus(v.id);
      const tone=st.critical?'is-crit':st.warning?'is-warn':'is-ok';
      const label=st.critical?'Critical':st.warning?'Warning':'OK';
      html+='<article class="v2-disp-card '+tone+'" style="cursor:pointer" onclick="navigate(\'vehicle\',\''+v.id+'\')">'
        +'<header class="v2-disp-head"><span class="v2-truck-ic">'+_sv(_IC.truck)+'</span>'
        +'<span class="v2-disp-id"><span class="v2-disp-name">Truck #'+esc(v.truckNumber)+'</span>'
        +'<span class="v2-disp-meta">Trailer #'+esc(v.trailerNumber||'—')+(driver?' &middot; '+esc(driver.name):'')+'</span></span>'
        +'<span class="v2-disp-chip '+tone+'">'+label+'</span></header>'
        +'<div class="v2-disp-stats">'+_strip(st)
          +'<div class="v2-disp-chips" style="margin-top:var(--v2-s3)">'
          +annualPill(st)
          +(st.openDefect?'<span class="v2-disp-chip '+(st.defectCritical?'is-crit':'is-warn')+'">'+(st.defectCritical?'Defect':'Minor')+' unrepaired</span>':'')
          +'</div></div></article>';
    });
    // Same handler and the same single-quote escape as before.
    if(isAdmin()) html+='<article class="v2-disp-card" style="cursor:pointer;min-height:150px;border:2px dashed var(--v2-line-strong);background:transparent;display:grid;place-items:center" onclick="openAddVehicleModal(\''+dispName.replace(/'/g,"\\'")+'\')">'
      +'<span style="text-align:center;color:var(--v2-ink-3);pointer-events:none">'+_sv(_IC.plus,'1.5')
      +'<span style="display:block;font-size:var(--v2-fs-xs);font-weight:600;margin-top:var(--v2-s2)">Add New</span></span></article>';
    html+='</div></div>';
    return html;
  }

  // ── BOARD VIEW: every dispatcher ──────────────────────────────────────────
  let html='<div class="v2-region">';
  html+='<div class="v2-page-head"><h1>Dispatch Board</h1>'
    +'<p>Who is running which truck, and whether any of them should be rolling.</p></div>';
  if(!isAdmin()) html+=dispatcherNotice();

  if(names.length===0&&unassigned.length===0){
    return html+'<div class="v2-empty" style="padding:var(--v2-s10);text-align:center;color:var(--v2-ink-3)">'
      +'No vehicles with dispatcher assignments yet.<br><span style="font-size:var(--v2-fs-xs)">'
      +'Assign dispatchers to vehicles on the Vehicles page.</span></div></div>';
  }

  // Fleet-wide tallies, computed once and reused by the tabs and the legend.
  // Two different tallies, and they are not interchangeable. tOk/tWarn/tCrit
  // count TRUCKS, and feed the legend. dOk/dWarn/dCrit count DISPATCHERS, and
  // label the tabs — because a tab filters dispatcher cards, so its number has
  // to be the number of cards you will be left looking at. A dispatcher with a
  // critical truck and a warning truck is in both buckets, which is why these
  // sum to more than the card count.
  let tOk=0,tWarn=0,tCrit=0,tVac=0;
  let dOk=0,dWarn=0,dCrit=0;
  const cards=names.map(name=>{
    const trucks=VEHICLES.filter(v=>v.assignedDispatcher===name);
    const active=trucks.filter(v=>!_vacSet.has(v.assignedDriverId));
    const vac=trucks.filter(v=>_vacSet.has(v.assignedDriverId));
    const sts=active.map(v=>getVehicleStatus(v.id));
    const crit=sts.filter(s=>s.critical).length;
    const warn=sts.filter(s=>s.warning&&!s.critical).length;
    const ok=active.length-crit-warn;
    tOk+=ok; tWarn+=warn; tCrit+=crit; tVac+=vac.length;
    if(crit>0)dCrit++; if(warn>0)dWarn++; if(crit===0&&warn===0&&ok>0)dOk++;
    const pct=active.length?Math.round((ok/active.length)*100):100;
    const tone=crit>0?'is-crit':warn>0?'is-warn':'is-ok';
    // Every driver name on this card goes into the search haystack, so typing a
    // driver finds the dispatcher running them — what the placeholder promises.
    const hay=[name].concat(trucks.map(v=>{
      const d=DRIVERS.find(x=>x.id===v.assignedDriverId);
      return (d?d.name:'')+' '+(v.truckNumber||'');
    })).join(' ').toLowerCase();

    const rows=active.map((v,i)=>{
      const st=sts[i];
      const d=DRIVERS.find(x=>x.id===v.assignedDriverId);
      const rt=st.critical?' is-crit':st.warning?' is-warn':'';
      return '<div class="v2-truck-row'+rt+'"><span class="v2-truck-ic">'+_sv(_IC.truck)+'</span>'
        +'<span class="v2-truck-main"><span class="v2-truck-no">#'+esc(v.truckNumber)+'</span>'
        +(d?'<span class="v2-truck-sub">'+esc(d.name)+'</span>':'')+'</span>'
        +_strip(st)+'</div>';
    }).join('')
    +vac.map(v=>{
      const d=DRIVERS.find(x=>x.id===v.assignedDriverId);
      return '<div class="v2-truck-row" style="opacity:.5"><span class="v2-truck-ic">'+_sv(_IC.truck)+'</span>'
        +'<span class="v2-truck-main"><span class="v2-truck-no">#'+esc(v.truckNumber)+'</span>'
        +(d?'<span class="v2-truck-sub">'+esc(d.name)+'</span>':'')+'</span>'
        +'<span class="v2-vac-tag">Vacation</span></div>';
    }).join('');

    return '<article class="v2-disp-card '+tone+'" data-hay="'+esc(hay)+'" data-crit="'+crit+'" data-warn="'+warn+'" data-ok="'+ok+'"'
      +' style="cursor:pointer" onclick="currentDispatcherFilter=\''+name.replace(/'/g,"\\'")+'\';render()">'
      +'<header class="v2-disp-head"><span class="v2-disp-avatar">'+esc(_ini(name))+'</span>'
      +'<span class="v2-disp-id"><span class="v2-disp-name">'+esc(name)+'</span>'
      +'<span class="v2-disp-meta">'+trucks.length+' truck'+(trucks.length!==1?'s':'')+'</span></span>'
      +'<span class="v2-disp-link">View fleet'+_sv(_IC.arrow,'2')+'</span></header>'
      +'<div class="v2-disp-stats"><div class="v2-disp-chips">'
        +(ok>0?'<span class="v2-disp-chip is-ok">'+ok+' Good</span>':'')
        +(warn>0?'<span class="v2-disp-chip is-warn">'+warn+' Warn</span>':'')
        +(crit>0?'<span class="v2-disp-chip is-crit">'+crit+' Critical</span>':'')
        +(vac.length>0?'<span class="v2-disp-chip">'+vac.length+' Vacation</span>':'')
      +'</div><div class="v2-health"><div class="v2-health-track" role="progressbar" aria-valuenow="'+pct+'" aria-valuemin="0" aria-valuemax="100" aria-label="'+esc(name)+' fleet health">'
      +'<div class="v2-health-fill" style="width:'+pct+'%"></div></div><span class="v2-health-pct">'+pct+'%</span></div></div>'
      +'<div class="v2-fleet-list">'+rows+'</div></article>';
  }).join('');

  // The All tab counts every CARD on the board, which includes the Unassigned
  // tile when there is one — it is a card you can see and filter away, even
  // though it is not a dispatcher.
  const rated=tOk+tWarn+tCrit;
  html+='<div class="v2-filterbar">'
    +'<div class="v2-disp-search">'+_sv(_IC.search)
      +'<label class="v2-sr-only" for="db-q">Filter by dispatcher, driver or truck</label>'
      +'<input id="db-q" type="text" placeholder="Dispatcher, driver or truck" autocomplete="off" spellcheck="false" oninput="dbApplyFilter()"/>'
    +'</div>'
    +'<div class="v2-tabs" role="group" aria-label="Filter by status">'
      +'<button class="v2-tab is-active" type="button" data-dbstatus="all" onclick="dbSetStatus(this)">All <span class="v2-tab-n">'+(names.length+(unassigned.length>0?1:0))+'</span></button>'
      +'<button class="v2-tab" type="button" data-dbstatus="ok" onclick="dbSetStatus(this)">Good <span class="v2-tab-n">'+dOk+'</span></button>'
      +'<button class="v2-tab" type="button" data-dbstatus="warn" onclick="dbSetStatus(this)">Warning <span class="v2-tab-n">'+dWarn+'</span></button>'
      +'<button class="v2-tab" type="button" data-dbstatus="crit" onclick="dbSetStatus(this)">Critical <span class="v2-tab-n">'+dCrit+'</span></button>'
    +'</div></div>';

  html+='<div class="v2-legend"><span class="v2-legend-lead">Days since last</span>'
    +'<span class="v2-legend-item"><span class="v2-legend-key">B</span>Brake test</span>'
    +'<span class="v2-legend-item"><span class="v2-legend-key">T</span>Tyre check</span>'
    +'<span class="v2-legend-item"><span class="v2-legend-key">S</span>Yard service</span>'
    +'<span class="v2-legend-item"><span class="v2-legend-key">P</span>Pre-trip today</span>'
    +'<span class="v2-legend-tail">'+rated+' rated &middot; '+tVac+' frozen on vacation &middot; '+unassigned.length+' unassigned &middot; '+VEHICLES.length+' total</span></div>';

  html+='<div class="v2-board" id="db-board">'+cards;

  if(unassigned.length>0){
    const rows=unassigned.map(v=>'<div class="v2-truck-row"><span class="v2-truck-ic">'+_sv(_IC.truck)+'</span>'
      +'<span class="v2-truck-main"><span class="v2-truck-no">#'+esc(v.truckNumber)+'</span></span></div>').join('');
    html+='<article class="v2-disp-card" data-hay="unassigned" data-crit="0" data-warn="0" data-ok="0" style="opacity:.7">'
      +'<header class="v2-disp-head"><span class="v2-disp-avatar is-none">?</span>'
      +'<span class="v2-disp-id"><span class="v2-disp-name">Unassigned</span>'
      +'<span class="v2-disp-meta">'+unassigned.length+' truck'+(unassigned.length!==1?'s':'')+'</span></span></header>'
      +'<div class="v2-fleet-list">'+rows+'</div></article>';
  }
  html+='</div>';
  html+='<div class="v2-empty" id="db-empty" hidden style="padding:var(--v2-s10);text-align:center;color:var(--v2-ink-3)">No dispatcher matches that filter.</div>';
  html+='</div>';
  return html;
}

// ── Dispatch board filter ───────────────────────────────────────────────────
// Client-side only: it hides cards that are already rendered and touches no
// data. The v2 mock-up ships this bar with no JavaScript behind it; leaving it
// inert in the live app would be a control that renders and does nothing.
// Hiding uses el.hidden, which needs the .v2-region [hidden] rule in
// v2-bridge.css — the UA's bare attribute selector loses to any class that
// sets display.
function dbApplyFilter(){
  const q=document.getElementById('db-q');
  const term=q?q.value.trim().toLowerCase():'';
  const active=document.querySelector('.v2-tab.is-active[data-dbstatus]');
  const want=active?active.dataset.dbstatus:'all';
  let shown=0;
  document.querySelectorAll('#db-board .v2-disp-card').forEach(card=>{
    const crit=+(card.dataset.crit||0), warn=+(card.dataset.warn||0), ok=+(card.dataset.ok||0);
    const okText=!term||(card.dataset.hay||'').indexOf(term)>=0;
    const okStatus=want==='all'||(want==='crit'&&crit>0)||(want==='warn'&&warn>0)||(want==='ok'&&crit===0&&warn===0&&ok>0);
    const show=okText&&okStatus;
    card.hidden=!show;
    if(show) shown++;
  });
  const empty=document.getElementById('db-empty');
  if(empty) empty.hidden=shown>0;
}
function dbSetStatus(btn){
  document.querySelectorAll('.v2-tab[data-dbstatus]').forEach(b=>b.classList.toggle('is-active',b===btn));
  dbApplyFilter();
}


// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════
function renderDashboard(){
  const statuses=VEHICLES.map(v=>({v,s:getVehicleStatus(v.id)}));
  const _vacSet=new Set(DRIVERS.filter(d=>d.on_vacation).map(d=>d.id));
  const activeStatuses=statuses.filter(x=>!_vacSet.has(x.v.assignedDriverId));
  const roadworthy=activeStatuses.filter(x=>!x.s.critical&&!x.s.tyreOverdue).length;
  const critical=activeStatuses.filter(x=>x.s.critical).length;
  const oos=activeStatuses.filter(x=>x.s.hasOOS);
  const brakeOverdue=activeStatuses.filter(x=>x.s.brakeOverdue);
  const brakeDueSoon=activeStatuses.filter(x=>x.s.brakeDueSoon);
  const tyreOverdue=activeStatuses.filter(x=>x.s.tyreOverdue);
  const serviceOverdue=activeStatuses.filter(x=>x.s.serviceOverdue);
  const vicious=activeStatuses.filter(x=>x.s.viciousCircle);

  // ── v2 markup helpers ─────────────────────────────────────────────────────
  // The dashboard renders v2 components against live data. Styles come from
  // v2-tokens.css + v2-bridge.css + v2-dash.css, loaded by index.html.
  // v2-shell.css is deliberately not loaded — see the note in v2-bridge.css.
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _I={
    truck:'<path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l3 3v5h-2"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    alert:'<path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    users:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    tyre:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M21 12h-3M6 12H3"/>',
    wrench:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
    cycle:'<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    list:'<path d="M9 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/>',
    check:'<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  };
  // Decorative only: aria-hidden, no text, and it sits behind the number.
  // Each tile gets the artwork v2/index.html pairs with it rather than one
  // shared graphic — a radar sweep for the fleet count, a hex lattice with a
  // tick for roadworthy, hazard hatching for critical, a node graph for
  // drivers. currentColor throughout, so .v2-accent-* tints them.
  const _ART={
    radar:'<circle cx="112" cy="80" r="20" stroke-opacity=".9"/><circle cx="112" cy="80" r="38" stroke-opacity=".5"/><circle cx="112" cy="80" r="56" stroke-opacity=".28"/><circle cx="112" cy="80" r="74" stroke-opacity=".14"/><path d="M112 6v148M38 80h148" stroke-opacity=".18"/><circle cx="112" cy="42" r="3.5" fill="currentColor" stroke="none"/><circle cx="150" cy="80" r="3" fill="currentColor" stroke="none" fill-opacity=".7"/><circle cx="112" cy="118" r="2.5" fill="currentColor" stroke="none" fill-opacity=".5"/>',
    hex:'<g stroke-opacity=".55"><path d="M96 44l18-10 18 10v20l-18 10-18-10z"/><path d="M132 64l18-10 18 10v20l-18 10-18-10z" stroke-opacity=".5"/><path d="M96 84l18-10 18 10v20l-18 10-18-10z" stroke-opacity=".75"/><path d="M60 64l18-10 18 10v20l-18 10-18-10z" stroke-opacity=".3"/><path d="M132 104l18-10 18 10v20l-18 10-18-10z" stroke-opacity=".22"/></g><path d="M105 84l7 7 14-15" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    hazard:'<g stroke-opacity=".3"><path d="M56 160L160 56M76 160L160 76M96 160L160 96M116 160L160 116M36 160L160 36M16 160L160 16"/></g><path d="M112 48l30 52h-60z" stroke-width="2" stroke-linejoin="round" stroke-opacity=".9"/><path d="M112 68v14" stroke-width="2.4" stroke-linecap="round"/><circle cx="112" cy="90" r="2.4" fill="currentColor" stroke="none"/>',
    nodes:'<g stroke-opacity=".35"><path d="M112 80L74 46M112 80l38-30M112 80l-30 44M112 80l40 30M112 80l44-6"/></g><circle cx="112" cy="80" r="9" stroke-opacity=".95"/><circle cx="74" cy="46" r="5.5" stroke-opacity=".7"/><circle cx="150" cy="50" r="4.5" stroke-opacity=".55"/><circle cx="82" cy="124" r="5" stroke-opacity=".5"/><circle cx="152" cy="110" r="4" stroke-opacity=".4"/><circle cx="156" cy="74" r="3.5" stroke-opacity=".3"/><circle cx="112" cy="80" r="3" fill="currentColor" stroke="none"/>',
  };
  const _art=k=>'<div class="v2-stat-art" aria-hidden="true"><svg viewBox="0 0 160 160" fill="none" stroke="currentColor" stroke-width="1.4">'+_ART[k]+'</svg></div>';
  const _tile=(a,ic,n,l,toned,art)=>'<article class="v2-stat '+a+(toned?' is-toned':'')+'">'
    +(art?_art(art):'')
    +'<span class="v2-stat-ic">'+_sv(ic,'1.8')+'</span>'
    +'<div class="v2-stat-body"><span class="v2-stat-num">'+n+'</span>'
    +'<span class="v2-stat-label">'+l+'</span></div></article>';
  // Rows stay anchors so they keep keyboard focus and the browser's own
  // affordances; navigate() is called on click exactly as the old rows did.
  const _row=(id,truck,detail,badge,solid)=>'<a class="v2-line-row" href="#" onclick="navigate(\'vehicle\',\''+id+'\');return false">'
    +'<span class="v2-line-truck">Truck #'+esc(truck)+'</span>'
    +'<span class="v2-line-detail">'+detail+'</span>'
    +'<span class="v2-badge'+(solid?' is-solid':' is-muted')+'">'+badge+'</span></a>';
  const _empty=m=>'<div class="v2-panel-empty">'+_sv(_I.check)+'<span>'+m+'</span></div>';
  const _panel=(a,ic,title,count,body)=>'<article class="v2-panel '+a+'">'
    +'<div class="v2-panel-head"><span class="v2-panel-ic">'+_sv(ic)+'</span>'
    +'<h2>'+title+'</h2><span class="v2-panel-count">'+count+'</span></div>'
    +'<div class="v2-panel-body">'+body+'</div></article>';

  let html='<div class="v2-region">';

  html+='<div class="v2-page-head"><h1>Dashboard</h1>'
    +'<p>Fleet roadworthiness at a glance &mdash; what is overdue, what is due soon, and what changed today.</p></div>';

  // ── Tier 1: headline counts ───────────────────────────────────────────────
  html+='<div class="v2-stat-row">'
    +_tile('v2-accent-cyan',_I.truck,VEHICLES.length,'Total vehicles',false,'radar')
    +_tile('v2-accent-green',_I.shield,roadworthy,'Roadworthy',true,'hex')
    +_tile('v2-accent-red',_I.alert,critical,'Critical issues',true,'hazard')
    +_tile('v2-accent-blue',_I.users,DRIVERS.length,'Drivers',false,'nodes')
    +'</div>';

  // ── Tier 2: banners ───────────────────────────────────────────────────────
  if(serviceOverdue.length>0){
    html+='<div class="v2-banner v2-accent-red"><span class="v2-banner-ic">'+_sv(_I.alert,'1.8')+'</span>'
      +'<div class="v2-banner-body"><div class="v2-banner-title">Service overdue &mdash; yard visit ASAP</div>'
      +'<div class="v2-banner-sub">Past the 90-day inspection interval.</div><div class="v2-banner-rows">'
      +serviceOverdue.map(x=>{
        const dr=DRIVERS.find(d=>d.id===x.v.assignedDriverId);
        const drName=dr?esc(dr.name):'Unassigned Driver';
        const disp=esc(x.v.assignedDispatcher||'Unassigned');
        return '<a class="v2-banner-row" href="#" onclick="navigate(\'vehicle\',\''+x.v.id+'\');return false">'
          +'<span class="v2-banner-truck">Truck #'+esc(x.v.truckNumber)+'</span>'
          +'<span class="v2-banner-meta">'+drName+' &nbsp;&middot;&nbsp; '+disp+' &nbsp;&middot;&nbsp; '+x.s.serviceDays+' days</span>'
          +'<span class="v2-badge is-solid">Overdue</span></a>';
      }).join('')
      +'</div></div></div>';
  }
  if(vicious.length>0){
    html+='<div class="v2-banner v2-accent-amber"><span class="v2-banner-ic">'+_sv(_I.cycle,'1.8')+'</span>'
      +'<div class="v2-banner-body"><div class="v2-banner-title">Vicious circle alert</div>'
      +'<div class="v2-banner-sub">Serviced without a matching brake test on the same date.</div>'
      +'<div class="v2-banner-rows">'
      +vicious.map(x=>'<a class="v2-banner-row" href="#" onclick="navigate(\'vehicle\',\''+x.v.id+'\');return false">'
        +'<span class="v2-banner-truck">Truck #'+esc(x.v.truckNumber)+'</span>'
        +'<span class="v2-banner-meta">Service and brake dates do not line up</span>'
        +'<span class="v2-badge">Review</span></a>').join('')
      +'</div></div></div>';
  }

  // ── Tier 3: the four compliance panels ────────────────────────────────────
  html+='<section class="v2-panel-grid" aria-label="Compliance">';
  html+=_panel('v2-accent-red',_I.clock,'Brake inspection overdue',brakeOverdue.length,
    brakeOverdue.length===0?_empty('All vehicles within the 30-day schedule')
    :brakeOverdue.map(x=>_row(x.v.id,x.v.truckNumber,
        x.s.lastBrake?x.s.brakeDays+' days since last test':'No test on record',
        x.s.lastBrake?'Overdue':'None',true)).join(''));
  html+=_panel('v2-accent-amber',_I.clock,'Brake test due soon',brakeDueSoon.length,
    brakeDueSoon.length===0?_empty('No vehicles due in the next 7 days')
    :brakeDueSoon.map(x=>{const d=x.s.brakeInterval-x.s.brakeDays;
      return _row(x.v.id,x.v.truckNumber,'Due in '+d+' day'+(d===1?'':'s'),'Due soon',true);}).join(''));
  html+=_panel('v2-accent-amber',_I.tyre,'Tyre check overdue',tyreOverdue.length,
    tyreOverdue.length===0?_empty('All tyre checks are current')
    :tyreOverdue.map(x=>_row(x.v.id,x.v.truckNumber,
        x.s.lastTyre?x.s.tyreDays+' days since last check':'No check on record',
        x.s.tyreDays===null?'None':x.s.tyreDays+'d',false)).join(''));
  html+=_panel('v2-accent-blue',_I.wrench,'Service overdue (90-day)',serviceOverdue.length,
    serviceOverdue.length===0?_empty('All vehicles within the 90-day service schedule')
    :serviceOverdue.map(x=>_row(x.v.id,x.v.truckNumber,
        x.s.serviceDays+' days since last service','Overdue',true)).join(''));
  html+='</section>';

  // ── Tier 4: recent activity ───────────────────────────────────────────────
  const allRecent=[...MAINTENANCE.map(r=>({date:r.serviceDate,label:'Service &ndash; Truck #'+esc(VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'),type:'maint'})),...BRAKE_TESTS.map(r=>({date:r.testDate,label:'Brake '+esc(r.result)+' &ndash; Truck #'+esc(VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'),type:'brake',pass:r.result==='pass'})),...SERVICE_RECORDS.map(r=>({date:r.serviceDate,label:'Vehicle service '+esc(r.result)+' &ndash; Truck #'+esc(VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'),type:'svc',pass:r.result==='pass'}))].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6);
  html+='<article class="v2-panel v2-accent-cyan"><div class="v2-panel-head">'
    +'<span class="v2-panel-ic">'+_sv(_I.list)+'</span><h2>Recent activity</h2>'
    +'<span class="v2-panel-count">'+allRecent.length+'</span></div><div class="v2-panel-body">';
  if(allRecent.length===0) html+=_empty('No activity recorded yet');
  else html+='<div class="v2-timeline">'+allRecent.map(r=>{
      const acc=r.type==='brake'?(r.pass?'v2-accent-green':'v2-accent-red')
        :r.type==='svc'?(r.pass?'v2-accent-green':'v2-accent-amber'):'v2-accent-blue';
      return '<div class="v2-tl-row '+acc+'"><span class="v2-tl-dot"></span>'
        +'<span class="v2-tl-label">'+r.label+'</span>'
        +'<span class="v2-tl-date">'+fmtDate(r.date)+'</span></div>';
    }).join('')+'</div>';
  html+='</div></article>';

  if(VEHICLES.length===0){
    html+='<div class="v2-banner v2-accent-green" style="margin-top:var(--v2-s6)"><span class="v2-banner-ic">'+_sv(_I.check,'1.8')+'</span>'
      +'<div class="v2-banner-body"><div class="v2-banner-title">Welcome to FleetGuard</div>'
      +'<div class="v2-banner-sub">Start by adding drivers and vehicles.'
      +(isAdmin()?' <a href="#" onclick="navigate(\'vehicles\');return false" style="color:var(--v2-primary-hi);font-weight:600">&rarr; Add your first vehicle</a>':'')
      +'</div></div></div>';
  }

  html+='</div>';
  return html;
}

// ═══════════════════════════════════════════════════════
// VEHICLES
// ═══════════════════════════════════════════════════════
// The card carries status only — no send actions. Both live on the vehicle
// detail page instead (PTI link under the PTI tab, PM/oil under Service):
// the card is too narrow for them and they duplicated what detail already had.
function renderVehicles(){
  // v2 components against live data. Styles: v2-tokens + v2-bridge +
  // v2-vehicles.css, loaded by index.html. v2-shell.css stays out — see the
  // note in v2-bridge.css for why.
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    truck:'<path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l3 3v5h-2"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    user:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    radio:'<path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><circle cx="12" cy="12" r="2"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    pencil:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash:'<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  };
  // Mirrors annualPill() exactly — same ANNUAL_AVAILABLE gate, same
  // ANNUAL_CRIT_DAYS / ANNUAL_WARN_DAYS thresholds, same EXPIRED wording —
  // but emits a v2 pill instead of a production .status-pill so it does not
  // sit in a v2 card wearing the old skin.
  const _annual=s=>{
    if(!ANNUAL_AVAILABLE) return '';
    if(!s.annualExpiry) return '<span class="v2-pill is-none" title="Annual DOT inspection expiry not recorded">Annual not set</span>';
    const d=s.annualDaysLeft;
    const t=s.annualExpired||d<=ANNUAL_CRIT_DAYS?'is-crit':d<=ANNUAL_WARN_DAYS?'is-warn':'is-ok';
    const txt=s.annualExpired?'EXPIRED '+Math.abs(d)+'d':d+'d';
    return '<span class="v2-pill '+t+'" title="Annual DOT inspection expires '+fmtDate(s.annualExpiry)+'">Annual '+txt+'</span>';
  };

  let html='<div class="v2-region">';

  html+='<div class="v2-page-head"><h1>Vehicles</h1>'
    +'<p>Every truck in the fleet, with its compliance clocks. Red means it should not roll.</p></div>';

  if(isAdmin()){
    html+='<section class="v2-form-card v2-accent-primary" aria-label="Add vehicle">'
      +'<div class="v2-form-head"><span class="v2-form-ic">'+_sv(_IC.truck)+'</span>'
      +'<h2>Add vehicle</h2><span class="v2-form-note">Admin only</span></div>'
      +'<div class="v2-form-body"><div class="v2-form-grid">'
      +'<div class="v2-field"><label for="v-truck">Truck number <span class="v2-field-req">*</span></label>'
      +'<input class="v2-input" id="v-truck" type="text" placeholder="e.g. T001"></div>'
      +'<div class="v2-field"><label for="v-trailer">Trailer number <span class="v2-field-req">*</span></label>'
      +'<input class="v2-input" id="v-trailer" type="text" placeholder="e.g. TR001"></div>'
      +'<div class="v2-field"><label for="v-driver">Assign driver</label><span class="v2-select-wrap">'
      +'<select class="v2-select" id="v-driver"><option value="">&mdash; optional &mdash;</option>'
      +DRIVERS.map(d=>'<option value="'+d.id+'">'+esc(d.name)+'</option>').join('')
      +'</select>'+_sv('<path d="m6 9 6 6 6-6"/>','1.8')+'</span></div>'
      +'<div class="v2-field"><label for="v-dispatcher">Assign dispatcher</label>'
      +'<input class="v2-input" id="v-dispatcher" type="text" placeholder="Dispatcher name"></div>'
      +(ANNUAL_AVAILABLE?'<div class="v2-field"><label for="v-annual">Annual DOT expiry</label>'
        +'<input class="v2-input" id="v-annual" type="date" title="Expiry date on the truck\'s annual DOT inspection certificate"></div>':'')
      +'</div>'
      +'<button class="v2-btn-primary" type="button" onclick="doAddVehicle()">'+_sv(_IC.plus,'2')+'Add vehicle</button>'
      +'<p class="v2-form-hint">Truck and trailer numbers are required.</p>'
      +'</div></section>';
  } else {
    html+='<div class="v2-form-card v2-accent-blue" style="margin-bottom:var(--v2-s6)">'
      +'<div class="v2-form-head"><span class="v2-form-ic">'+_sv(_IC.eye)+'</span>'
      +'<h2>View only</h2><span class="v2-form-note">Contact an admin to make changes</span></div></div>';
  }

  html+='<div class="v2-fleet-grid">';
  if(VEHICLES.length===0){
    html+='<div class="v2-form-card" style="grid-column:1/-1"><div class="v2-form-body" style="color:var(--v2-ink-3)">'
      +'No vehicles yet'+(isAdmin()?' &mdash; add one above.':'.')+'</div></div>';
  }
  VEHICLES.forEach(v=>{
    const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
    const s=getVehicleStatus(v.id);
    const accent=s.critical?'v2-accent-red':s.warning?'v2-accent-amber':'v2-accent-green';
    const statusTone=s.critical?'is-crit':s.warning?'is-warn':'is-ok';
    const statusText=s.critical?'Critical':s.warning?'Warning':'OK';
    html+='<article class="v2-veh '+accent+'" id="vcard-'+v.id+'">'
      +(s.newTruck?'<span class="v2-veh-mark" aria-hidden="true">NEW TRUCK</span>':'')
      // ── view mode ──
      +'<div id="vview-'+v.id+'">'
        +'<div class="v2-veh-head">'
          +'<span class="v2-veh-id" onclick="navigate(\'vehicle\',\''+v.id+'\')" style="cursor:pointer">'
            +'<span class="v2-veh-truck">Truck #'+esc(v.truckNumber)+'</span>'
            +'<span class="v2-veh-trailer">Trailer #'+esc(v.trailerNumber)+'</span>'
          +'</span>'
          +'<span class="v2-veh-status '+statusTone+'">'+statusText+'</span>'
          +(isAdmin()?'<span style="display:flex;gap:var(--v2-s1);flex-shrink:0">'
            +'<button class="v2-icon-btn" type="button" title="Edit" aria-label="Edit vehicle" onclick="startEditVehicle(\''+v.id+'\')">'+_sv(_IC.pencil,'1.8')+'</button>'
            +'<button class="v2-icon-btn" type="button" title="Delete" aria-label="Delete vehicle" onclick="event.stopPropagation();doDeleteVehicle(\''+v.id+'\',\''+esc(v.truckNumber)+'\')">'+_sv(_IC.trash,'1.8')+'</button>'
            +'</span>':'')
        +'</div>'
        +((driver||v.assignedDispatcher)?'<div class="v2-veh-people">'
          +(driver?'<span class="v2-veh-person">'+_sv(_IC.user)+'<span>'+esc(driver.name)+'</span></span>':'')
          +(v.assignedDispatcher?'<span class="v2-veh-person">'+_sv(_IC.radio)+'<span>'+esc(v.assignedDispatcher)+'</span></span>':'')
          +'</div>':'')
        +'<div class="v2-pills">'
          +'<span class="v2-pill '+(s.brakeOverdue?'is-crit':s.brakeDueSoon?'is-warn':'is-ok')+'">Brakes '+(s.lastBrake?s.brakeDays+'d':'None')+'</span>'
          +'<span class="v2-pill '+(s.tyreOverdue?'is-warn':'is-ok')+'">Tyres '+(s.lastTyre?s.tyreDays+'d':'None')+'</span>'
          +'<span class="v2-pill '+(s.serviceOverdue?'is-crit':s.serviceDueSoon?'is-warn':'is-ok')+'">Service '+(s.serviceDays!==null?s.serviceDays+'d':'None')+'</span>'
          +'<span class="v2-pill '+(s.preTripToday?'is-ok':'is-none')+'">Pre-trip '+(s.preTripToday?'&check; today':(s.lastPreTrip?fmtDate(s.lastPreTrip.submittedAt):'none'))+'</span>'
          +_annual(s)
          +(s.openDefect?'<span class="v2-pill '+(s.defectCritical?'is-crit':'is-warn')+'">'+(s.defectCritical?'DEFECT':'Minor')+' unrepaired</span>':'')
        +'</div>'
      +'</div>'
      // ── edit mode (toggled by startEditVehicle / cancelEditVehicle) ──
      +'<div id="vedit-'+v.id+'" style="display:none">'
        +'<div class="v2-form-head" style="padding-bottom:var(--v2-s3)"><span class="v2-form-ic">'+_sv(_IC.pencil)+'</span><h2>Edit vehicle</h2></div>'
        +'<div class="v2-form-grid" style="margin-bottom:var(--v2-s4)">'
          +'<div class="v2-field"><label for="ve-truck-'+v.id+'">Truck #</label>'
          +'<input class="v2-input" type="text" id="ve-truck-'+v.id+'" value="'+esc(v.truckNumber)+'"></div>'
          +'<div class="v2-field"><label for="ve-trailer-'+v.id+'">Trailer #</label>'
          +'<input class="v2-input" type="text" id="ve-trailer-'+v.id+'" value="'+esc(v.trailerNumber)+'"></div>'
          +'<div class="v2-field"><label for="ve-driver-'+v.id+'">Driver</label><span class="v2-select-wrap">'
          +'<select class="v2-select" id="ve-driver-'+v.id+'"><option value="">&mdash; none &mdash;</option>'
          +DRIVERS.map(d=>'<option value="'+d.id+'"'+(v.assignedDriverId===d.id?' selected':'')+'>'+esc(d.name)+'</option>').join('')
          +'</select>'+_sv('<path d="m6 9 6 6 6-6"/>','1.8')+'</span></div>'
          +'<div class="v2-field"><label for="ve-dispatcher-'+v.id+'">Dispatcher</label>'
          +'<input class="v2-input" type="text" id="ve-dispatcher-'+v.id+'" value="'+esc(v.assignedDispatcher||'')+'"></div>'
          +(ANNUAL_AVAILABLE?'<div class="v2-field"><label for="ve-annual-'+v.id+'">Annual DOT expiry</label>'
            +'<input class="v2-input" type="date" id="ve-annual-'+v.id+'" value="'+esc(v.annualExpiry||'')+'"></div>':'')
        +'</div>'
        +'<div style="display:flex;gap:var(--v2-s2)">'
          +'<button class="v2-btn-primary" type="button" onclick="doSaveVehicle(\''+v.id+'\')">Save</button>'
          +'<button class="v2-btn-ghost" type="button" onclick="cancelEditVehicle(\''+v.id+'\')">Cancel</button>'
        +'</div>'
      +'</div>'
    +'</article>';
  });
  html+='</div></div>';
  return html;
}

async function doAddVehicle(){
  if(!isAdmin()) return;
  const truck=document.getElementById('v-truck').value.trim(),trailer=document.getElementById('v-trailer').value.trim(),driver=document.getElementById('v-driver').value,dispatcher=document.getElementById('v-dispatcher').value.trim();
  if(!truck||!trailer){showToast('Enter truck and trailer numbers','danger');return;}
  const annual=document.getElementById('v-annual')?.value||null;
  await addVehicle(truck,trailer,driver||null,dispatcher||'',annual); showToast('Vehicle added!','success'); render();
}
let _avmDispatcher='';
function openAddVehicleModal(dispatcherName){
  if(!isAdmin()) return;
  _avmDispatcher=dispatcherName;
  const driverOptions=DRIVERS.map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
  document.getElementById('avm-body').innerHTML=`
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">👤 New Driver <span style="font-weight:400;opacity:.6">(optional — will be assigned to this truck)</span></div>
      <input type="text" id="avm-driver-name" placeholder="Full name — leave blank to use existing" style="width:100%;box-sizing:border-box"/>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:14px">
      <div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">🚛 Vehicle Details</div>
      <div class="form-grid form-grid-3" style="margin-bottom:10px">
        <div><label>Truck Number</label><input type="text" id="avm-truck" placeholder="e.g. T001"/></div>
        <div><label>Trailer Number</label><input type="text" id="avm-trailer" placeholder="e.g. TR001"/></div>
        <div><label>Assign Driver</label><select id="avm-driver"><option value="">— optional —</option>${driverOptions}</select></div>
        <div><label>Dispatcher</label><input type="text" id="avm-dispatcher" value="${dispatcherName.replace(/"/g,'&quot;')}"/></div>
        ${ANNUAL_AVAILABLE?`<div><label>Annual DOT expiry</label><input type="date" id="avm-annual" title="Expiry date on the truck's annual DOT inspection certificate"/></div>`:''}
      </div>
    </div>`;
  document.getElementById('add-vehicle-modal').style.display='flex';
  setTimeout(()=>{const t=document.getElementById('avm-truck');if(t)t.focus();},50);
}
function closeAddVehicleModal(){
  document.getElementById('add-vehicle-modal').style.display='none';
}
async function doAddFromModal(){
  if(!isAdmin()) return;
  const driverName=document.getElementById('avm-driver-name').value.trim();
  let driverId=document.getElementById('avm-driver').value;
  const truck=document.getElementById('avm-truck').value.trim();
  const trailer=document.getElementById('avm-trailer').value.trim();
  const dispatcher=document.getElementById('avm-dispatcher').value.trim();
  if(!truck||!trailer){showToast('Enter truck and trailer numbers','danger');return;}
  if(driverName){const nd=await addDriver(driverName);driverId=nd.id;}
  const annual=document.getElementById('avm-annual')?.value||null;
  await addVehicle(truck,trailer,driverId||null,dispatcher||_avmDispatcher,annual);
  closeAddVehicleModal();
  showToast('Added to fleet!','success');
  render();
}
function startEditVehicle(id){
  document.getElementById('vview-'+id).style.display='none';
  document.getElementById('vedit-'+id).style.display='block';
}
function cancelEditVehicle(id){
  document.getElementById('vview-'+id).style.display='block';
  document.getElementById('vedit-'+id).style.display='none';
}
async function doSaveVehicle(id){
  if(!isAdmin()) return;
  const truck=document.getElementById('ve-truck-'+id).value.trim(),trailer=document.getElementById('ve-trailer-'+id).value.trim(),driver=document.getElementById('ve-driver-'+id).value,dispatcher=document.getElementById('ve-dispatcher-'+id).value.trim();
  if(!truck||!trailer){showToast('Truck and trailer numbers required','danger');return;}
  await updateVehicle(id,truck,trailer,driver||null,dispatcher||'');
  // Written separately so the core vehicle save still works if migration 012
  // has not been applied — the input only exists when the column does.
  if(ANNUAL_AVAILABLE){
    const el=document.getElementById('ve-annual-'+id);
    if(el){
      const val=el.value||null;
      const {error}=await sb.from('vehicles').update({annual_inspection_expiry:val}).eq('id',id);
      if(error){ console.error('annual expiry save failed',error); showToast('Vehicle saved, but the annual expiry did not','danger'); }
      else { const veh=VEHICLES.find(x=>x.id===id); if(veh) veh.annualExpiry=val; }
    }
  }
  showToast('Vehicle updated!','success'); render();
}
async function doDeleteVehicle(id,num){
  if(!isAdmin()) return;
  const ok=await confirm2(`Delete Truck #${num}?`,'This will also delete all associated records. Cannot be undone.');
  if(!ok) return; await deleteVehicle(id); showToast('Vehicle deleted','warning');
  if(currentPage==='vehicle') navigate('vehicles'); else render();
}

// ═══════════════════════════════════════════════════════
// VEHICLE DETAIL
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// GUIDES
// ═══════════════════════════════════════════════════════
// Card data mirrors guides.html. Keeping it as data rather than markup means
// the filter counts, the category tabs and the search haystack all derive from
// one list instead of being maintained three times.
const GUIDE_CARDS=[
  {cat:'tools',accent:'v2-accent-amber',art:'v2-art-pti',tag:'Inspections',title:'PTI Driver Guide',
   blurb:'Step-by-step pre-trip inspection &mdash; how a driver completes every PTI, tyres and photos included.',
   meta:['DOT PART 396'],href:'PTI-driver-guide.html?dispatch=1',
   search:'pti driver guide pre trip inspection tyres photos dot part 396'},
  {cat:'tools',accent:'v2-accent-cyan',art:'v2-art-toll',tag:'Calculator',title:'Toll &amp; Route Console',
   blurb:'Two ZIP codes in &mdash; toll cost, fuel cost, and whether going around the toll actually pays.',
   meta:['80K / 5-AXLE','I-PASS'],href:'toll-console.html',
   search:'toll route console zip code toll cost fuel cost ipass 80k 5 axle calculator turnpike'},
  {cat:'tools',accent:'v2-accent-green',art:'v2-art-axle',tag:'Reference &middot; Tool',title:'Weight &amp; Axle Limits',
   blurb:'Federal limits plus a live load checker &mdash; type your scale ticket and it says where the weight is.',
   meta:['12K / 34K / 34K','KP-40'],href:'weight-axle-limits.html',
   search:'weight axle limits federal gross tandem 5th wheel scale ticket kingpin'},
  {cat:'maps',accent:'v2-accent-blue',art:'v2-art-scale',tag:'Locator &middot; External',title:'CAT Scale Locator',
   blurb:'Find the nearest CAT Scale to weigh your load &mdash; opens the live locator map.',
   meta:[],href:'https://catscale.com/cat-scale-locator/?postalcode=77003&amp;city=&amp;state=&amp;miles=2&amp;cmdSearch=',
   live:true,search:'cat scale locator weigh load nearest certified scale'},
  {cat:'maps',accent:'v2-accent-red',art:'v2-art-traffic',tag:'Live map &middot; External',title:'Road Conditions &amp; Traffic',
   blurb:'Live weather, traffic, accidents and construction across the country.',
   meta:[],href:'https://map.road511.com/',live:true,
   search:'road conditions traffic 511 map weather accidents construction'},
  {cat:'maps',accent:'v2-accent-cyan',art:'v2-art-states',tag:'By state',title:'State DOT / 511 Maps',
   blurb:'Official live road, weather and traffic map for every state &mdash; tap your state.',
   meta:['50 STATES'],href:'dot-state-maps.html',
   search:'state dot 511 maps by state road weather winter parking'},
  {cat:'reference',accent:'v2-accent-red',art:'',tag:'Safety',title:'Low Clearance Playbook',
   blurb:'What to do at a low bridge &mdash; spot it early, stop safely, and avoid a strike.',
   meta:['13&#39;6&quot; RULE'],href:'low-clearance-playbook.html',
   search:'low clearance playbook bridge strike height avoid'},
  {cat:'reference',accent:'v2-accent-blue',art:'',tag:'Winter',title:'Winter Chain Law',
   blurb:'When chains are required, how many to carry, and the states that enforce it.',
   meta:['15 STATES','6 CHAINS / 3 BAGS'],href:'winter-chain-law.html',
   search:'winter chain law snow chains required states bags'},
  {cat:'reference',accent:'v2-accent-amber',art:'',tag:'Compliance &middot; CVSA',title:'DOT Enforcement Calendar',
   blurb:'CVSA inspection blitz dates &mdash; Roadcheck, Safe Driver and Brake Safety Week.',
   meta:[],href:'dot-enforcement-calendar.html',
   search:'dot enforcement calendar cvsa inspection blitz roadcheck brake safety week'},
  {cat:'reference',accent:'v2-accent-green',art:'',tag:'Reference',title:'Trailer Dimensions',
   blurb:'Our 53&#39; dry van &mdash; exterior and interior dimensions, weight and cubic capacity.',
   meta:['53&#39; &times; 102&quot;','4,070 FT&sup3;'],href:'trailer-dimensions.html',
   search:'trailer dimensions 53 dry van exterior interior cubic'},
];
const GUIDE_SECTIONS=[
  ['tools','Essential Tools','Interactive tools and calculators for daily operations.','View all tools'],
  ['maps','Live Maps','Live road, traffic and weather maps, updated by the source.','View all maps'],
  ['reference','Reference &amp; Compliance','Limits, law and enforcement dates worth keeping to hand.','View all references'],
];
// Presentation state for the guides filter, same shape as the dispatch board's.
let guideCat='all', guideQuery='', guideSort='default';

function renderGuides(){
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    shield:'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/>',
    alert:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
    ok:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    cal:'<rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    wrench:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
    map:'<path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2Z"/><path d="M9 4v14M15 6v14"/>',
    book:'<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3Z"/>',
  };
  const SEC_IC={tools:_IC.wrench,maps:_IC.map,reference:_IC.book};
  const counts={all:GUIDE_CARDS.length};
  GUIDE_SECTIONS.forEach(sec=>{counts[sec[0]]=GUIDE_CARDS.filter(c=>c.cat===sec[0]).length;});

  let html='<div class="v2-region">';
  html+='<div class="v2-page-head"><h1>Guides &amp; Playbooks</h1>'
    +'<p>Everything dispatch and drivers need, one tap away &mdash; inspections, road maths, toll cards and DOT compliance.</p></div>';

  // ── Hero tiles ────────────────────────────────────────────────────────────
  // The weather tile starts in its "checking" state and is filled in by
  // guidesLoadWeather(); the other two are static facts about the fleet.
  const _arrow=' <span class="v2-arrow" aria-hidden="true">&#8594;</span>';
  html+='<section class="v2-hero-row" aria-label="Fleet status">'
    +'<article class="v2-tile v2-accent-amber" id="g-wx-tile">'
      +'<span class="v2-tile-ic">'+_sv(_IC.alert)+'</span>'
      +'<div class="v2-tile-body">'
        +'<span class="v2-tile-label">Weather alerts</span>'
        +'<span class="v2-tile-value" id="g-wx-value">Checking&hellip;</span>'
        +'<span class="v2-tile-sub">National Weather Service &middot; api.weather.gov</span>'
        +'<a class="v2-tile-link" href="https://map.road511.com/" target="_blank" rel="noopener">View on map'+_arrow+'</a>'
      +'</div></article>'
    +'<article class="v2-tile v2-accent-green">'
      +'<span class="v2-tile-ic">'+_sv(_IC.ok)+'</span>'
      +'<div class="v2-tile-body">'
        +'<span class="v2-tile-label">Fleet on file</span>'
        +'<span class="v2-tile-value">'+VEHICLES.length+' trucks tracked</span>'
        +'<span class="v2-tile-sub">'+DRIVERS.length+' drivers on file.</span>'
      +'</div></article>'
    +'<article class="v2-tile v2-accent-cyan">'
      +'<span class="v2-tile-ic">'+_sv(_IC.cal)+'</span>'
      +'<div class="v2-tile-body">'
        +'<span class="v2-tile-label">DOT news &amp; updates</span>'
        +'<span class="v2-tile-value">CVSA inspection calendar</span>'
        +'<span class="v2-tile-sub">Roadcheck, Brake Safety Week and Safe Driver Week enforcement dates.</span>'
        +'<a class="v2-tile-link" href="dot-enforcement-calendar.html" target="_blank" rel="noopener">View calendar'+_arrow+'</a>'
      +'</div></article>'
    +'</section>';

  // Populated by guidesLoadWeather(); both stay hidden until the feed returns.
  html+='<div class="v2-alerts" id="g-alerts" style="display:none"></div>';

  // ── Filter bar ────────────────────────────────────────────────────────────
  html+='<div class="v2-filterbar">'
    +'<div class="v2-disp-search">'+_sv(_IC.search)
      +'<label class="v2-sr-only" for="g-q">Search guides</label>'
      +'<input id="g-q" type="text" placeholder="Search guides, tools, states" autocomplete="off" spellcheck="false" value="'+esc(guideQuery)+'" oninput="guidesFilter()"/>'
    +'</div>'
    +'<div class="v2-tabs" role="group" aria-label="Filter by category">'
      +'<button class="v2-tab'+(guideCat==='all'?' is-active':'')+'" type="button" data-gcat="all" onclick="guidesSetCat(this)">All resources <span class="v2-tab-n">'+counts.all+'</span></button>';
  GUIDE_SECTIONS.forEach(sec=>{
    html+='<button class="v2-tab'+(guideCat===sec[0]?' is-active':'')+'" type="button" data-gcat="'+sec[0]+'" onclick="guidesSetCat(this)">'
      +sec[1].replace(' &amp; Compliance','')+' <span class="v2-tab-n">'+counts[sec[0]]+'</span></button>';
  });
  html+='</div>'
    +'<label class="v2-sort" for="g-sort"><span>Sort by</span>'
      +'<span class="v2-sort-field">'
        +'<select id="g-sort" onchange="guidesSort(this)">'
          +'<option value="default"'+(guideSort==='default'?' selected':'')+'>Category</option>'
          +'<option value="az"'+(guideSort==='az'?' selected':'')+'>A &ndash; Z</option>'
          +'<option value="za"'+(guideSort==='za'?' selected':'')+'>Z &ndash; A</option>'
        +'</select>'
        +_sv('<path d="m6 9 6 6 6-6"/>')
      +'</span></label>';
  html+='</div>';

  // ── Sections ──────────────────────────────────────────────────────────────
  GUIDE_SECTIONS.forEach(sec=>{
    const cards=GUIDE_CARDS.filter(c=>c.cat===sec[0]);
    if(guideSort!=='default') cards.sort((a,b)=>
      guideSort==='az'?a.title.localeCompare(b.title):b.title.localeCompare(a.title));
    html+='<section class="v2-section" data-gsec="'+sec[0]+'">'
      +'<div class="v2-section-head"><span class="v2-section-ic">'+_sv(SEC_IC[sec[0]])+'</span>'
      +'<div class="v2-section-title"><h2>'+sec[1]+' <span class="v2-tab-n">'+cards.length+'</span></h2>'
      +'<p>'+sec[2]+'</p></div>'
      +'<a class="v2-section-link" href="#" data-gcat="'+sec[0]+'" onclick="guidesSetCat(this);return false;">'
      +sec[3]+' <span class="v2-arrow" aria-hidden="true">&#8594;</span></a></div>'
      +'<div class="v2-tool-grid">';
    cards.forEach((c,i)=>{
      const external=/^https?:/.test(c.href);
      html+='<article class="v2-tool-card '+c.accent+'" data-gcat="'+c.cat+'" data-gsearch="'+esc(c.search)+'"'
        +' data-gtitle="'+esc(c.title)+'" data-gorder="'+i+'">'
        +(c.art?'<div class="v2-tool-art '+c.art+'" aria-hidden="true"></div>':'')
        +'<div class="v2-tool-body">'
          +'<span class="v2-tag">'+c.tag+'</span>'
          +'<h3>'+c.title+'</h3>'
          +'<p>'+c.blurb+'</p>'
          +'<div class="v2-tool-foot"><div class="v2-meta">'
            +c.meta.map(m=>'<span class="v2-meta-pill">'+m+'</span>').join('')
            +(c.live?'<span class="v2-meta-pill is-live">Live</span>':'')
          +'</div>'
          // These open the standalone playbook documents, which are separate
          // pages by design — only the Guides INDEX moved into the app.
          +'<a class="v2-btn" href="'+c.href+'" target="_blank" rel="noopener">Open'
          +(external?' site':' guide')+' <span class="v2-arrow" aria-hidden="true">&#8594;</span></a>'
        +'</div></div></article>';
    });
    html+='</div></section>';
  });

  html+='<div class="v2-empty" id="g-empty" style="display:none"><div class="v2-empty-ic">'+_sv(_IC.search)+'</div>'
    +'Nothing matches that. Try a different word, or pick another category.</div>';
  html+='</div>';
  return html;
}

// ── Guides filter ───────────────────────────────────────────────────────────
// Client-side only: hides cards already rendered, touches no data. Uses
// style.display rather than el.hidden because a section is display:block and
// a card display:flex — the UA's bare [hidden] rule loses to both, and the
// .v2-region [hidden] rule in v2-bridge.css only covers a ported region, which
// this is, but being explicit here keeps it independent of that file.
function guidesSetCat(btn){
  guideCat=btn.dataset.gcat||'all';
  // Match on the category, not on element identity: the section headers'
  // 'View all' links call this too, and they are not .v2-tab elements, so an
  // identity test cleared every tab and left the bar with nothing selected.
  document.querySelectorAll('.v2-tab[data-gcat]').forEach(b=>b.classList.toggle('is-active',b.dataset.gcat===guideCat));
  guidesFilter();
}
// Presentation only: reorders cards already rendered, the way guidesFilter
// hides them. "Category" restores the order they were rendered in, which is
// GUIDE_CARDS order within each section.
function guidesSort(sel){
  guideSort=sel.value||'default';
  document.querySelectorAll('.v2-tool-grid').forEach(grid=>{
    [...grid.children]
      .sort((a,b)=>
        guideSort==='az' ? a.dataset.gtitle.localeCompare(b.dataset.gtitle)
      : guideSort==='za' ? b.dataset.gtitle.localeCompare(a.dataset.gtitle)
      : (+a.dataset.gorder)-(+b.dataset.gorder))
      .forEach(card=>grid.appendChild(card));
  });
}
function guidesFilter(){
  const q=document.getElementById('g-q');
  guideQuery=q?q.value:'';
  const term=guideQuery.trim().toLowerCase();
  let shown=0;
  document.querySelectorAll('.v2-section[data-gsec]').forEach(sec=>{
    let inSection=0;
    sec.querySelectorAll('.v2-tool-card').forEach(card=>{
      const okCat=guideCat==='all'||card.dataset.gcat===guideCat;
      const okText=!term||(card.dataset.gsearch||'').indexOf(term)>=0
        ||card.textContent.toLowerCase().indexOf(term)>=0;
      const show=okCat&&okText;
      card.style.display=show?'':'none';
      if(show){inSection++;shown++;}
    });
    // A section header with nothing under it reads as an empty category rather
    // than a hidden one, so the whole section goes.
    sec.style.display=inSection?'':'none';
  });
  const empty=document.getElementById('g-empty');
  if(empty) empty.style.display=shown?'none':'';
}

// ── NWS weather alerts ──────────────────────────────────────────────────────
// api.weather.gov is an official US government API: no key, no registration,
// CORS open. Filtering by EVENT TYPE nationwide rather than by state keeps the
// payload small — blizzards and tornadoes are rare, so a quiet day is a few KB,
// while filtering by state would pull every heat advisory in the country.
const GUIDE_NWS_EVENTS=['Tornado Warning','Tornado Watch','Blizzard Warning','Ice Storm Warning',
  'Winter Storm Warning','Winter Storm Watch','High Wind Warning','Dust Storm Warning',
  'Blowing Dust Advisory','Freezing Rain Advisory','Winter Weather Advisory','Extreme Cold Warning'];
const GUIDE_SEV_RANK={Extreme:0,Severe:1,Moderate:2,Minor:3,Unknown:4};

async function guidesLoadWeather(){
  const val=document.getElementById('g-wx-value');
  const tile=document.getElementById('g-wx-tile');
  const box=document.getElementById('g-alerts');
  if(!val) return;                       // page changed under us
  try{
    const url='https://api.weather.gov/alerts/active?status=actual&event='
      +GUIDE_NWS_EVENTS.map(encodeURIComponent).join(',');
    const r=await fetch(url,{headers:{'Accept':'application/geo+json'}});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j=await r.json();
    const feats=j.features||[];
    if(!document.getElementById('g-wx-value')) return;   // navigated away mid-flight

    const by={};
    feats.forEach(f=>{
      const pr=f.properties||{}, k=pr.event;
      if(!k) return;
      if(!by[k]) by[k]={event:k,n:0,sev:'Unknown'};
      by[k].n++;
      if((GUIDE_SEV_RANK[pr.severity]??4)<(GUIDE_SEV_RANK[by[k].sev]??4)) by[k].sev=pr.severity||'Unknown';
    });
    const groups=Object.values(by).sort((a,b)=>
      (GUIDE_SEV_RANK[a.sev]??4)-(GUIDE_SEV_RANK[b.sev]??4)||b.n-a.n);

    if(!groups.length){
      val.textContent='All clear';
      if(tile){tile.classList.remove('v2-accent-amber','v2-accent-red');tile.classList.add('v2-accent-green');}
      return;
    }
    const total=groups.reduce((t,g)=>t+g.n,0);
    val.textContent=total+' active alert'+(total===1?'':'s');
    if(tile){
      tile.classList.remove('v2-accent-green');
      tile.classList.add(groups[0].sev==='Extreme'||groups[0].sev==='Severe'?'v2-accent-red':'v2-accent-amber');
    }
    if(box){
      box.innerHTML=groups.slice(0,4).map(g=>
        '<div class="v2-alert"><span class="v2-alert-st">'+esc(g.sev)+'</span>'
        +'<span class="v2-alert-name">'+esc(g.event)+'</span>'
        +'<span class="v2-alert-n">'+g.n+'</span></div>').join('');
      box.style.display='';
    }
  }catch(e){
    // A weather outage must not look like a broken page: say so and move on.
    val.textContent='Unavailable';
    if(tile){tile.classList.remove('v2-accent-amber','v2-accent-red');tile.classList.add('v2-accent-blue');}
  }
}

function renderVehicleDetail(){
  const v=VEHICLES.find(v=>v.id===currentVehicleId);
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    back:'<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    wrench:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
    brake:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M21 12h-3M6 12H3"/>',
    tyre:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
    clip:'<path d="M9 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/>',
    truck:'<path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l3 3v5h-2"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    oil:'<path d="M12 22a7 7 0 0 0 7-7c0-5-7-13-7-13S5 10 5 15a7 7 0 0 0 7 7Z"/>',
    send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    trash:'<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    check:'<path d="m5 12 5 5L20 7"/>',
    hist:'<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
  };
  if(!v) return '<div class="v2-region"><div class="v2-page-head"><h1>Vehicle not found</h1>'
    +'<p>This truck may have been deleted.</p></div>'
    +'<button class="v2-btn-ghost" type="button" onclick="navigate(\'vehicles\')">'+_sv(_IC.back,'2')+'Back to Vehicles</button></div>';

  const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
  const s=getVehicleStatus(v.id);
  const maint=MAINTENANCE.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
  const brakes=BRAKE_TESTS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.testDate.localeCompare(a.testDate));
  const tyres=TYRE_RECORDS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.photoDate.localeCompare(a.photoDate));
  const dots=DOT_INSPECTIONS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.inspectionDate.localeCompare(a.inspectionDate));
  const svcs=SERVICE_RECORDS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));

  const tabs=[['maintenance','Service',_IC.wrench],['brakes','Brakes',_IC.brake],['tyres','Tyres',_IC.tyre],['dot','DOT',_IC.clip],['pti','PTI',_IC.truck]];
  const tone=s.critical?'is-crit':s.warning?'is-warn':'is-ok';
  const label=s.critical?'Critical':s.warning?'Warning':'Roadworthy';
  const _ini=n=>String(n||'').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase();
  // Panel shell used by every card on the page.
  const panel=(accent,icon,title,tag,body)=>'<section class="v2-table-card">'
    +'<div class="v2-panel-head '+accent+'"><span class="v2-panel-ic">'+_sv(icon)+'</span>'
    +'<h2>'+title+'</h2>'+(tag?'<span class="v2-panel-tag">'+tag+'</span>':'')+'</div>'
    +body+'</section>';
  const row=(main,right)=>'<div class="v2-phone-item">'+main+right+'</div>';
  // Takes the whole onclick attribute rather than a function NAME, so every
  // handler appears literally in the source. Built from a variable it still
  // fired, but nothing could grep for it — including check-contracts.js, which
  // reported all five deletes as dropped when they were not.
  const del=(onclickAttr,what)=>isAdmin()?'<button class="v2-icon-btn" type="button" '+onclickAttr+' aria-label="Delete '+what+'" title="Delete">'+_sv(_IC.trash)+'</button>':'';

  let html='<div class="v2-region">';

  // ── Header ────────────────────────────────────────────────────────────────
  html+='<div class="v2-page-head" style="display:flex;align-items:center;gap:var(--v2-s5);margin-bottom:var(--v2-s6)">'
    +'<button class="v2-btn-ghost" type="button" onclick="navigate(\'vehicles\')">'+_sv(_IC.back,'2')+'Back</button>'
    +'<span style="display:flex;align-items:center;gap:var(--v2-s3);min-width:0">'
      +'<span class="v2-disp-avatar">'+esc(_ini(v.truckNumber)||'#')+'</span>'
      +'<span class="v2-disp-id"><span class="v2-disp-name">Truck #'+esc(v.truckNumber)+'</span>'
      +'<span class="v2-disp-meta">Trailer #'+esc(v.trailerNumber||'—')
        +(driver?' &middot; '+esc(driver.name):'')
        +(v.assignedDispatcher?' &middot; '+esc(v.assignedDispatcher):'')+'</span></span>'
    +'</span>'
    +'<span class="v2-chip-status '+(s.critical?'is-defect':s.warning?'is-minor':'is-pass')+'" style="margin-left:auto">'+label+'</span>'
  +'</div>';

  if(!isAdmin()) html+=dispatcherNotice();

  // setVTab only sets currentVehicleTab and re-renders, so the active state is
  // decided here rather than by class juggling in the handler.
  html+='<nav class="v2-subtabs" aria-label="Vehicle record sections">';
  tabs.forEach(t=>{
    html+='<button class="v2-subtab'+(currentVehicleTab===t[0]?' is-active':'')+'" type="button"'
      +(currentVehicleTab===t[0]?' aria-current="page"':'')
      +' onclick="setVTab(\''+t[0]+'\')">'+_sv(t[2],'1.8')+t[1]+'</button>';
  });
  html+='</nav>';

  // ── Service ───────────────────────────────────────────────────────────────
  if(currentVehicleTab==='maintenance'){
    const allSvc=[].concat(
      maint.map(r=>Object.assign({},r,{_type:'maint',_date:r.serviceDate})),
      svcs.map(r=>Object.assign({},r,{_type:'svc',_date:r.serviceDate}))
    ).sort((a,b)=>b._date.localeCompare(a._date));
    const nextDue=maint[0]&&maint[0].nextInspectionDate?maint[0].nextInspectionDate:null;
    const nextDays=nextDue?daysBetween(today(),nextDue):null;

    html+='<div class="v2-rem-grid">';
    if(isAdmin()){
      // toggle-btn / active-pass are production class names on purpose:
      // setServiceResult() rewrites className and would strip anything else.
      html+=panel('v2-accent-primary',_IC.wrench,'Record service','Admin only',
        '<div style="padding:var(--v2-s5)"><div class="v2-form-grid">'
        +'<div class="v2-field"><label for="svc-date">Service date</label>'
          +'<input class="v2-input" type="date" id="svc-date" value="'+today()+'" max="'+today()+'"/></div>'
        +'<div class="v2-field"><label>Result</label><div class="toggle-group">'
          +'<button class="toggle-btn active-pass" id="svctog-pass" onclick="setServiceResult(\'pass\')">Pass</button>'
          +'<button class="toggle-btn" id="svctog-fail" onclick="setServiceResult(\'fail\')">Fail</button></div></div>'
        +'<div class="v2-field" style="grid-column:1/-1"><label for="svc-notes">Notes</label>'
          +'<textarea class="v2-input" id="svc-notes" rows="2" placeholder="Optional"></textarea></div>'
        +'</div><div class="v2-add-foot"><button class="v2-btn-primary" type="button" onclick="doAddUnifiedService(\''+v.id+'\')">'
        +_sv(_IC.check,'2.2')+'Save service record</button></div></div>');

      html+=panel('v2-accent-amber',_IC.oil,'PM / oil change request',null,
        '<div style="padding:var(--v2-s5)">'
        +(v.assignedDriverId
          ? '<p class="v2-rem-hint">Texts '+(driver?esc(driver.name):'the driver')+' to route to any TA or Love&rsquo;s for an oil change and send the receipt back.</p>'
            +'<button class="v2-btn-primary" type="button" onclick="doSendPM(\''+v.assignedDriverId+'\',\''+v.id+'\',\''+esc(v.truckNumber)+'\')">'
            +_sv(_IC.send,'2')+'Send PM request'+(driver?' to '+esc(driver.name):'')+'</button>'
            +'<p class="v2-send-notice">Sent only when you click &mdash; never automatically.</p>'
          : '<div class="v2-override-empty">No driver assigned &mdash; assign one to send a PM request.</div>')
        +'</div>');
    }
    let body='';
    if(s.serviceOverdue||s.serviceDueSoon){
      body+='<div class="v2-stream"><div class="v2-stream-row '+(s.serviceOverdue?'v2-accent-red':'v2-accent-amber')+'">'
        +'<span class="v2-stream-ic">'+_sv(_IC.wrench)+'</span>'
        +'<span class="v2-stream-main"><span class="v2-stream-label">'
        +(s.serviceOverdue?'Service overdue':'Service due soon')+'</span>'
        +'<span class="v2-stream-type">'+s.serviceDays+' days since the last service</span></span></div></div>';
    }
    body+='<div class="v2-phone-list">';
    if(allSvc.length===0) body+='<div class="v2-override-empty">No records yet</div>';
    allSvc.forEach(r=>{
      const isMaint=r._type==='maint';
      body+=row('<span class="v2-phone-who" style="flex:1;min-width:0">'
        +'<span class="v2-phone-who-name">'+fmtDate(r.serviceDate)+'</span>'
        +'<span class="v2-phone-who-truck">'+(isMaint?'Next due '+fmtDate(r.nextInspectionDate):'')
        +(r.notes?(isMaint?' &middot; ':'')+esc(r.notes):'')+'</span></span>',
        '<span class="v2-phone-badge '+(isMaint?'is-none':(r.result==='pass'?'is-ok':'is-crit'))+'">'
        +(isMaint?'Logged':String(r.result).toUpperCase())+'</span>'
        +del(isMaint?' onclick="doDeleteMaintenance(\''+r.id+'\')"': ' onclick="doDeleteService(\''+r.id+'\')"','service record'));
    });
    body+='</div>';
    html+=panel('v2-accent-cyan',_IC.hist,'Service history',allSvc.length+(nextDue?' &middot; next '+fmtDate(nextDue)+(nextDays!==null&&nextDays<0?' (overdue)':''):''),body);
    html+='</div>';
  }

  // ── Brakes ────────────────────────────────────────────────────────────────
  if(currentVehicleTab==='brakes'){
    html+='<div class="v2-rem-grid">';
    if(isAdmin()){
      html+=panel('v2-accent-primary',_IC.brake,'Record brake test','Admin only',
        '<div style="padding:var(--v2-s5)"><div class="v2-form-grid">'
        +'<div class="v2-field"><label for="b-date">Test date</label>'
          +'<input class="v2-input" type="date" id="b-date" value="'+today()+'" max="'+today()+'"/></div>'
        +'<div class="v2-field"><label>Result</label><div class="toggle-group">'
          +'<button class="toggle-btn active-pass" id="btog-pass" onclick="setBrakeResult(\'pass\')">Pass</button>'
          +'<button class="toggle-btn" id="btog-fail" onclick="setBrakeResult(\'fail\')">Fail</button></div></div>'
        +'<div class="v2-field" style="grid-column:1/-1"><label for="b-notes">Notes</label>'
          +'<textarea class="v2-input" id="b-notes" rows="2" placeholder="Optional"></textarea></div>'
        +'</div><div class="v2-add-foot"><button class="v2-btn-primary" type="button" onclick="doAddBrake(\''+v.id+'\')">'
        +_sv(_IC.check,'2.2')+'Save brake test</button></div></div>');
    }
    let body='<div class="v2-phone-list">';
    if(brakes.length===0) body+='<div class="v2-override-empty">No tests yet</div>';
    brakes.forEach(r=>{
      body+=row('<span class="v2-phone-who" style="flex:1;min-width:0">'
        +'<span class="v2-phone-who-name">'+fmtDate(r.testDate)+'</span>'
        +(r.notes?'<span class="v2-phone-who-truck">'+esc(r.notes)+'</span>':'')+'</span>',
        '<span class="v2-phone-badge '+(r.result==='pass'?'is-ok':'is-crit')+'">'+String(r.result).toUpperCase()+'</span>'
        +del(' onclick="doDeleteBrake(\''+r.id+'\')"','brake test'));
    });
    body+='</div>';
    html+=panel('v2-accent-cyan',_IC.hist,'Brake history',brakes.length,body);
    html+='</div>';
  }

  // ── Tyres ─────────────────────────────────────────────────────────────────
  if(currentVehicleTab==='tyres'){
    html+='<div class="v2-rem-grid">';
    if(isAdmin()){
      // The whole grid keeps production markup. updateTyreDot() rewrites
      // className on the dot, and the select ids are read positionally by
      // doAddTyre(), so neither can be renamed.
      let grid='<div style="padding:var(--v2-s5)">'
        +'<div class="v2-field" style="margin-bottom:var(--v2-s4)"><label for="t-date">Photo date</label>'
        +'<input class="v2-input" type="date" id="t-date" value="'+today()+'" max="'+today()+'"/></div>'
        +'<div class="tyre-grid">';
      AXLES.forEach(function(axle,ai){
        grid+='<div class="axle-row"><div class="axle-name">'+axle.name+'</div><div class="tyre-selects">';
        axle.sides.forEach(function(pos){
          grid+='<div class="tyre-select-row"><label>'+pos.replace('-','<br>')+'</label>'
            +'<select id="t-'+ai+'-'+pos+'" onchange="updateTyreDot(this,\'t-dot-'+ai+'-'+pos+'\')">'
            +'<option value="good">Good</option><option value="bad">Bad</option><option value="uneven">Uneven</option></select>'
            +'<div class="tyre-dot dot-good" id="t-dot-'+ai+'-'+pos+'"></div></div>';
        });
        grid+='</div></div>';
      });
      grid+='</div><div class="v2-add-foot"><button class="v2-btn-primary" type="button" onclick="doAddTyre(\''+v.id+'\')">'
        +_sv(_IC.check,'2.2')+'Save tyre record</button></div></div>';
      html+=panel('v2-accent-primary',_IC.tyre,'Record tyre check','Admin only',grid);
    }
    let body='<div class="v2-phone-list">';
    if(tyres.length===0) body+='<div class="v2-override-empty">No tyre records yet</div>';
    tyres.forEach(r=>{
      const readings=Array.isArray(r.readings)?r.readings:[];
      const hasBad=readings.some(x=>x.status==='bad'), hasUneven=readings.some(x=>x.status==='uneven');
      const dotsHtml=readings.map(x=>'<div class="tyre-dot '+(x.status==='good'?'dot-good':x.status==='bad'?'dot-bad':'dot-uneven')+'" title="'+esc(x.position)+': '+esc(x.status)+'"></div>').join('');
      body+=row('<span class="v2-phone-who" style="flex:1;min-width:0">'
        +'<span class="v2-phone-who-name">'+fmtDate(r.photoDate)+'</span>'
        +'<span style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">'+dotsHtml+'</span></span>',
        '<span class="v2-phone-badge '+(hasBad?'is-crit':hasUneven?'is-warn':'is-ok')+'">'
        +(hasBad?'Bad':hasUneven?'Uneven':'OK')+'</span>'
        +del(' onclick="doDeleteTyre(\''+r.id+'\')"','tyre record'));
    });
    body+='</div>';
    html+=panel('v2-accent-cyan',_IC.hist,'Tyre history',tyres.length,body);
    html+='</div>';
  }

  // ── DOT ───────────────────────────────────────────────────────────────────
  if(currentVehicleTab==='dot'){
    html+='<div class="v2-rem-grid">';
    if(isAdmin()){
      html+=panel('v2-accent-primary',_IC.clip,'Record DOT inspection','Admin only',
        '<div style="padding:var(--v2-s5)"><div class="v2-form-grid">'
        +'<div class="v2-field"><label for="d-date">Inspection date</label>'
          +'<input class="v2-input" type="date" id="d-date" value="'+today()+'" max="'+today()+'"/></div>'
        +'<div class="v2-field"><label for="d-driver">Driver</label><span class="v2-select-wrap">'
          +'<select class="v2-select" id="d-driver"><option value="">&mdash; select &mdash;</option>'
          +DRIVERS.map(d=>'<option value="'+d.id+'">'+esc(d.name)+'</option>').join('')
          +'</select>'+_sv('<path d="m6 9 6 6 6-6"/>','1.8')+'</span></div>'
        +'<div class="v2-field" style="grid-column:1/-1"><label>Result</label><div class="toggle-group">'
          +'<button class="toggle-btn active-pass" id="dtog-pass" onclick="setDotResult(\'pass\')">Pass</button>'
          +'<button class="toggle-btn" id="dtog-violation" onclick="setDotResult(\'violation\')">Violation</button>'
          +'<button class="toggle-btn" id="dtog-oos" onclick="setDotResult(\'oos\')">Out of service</button></div></div>'
        +'<div class="v2-field" style="grid-column:1/-1"><label for="d-notes">Notes</label>'
          +'<textarea class="v2-input" id="d-notes" rows="2" placeholder="Optional"></textarea></div>'
        +'</div><div class="v2-add-foot"><button class="v2-btn-primary" type="button" onclick="doAddDOT(\''+v.id+'\')">'
        +_sv(_IC.check,'2.2')+'Save DOT inspection</button></div></div>');
    }
    let body='<div class="v2-phone-list">';
    if(dots.length===0) body+='<div class="v2-override-empty">No DOT inspections recorded</div>';
    dots.forEach(r=>{
      const dn=DRIVERS.find(d=>d.id===r.driverId);
      body+=row('<span class="v2-phone-who" style="flex:1;min-width:0">'
        +'<span class="v2-phone-who-name">'+fmtDate(r.inspectionDate)+'</span>'
        +'<span class="v2-phone-who-truck">'+(dn?esc(dn.name):'')+(r.notes?(dn?' &middot; ':'')+esc(r.notes):'')+'</span></span>',
        '<span class="v2-phone-badge '+(r.result==='pass'?'is-ok':r.result==='violation'?'is-warn':'is-crit')+'">'
        +String(r.result).toUpperCase()+'</span>'
        +del(' onclick="doDeleteDOT(\''+r.id+'\')"','DOT inspection'));
    });
    body+='</div>';
    html+=panel('v2-accent-cyan',_IC.hist,'DOT history',dots.length,body);
    html+='</div>';
  }

  // ── PTI ───────────────────────────────────────────────────────────────────
  if(currentVehicleTab==='pti'){
    const preTrips=INSPECTIONS.filter(r=>r.vehicleId===v.id).sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')));
    const lastLink=LINK_SENDS.filter(r=>r.status==='sent'&&(r.vehicleId===v.id||(v.assignedDriverId&&r.driverId===v.assignedDriverId)))
      .sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0];

    html+='<div class="v2-rem-grid">';
    html+=panel('v2-accent-primary',_IC.send,'Send pre-trip link','Last sent: '+(lastLink?fmtDate(lastLink.createdAt):'never'),
      '<div style="padding:var(--v2-s5)">'
      +(v.assignedDriverId
        ? '<p class="v2-rem-hint">Text the driver a link to complete a fresh pre-trip inspection. Tyre photos are required.</p>'
          +'<button class="v2-btn-primary" type="button" onclick="doSendLink(\''+v.assignedDriverId+'\',\''+v.id+'\',\''+esc(v.truckNumber)+'\')">'
          +_sv(_IC.send,'2')+'Send PTI link'+(driver?' to '+esc(driver.name):'')+'</button>'
          +'<p class="v2-send-notice">Sent only when you click &mdash; never automatically.</p>'
        : '<div class="v2-override-empty">No driver assigned &mdash; assign one to send a PTI link.</div>')
      +'</div>');

    let body='<div class="v2-phone-list">';
    if(preTrips.length===0) body+='<div class="v2-override-empty">No pre-trip inspections yet</div>';
    preTrips.forEach(r=>{
      const rt=r.overallResult==='defect'?'is-crit':r.overallResult==='minor'?'is-warn':'is-ok';
      const rl=r.overallResult==='defect'?'Defect':r.overallResult==='minor'?'Minor':'Roadworthy';
      const dn=DRIVERS.find(d=>d.id===r.driverId);
      const flags=[];
      if(r.tyresFlagged) flags.push(r.tyresFlagged+' tyre'+(r.tyresFlagged>1?'s':'')+' flagged');
      if(r.checksFailed) flags.push(r.checksFailed+' check'+(r.checksFailed>1?'s':'')+' failed');
      const isOpen=isOpenDefect(r);
      const repair=isOpen?'<span class="v2-cell-never">Not repaired</span>'
        :(r.repairStatus==='repaired'||r.repairStatus==='deferred')
          ?'<span class="v2-cell-dim">'+(r.repairStatus==='repaired'?'Repaired':'Deferred')
            +(r.repairedAt?' &middot; '+fmtDate(r.repairedAt):'')+(r.repairNotes?' &middot; '+esc(r.repairNotes):'')+'</span>'
          :'';
      const sub=[dn?esc(dn.name):'',flags.length?'<span class="v2-cell-never">'+flags.join(' &middot; ')+'</span>':'',repair].filter(Boolean).join(' &middot; ');
      body+='<div class="v2-phone-item">'
        +'<span class="v2-phone-who" style="flex:1;min-width:0;cursor:pointer" onclick="openInspection(\''+r.id+'\')" title="Open full inspection">'
          +'<span class="v2-phone-who-name">'+inspDT(r.submittedAt)+'</span>'
          +'<span class="v2-phone-who-truck">'+sub+'</span></span>'
        +'<span class="v2-phone-badge '+rt+'">'+rl+'</span>'
        // class AND data-insp are both required: render() binds this by
        // querySelectorAll('.mark-repaired-btn') and reads dataset.insp.
        +(isOpen&&isAdmin()?'<button class="v2-btn-repair mark-repaired-btn" type="button" data-insp="'+esc(r.id)+'">'+_sv(_IC.check,'2.2')+'Repaired</button>':'')
      +'</div>';
    });
    body+='</div>';
    html+=panel('v2-accent-cyan',_IC.hist,'Pre-trip history',preTrips.length,body);
    html+='</div>';
  }

  html+='</div>';
  return html;
}

// Close out a pre-trip defect. Admin-only: this is a compliance assertion, and
// RLS (insp_update_admin) enforces it server-side regardless of this check.
async function doMarkRepaired(inspectionId){
  if(!isAdmin()) return;
  const rec=INSPECTIONS.find(r=>r.id===inspectionId);
  if(!rec||!isOpenDefect(rec)) return;
  // confirm2 defaults to a red "Delete" button — pass an explicit label and
  // class, or closing a defect looks like it destroys the inspection record.
  const ok=await confirm2(
    `Mark defect repaired on Truck #${rec.truckNumber||''}?`,
    'Records you as closing it, with the date and time. The truck clears its red status once saved. The inspection record itself is kept.',
    '✓ Mark Repaired','btn btn-success');
  if(!ok) return;
  const stamp=new Date().toISOString();
  const {error}=await sb.from('inspections')
    .update({repair_status:'repaired',repaired_by:currentUser?.id??null,repaired_at:stamp})
    .eq('id',inspectionId);
  if(error){ console.error('mark repaired failed',error); showToast('Could not save — try again','danger'); return; }
  // Mirror locally so the pill clears without waiting for the 30s refresh.
  rec.repairStatus='repaired'; rec.repairedAt=stamp;
  showToast('Defect marked repaired','success');
  render();
}

let _brakeResult='pass',_dotResult='pass',_serviceResult='pass';
function setVTab(t){currentVehicleTab=t;render();}
function setBrakeResult(r){_brakeResult=r;['pass','fail'].forEach(x=>{const el=document.getElementById('btog-'+x);if(el)el.className='toggle-btn'+(x===r?' active-'+x:'');});}
function setDotResult(r){_dotResult=r;['pass','violation','oos'].forEach(x=>{const el=document.getElementById('dtog-'+x);if(el)el.className='toggle-btn'+(x===r?' active-'+x:'');});}
function setServiceResult(r){_serviceResult=r;['pass','fail'].forEach(x=>{const el=document.getElementById('svctog-'+x);if(el)el.className='toggle-btn'+(x===r?' active-'+x:'');});}
function updateTyreDot(sel,dotId){const dot=document.getElementById(dotId);if(!dot)return;dot.className='tyre-dot '+(sel.value==='good'?'dot-good':sel.value==='bad'?'dot-bad':'dot-uneven');}

async function doAddUnifiedService(vid){if(!isAdmin())return;const date=document.getElementById('svc-date').value,notes=document.getElementById('svc-notes').value.trim();if(!date){showToast('Select a service date','danger');return;}await Promise.all([addMaintenance(vid,date,notes||null),addServiceRecord(vid,date,_serviceResult,notes||null)]);showToast('Service record saved!','success');render();}
async function doAddMaintenance(vid){if(!isAdmin())return;const date=document.getElementById('m-date')?document.getElementById('m-date').value:'';const notes=document.getElementById('m-notes')?document.getElementById('m-notes').value.trim():'';if(!date){showToast('Select a service date','danger');return;}await addMaintenance(vid,date,notes||null);showToast('Service record saved!','success');render();}
async function doAddBrake(vid){if(!isAdmin())return;const date=document.getElementById('b-date').value,notes=document.getElementById('b-notes').value.trim();if(!date){showToast('Select a test date','danger');return;}await addBrakeTest(vid,date,_brakeResult,notes||null);showToast('Brake test saved!','success');render();}
async function doAddTyre(vid){if(!isAdmin())return;const date=document.getElementById('t-date').value;if(!date){showToast('Select a photo date','danger');return;}const readings=[];AXLES.forEach((axle,ai)=>{axle.sides.forEach(pos=>{const el=document.getElementById(`t-${ai}-${pos}`);if(el)readings.push({axleIndex:ai,position:pos,status:el.value});});});await addTyreRecord(vid,date,readings);showToast('Tyre record saved!','success');render();}
async function doAddService(vid){if(!isAdmin())return;const date=document.getElementById('svc-date').value,notes=document.getElementById('svc-notes').value.trim();if(!date){showToast('Select a service date','danger');return;}await addServiceRecord(vid,date,_serviceResult,notes||null);showToast('Service record saved!','success');render();}
async function doAddDOT(vid){if(!isAdmin())return;const date=document.getElementById('d-date').value,driver=document.getElementById('d-driver').value,notes=document.getElementById('d-notes').value.trim();if(!date){showToast('Select an inspection date','danger');return;}await addDOTInspection(vid,driver||null,date,_dotResult,notes||null);showToast('DOT inspection saved!','success');render();}
async function doAddMileage(vid){if(!isAdmin())return;const val=parseInt(document.getElementById('mil-val').value),driver=document.getElementById('mil-driver').value;if(!val||val<=0){showToast('Enter a valid mileage','danger');return;}await addMileage(vid,driver||null,val);showToast('Mileage saved!','success');render();}
async function doDeleteMaintenance(id){if(!isAdmin())return;const ok=await confirm2('Delete this service record?','Cannot be undone.');if(!ok)return;await deleteMaintenance(id);showToast('Deleted','warning');render();}
async function doDeleteBrake(id){if(!isAdmin())return;const ok=await confirm2('Delete this brake test?','Cannot be undone.');if(!ok)return;await deleteBrakeTest(id);showToast('Deleted','warning');render();}
async function doDeleteTyre(id){if(!isAdmin())return;const ok=await confirm2('Delete this tyre record?','Cannot be undone.');if(!ok)return;await deleteTyreRecord(id);showToast('Deleted','warning');render();}
async function doDeleteService(id){if(!isAdmin())return;const ok=await confirm2('Delete this service record?','Cannot be undone.');if(!ok)return;await deleteServiceRecord(id);showToast('Deleted','warning');render();}
async function doDeleteDOT(id){if(!isAdmin())return;const ok=await confirm2('Delete this DOT inspection?','Cannot be undone.');if(!ok)return;await deleteDOTInspection(id);showToast('Deleted','warning');render();}

// ═══════════════════════════════════════════════════════
// DRIVERS
// ═══════════════════════════════════════════════════════
function renderDrivers(){
  // v2 components against live data. Styles: v2-tokens + v2-bridge +
  // v2-drivers.css (+ v2-vehicles.css for the form controls, v2-inspections.css
  // for the table shell).
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'2')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash:'<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    palm:'<path d="M2 21h20"/><path d="M12 21V10"/><path d="M12 10c0-4 3-7 7-7-1 4-3 7-7 7Z"/><path d="M12 10c0-4-3-7-7-7 1 4 3 7 7 7Z"/>',
    back:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    user:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    // Marks the Cell column header: the data behind it is admin-only by RLS.
    lock:'<rect x="4" y="10.5" width="16" height="11" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  };
  // Initials for the avatar, derived from the name already on screen.
  const _ini=n=>String(n||'').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase()||'?';

  // Both conditions are needed, and it is worth being precise about why.
  // driver_phones RLS is `FOR SELECT TO authenticated USING (is_admin())`, which
  // returns a dispatcher ZERO ROWS AND NO ERROR — so PHONES_AVAILABLE is true
  // for them too, just with an empty map. Gating on that alone would render the
  // Cell column for dispatchers, reading "No number" on every row, with an Add
  // button their write RLS would then refuse. PHONES_AVAILABLE only answers
  // "did the table respond at all"; isAdmin() answers "may this person see it".
  const showPhones = isAdmin() && PHONES_AVAILABLE;

  // Roster counts, all from data already loaded. Assigned + unassigned = total;
  // on vacation deliberately overlaps both, because it is a state a driver is
  // in rather than a fourth bucket they belong to.
  const _assignedIds=new Set(VEHICLES.map(v=>v.assignedDriverId).filter(Boolean));
  const _assigned=DRIVERS.filter(d=>_assignedIds.has(d.id)).length;
  const _unassigned=DRIVERS.length-_assigned;
  const _onVac=DRIVERS.filter(d=>d.on_vacation).length;

  let html='<div class="v2-region">';

  // The live app puts the page name in #page-title in the topbar, so this
  // heading is the subtitle's carrier more than the title's. Kept because the
  // one-line description is the only place the page says what it is for.
  html+='<div class="v2-page-head"><h1>Drivers</h1>'
    +'<p>Who drives what, who can be reached, and who is away.</p></div>';

  html+='<section class="v2-console-row" aria-label="Driver summary and add">'
    +'<article class="v2-console v2-accent-cyan"><div class="v2-console-head">'
    +'<span class="v2-console-ic">'+_sv(_IC.users)+'</span><h2>Driver roster</h2></div>'
    +'<div class="v2-console-body"><div class="v2-pulse-grid">'
      +'<div class="v2-pulse-stat v2-accent-cyan"><span class="v2-pulse-num">'+DRIVERS.length+'</span><span class="v2-pulse-label">Total drivers</span></div>'
      +'<div class="v2-pulse-stat v2-accent-green"><span class="v2-pulse-num">'+_assigned+'</span><span class="v2-pulse-label">Assigned</span></div>'
      +'<div class="v2-pulse-stat '+(_unassigned?'v2-accent-blue':'v2-accent-green')+'"><span class="v2-pulse-num">'+_unassigned+'</span><span class="v2-pulse-label">Unassigned</span></div>'
      +'<div class="v2-pulse-stat '+(_onVac?'v2-accent-amber':'v2-accent-green')+'"><span class="v2-pulse-num">'+_onVac+'</span><span class="v2-pulse-label">On vacation</span></div>'
    +'</div></div></article>';

  if(isAdmin()){
    html+='<article class="v2-console v2-accent-primary" aria-label="Add driver">'
      +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.user)+'</span>'
      +'<h2>Add driver</h2><span class="v2-console-note">Admin only</span></div>'
      +'<div class="v2-console-body"><div class="v2-form-grid">'
        +'<div class="v2-field"><label for="d-name">Full name <span class="v2-field-req">*</span></label>'
        // id, the Enter binding and doAddDriver() are all load-bearing
        +'<input class="v2-input" id="d-name" type="text" placeholder="Full name" onkeydown="if(event.key===\'Enter\')doAddDriver()"/></div>'
        // Cell number only appears when this session can actually read the
        // table, so the field is never offered to someone whose write RLS
        // would refuse it anyway.
        +(showPhones?'<div class="v2-field"><label for="d-phone">Cell number</label>'
          +'<input class="v2-input" id="d-phone" type="tel" inputmode="tel" autocomplete="off"'
          +' placeholder="(262) 555-0142" onkeydown="if(event.key===\'Enter\')doAddDriver()"/></div>':'')
      +'</div>'
      +(showPhones?'<p class="v2-add-hint">Optional. Stored in E.164 (<code>+12625550142</code>) in the admin-only <code>driver_phones</code> table, never on the driver record. 10 digits are assumed US.</p>':'')
      +'<div class="v2-add-foot"><button class="v2-btn-primary" type="button" onclick="doAddDriver()">'
      +_sv(_IC.plus,'2.2')+'Add driver</button></div>'
      +'</div></article>';
  }
  html+='</section>';
  // Dispatchers get the roster card above but no add form, so the notice sits
  // after the row rather than inside it.
  if(!isAdmin()) html+=dispatcherNotice();

  html+='<section class="v2-table-card" aria-label="Driver directory">'
    +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.users)+'</span>'
    +'<h2>All drivers</h2><span class="v2-console-note">'+DRIVERS.length+' total</span></div>'
    +'<div class="v2-table-wrap"><table class="v2-table v2-drv-table"><thead><tr>'
    +'<th>Driver</th>'
    // Absent entirely for dispatchers rather than present-and-empty — see the
    // showPhones note above for why RLS alone is not enough to decide this.
    // so the column is absent for them rather than present-and-empty.
    +(showPhones?'<th><span class="v2-th-locked">'+_sv(_IC.lock,'2')+'Cell</span></th>':'')
    +'<th>Assigned truck</th><th>Dispatcher</th><th>Status</th>'
    +(isAdmin()?'<th>Actions</th>':'')
    +'</tr></thead><tbody>';

  const _cols=1+(showPhones?1:0)+3+(isAdmin()?1:0);
  if(DRIVERS.length===0){
    html+='<tr><td colspan="'+_cols+'" style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No drivers added yet</td></tr>';
  }

  DRIVERS.forEach(d=>{
    const assignedVehicles=VEHICLES.filter(v=>v.assignedDriverId===d.id);
    const trucks=assignedVehicles.map(v=>'<span class="v2-truck-chip">#'+esc(v.truckNumber)+'</span>').join('');
    const dispatchers=[...new Set(assignedVehicles.map(v=>v.assignedDispatcher).filter(Boolean))].map(esc).join(', ');
    const isVac=!!d.on_vacation;
    // Three states, all from data the page already has: the vacation flag, and
    // whether any vehicle points at this driver.
    const st=isVac?['is-vacation','Vacation']:assignedVehicles.length?['is-active','Active']:['is-unassigned','Unassigned'];
    html+='<tr id="driver-row-'+d.id+'" class="v2-drv-row'+(isVac?' is-vacation':'')+'">'
      +'<td>'
        // .v2-drv is display:flex, which is what startEditDriver forces it back to
        +'<div id="driver-view-'+d.id+'" class="v2-drv">'
          +'<span class="v2-drv-avatar">'+esc(_ini(d.name))+'</span>'
          +'<span class="v2-drv-meta"><span class="v2-drv-name">'+esc(d.name)+'</span></span>'
        +'</div>'
        +'<div id="driver-edit-'+d.id+'" style="display:none;gap:var(--v2-s2);align-items:center">'
          +'<input class="v2-input" type="text" value="'+esc(d.name)+'" id="dedit-'+d.id+'" style="flex:1;min-width:120px"/>'
          +'<button class="v2-btn-primary" type="button" onclick="doUpdateDriver(\''+d.id+'\')">Save</button>'
          +'<button class="v2-btn-ghost" type="button" onclick="cancelEditDriver(\''+d.id+'\')">Cancel</button>'
        +'</div>'
      +'</td>';
    if(showPhones){
      const ph=PHONES_BY_DRIVER[d.id];
      html+='<td>'
        // .v2-phone / .v2-phone-none are inline-flex; cancelEditPhone restores
        // exactly that, never plain flex.
        +'<span id="phone-view-'+d.id+'" class="'+(ph?'v2-phone':'v2-phone-none')+'">'
          +(ph?'<span class="v2-phone-num">'+esc(fmtPhone(ph.number))+'</span>':'<span>No number</span>')
          +'<button class="v2-phone-edit" type="button" onclick="startEditPhone(\''+d.id+'\')"'
          +' title="'+(ph?'Edit':'Add')+' cell number" aria-label="'+(ph?'Edit':'Add')+' cell number for '+esc(d.name)+'">'
          +_sv(_IC.edit)+'</button>'
        +'</span>'
        +'<span id="phone-edit-'+d.id+'" style="display:none;gap:var(--v2-s2);align-items:center">'
          +'<input class="v2-input" id="dphone-'+d.id+'" type="tel" inputmode="tel" autocomplete="off"'
          +' value="'+esc(ph?ph.number:'')+'" placeholder="(262) 555-0142" style="width:150px"'
          +' onkeydown="if(event.key===\'Enter\')doSaveDriverPhone(\''+d.id+'\');if(event.key===\'Escape\')cancelEditPhone(\''+d.id+'\')"/>'
          +'<button class="v2-btn-primary" type="button" onclick="doSaveDriverPhone(\''+d.id+'\')">Save</button>'
          +'<button class="v2-btn-ghost" type="button" onclick="cancelEditPhone(\''+d.id+'\')">Cancel</button>'
        +'</span>'
      +'</td>';
    }
    html+='<td>'+(trucks?'<span class="v2-truck-list">'+trucks+'</span>':'<span class="v2-cell-none">&mdash;</span>')+'</td>'
      +'<td>'+(dispatchers?'<span class="v2-disp-list">'+dispatchers+'</span>':'<span class="v2-cell-none">&mdash;</span>')+'</td>'
      +'<td><span class="v2-drv-status '+st[0]+'">'+st[1]+'</span></td>';
    if(isAdmin()){
      // .v2-actions is display:flex, which cancelEditDriver forces it back to
      html+='<td><span class="v2-actions" id="driver-btns-'+d.id+'">'
        +(isVac
          ?'<button class="v2-act-return" type="button" onclick="toggleDriverVacation(\''+d.id+'\',false)" title="Return from vacation" aria-label="Return '+esc(d.name)+' from vacation">'+_sv(_IC.back,'2')+'Return</button>'
          :'<button class="v2-act" type="button" onclick="startEditDriver(\''+d.id+'\')" title="Edit" aria-label="Edit '+esc(d.name)+'">'+_sv(_IC.edit)+'</button>'
           // the single-quote escape here is the production original, kept as-is
           +'<button class="v2-act is-danger" type="button" onclick="doDeleteDriver(\''+d.id+'\',\''+d.name.replace(/'/g,"\\'")+'\')" title="Delete" aria-label="Delete '+esc(d.name)+'">'+_sv(_IC.trash)+'</button>'
           +'<button class="v2-act is-vacation" type="button" onclick="toggleDriverVacation(\''+d.id+'\',true)" title="Set on vacation" aria-label="Set '+esc(d.name)+' on vacation">'+_sv(_IC.palm)+'</button>')
        +'</span></td>';
    }
    html+='</tr>';
  });

  html+='</tbody></table></div></section>';
  html+='</div>';
  return html;
}

async function doAddDriver(){
  if(!isAdmin())return;
  const name=document.getElementById('d-name').value.trim();
  if(!name){showToast('Enter a driver name','danger');return;}
  // Cell number is optional, and validated BEFORE the driver row is created so
  // a typo cannot leave a driver behind with no number and no warning.
  const phoneEl=document.getElementById('d-phone');
  const rawPhone=phoneEl?phoneEl.value.trim():'';
  let phone='';
  if(rawPhone){
    phone=normalizePhoneE164(rawPhone);
    if(!isE164(phone)){showToast('Enter a valid cell number, e.g. (262) 555-0142','danger');return;}
  }
  const rec=await addDriver(name);
  if(phone&&rec&&rec.id&&sb){
    const now=new Date().toISOString();
    const {error}=await sb.from('driver_phones')
      .upsert({driver_id:rec.id,phone_number:phone,verified:false,added_at:now,updated_at:now},{onConflict:'driver_id'});
    // The driver already exists at this point, so a failed number is reported
    // as its own problem rather than rolling anything back.
    if(error) showToast('Driver added, but the cell number failed: '+error.message,'warning');
    else PHONES_BY_DRIVER[rec.id]={number:phone,verified:false};
  }
  document.getElementById('d-name').value='';
  if(phoneEl) phoneEl.value='';
  showToast('Driver added!','success');
  render();
}
function startEditDriver(id){document.getElementById('driver-view-'+id).style.display='none';document.getElementById('driver-edit-'+id).style.display='flex';document.getElementById('driver-btns-'+id).style.display='none';document.getElementById('dedit-'+id).focus();}
function cancelEditDriver(id){document.getElementById('driver-view-'+id).style.display='flex';document.getElementById('driver-edit-'+id).style.display='none';document.getElementById('driver-btns-'+id).style.display='flex';}
async function doUpdateDriver(id){if(!isAdmin())return;const name=document.getElementById('dedit-'+id).value.trim();if(!name){showToast('Name cannot be empty','danger');return;}await updateDriver(id,name);showToast('Driver updated!','success');render();}
async function doDeleteDriver(id,name){if(!isAdmin())return;const ok=await confirm2(`Delete driver "${name}"?`,'This driver will be removed from all vehicles.');if(!ok)return;await deleteDriver(id);showToast('Driver deleted','warning');render();}

// ═══════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════
// Which clock the calendar is showing. Presentation state only — it filters
// events already computed, and never changes what is due.
let calFilter='all';
function calSetFilter(t){ calFilter=t; render(); }
function calToday(){ calendarMonth=new Date(); calendarMonth.setDate(1); render(); }

function renderCalendar(){
  const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth();
  const firstDay=new Date(year,month,1).getDay(),daysInMonth=new Date(year,month+1,0).getDate();
  const todayStr=today(),events=[];
  const _calVacSet=new Set(DRIVERS.filter(d=>d.on_vacation).map(d=>d.id));
  // Three clocks, one colour each, no overlap between them:
  //   yard    last service + vehSched(dot_inspection)   90 days by default
  //   brake   last brake test + vehSched(brake_service) 30 days by default
  //   annual  the DOT certificate expiry, entered by hand
  // Intervals come from vehSched so per-vehicle overrides and the new-truck
  // ladder are honoured; they are not hardcoded here.
  //
  // Date maths is UTC throughout. Parsing an ISO date as UTC midnight and then
  // stepping it with local setDate() shifts the result by a day when the
  // interval crosses a daylight-saving boundary.
  const _calAdd=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().split('T')[0];};
  VEHICLES.forEach(v=>{
    if(_calVacSet.has(v.assignedDriverId)) return;
    const brakes=BRAKE_TESTS.filter(b=>b.vehicleId===v.id).sort((a,b)=>b.testDate.localeCompare(a.testDate));
    const maint=MAINTENANCE.filter(m=>m.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
    const svcs=SERVICE_RECORDS.filter(x=>x.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
    const tn=esc(v.truckNumber);
    if(brakes[0]){
      const iv=vehSched(v.id,'brake_service').interval;
      events.push({date:_calAdd(brakes[0].testDate,iv),label:'Truck #'+tn+' brake inspection due ('+iv+'-day)',short:'#'+tn+' Brake',type:'brake',truck:tn,kind:'Brake inspection due',iv:iv});
    }
    const svcRefDate=(svcs[0]&&svcs[0].serviceDate)||(maint[0]&&maint[0].serviceDate)||null;
    if(svcRefDate){
      const iv=vehSched(v.id,'dot_inspection').interval;
      events.push({date:_calAdd(svcRefDate,iv),label:'Truck #'+tn+' yard / periodic inspection due ('+iv+'-day)',short:'#'+tn+' Yard',type:'yard',truck:tn,kind:'Yard / periodic inspection',iv:iv});
    }
    // Certificate expiry is a stored date, not an interval — nothing to add to.
    if(ANNUAL_AVAILABLE&&v.annualExpiry){
      events.push({date:v.annualExpiry,label:'Truck #'+tn+' annual DOT certificate expires',short:'#'+tn+' Annual',type:'annual',truck:tn,kind:'Annual DOT certificate expires',iv:null});
    }
  });

  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    prev:'<path d="m15 18-6-6 6-6"/>', next:'<path d="m9 18 6-6-6-6"/>',
    brake:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M21 12h-3M6 12H3"/>',
    yard:'<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M10 21v-6h4v6"/>',
    annual:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
  };
  const TONE={yard:'v2-accent-blue',brake:'v2-accent-red',annual:'v2-accent-cyan'};
  const ICON={yard:_IC.yard,brake:_IC.brake,annual:_IC.annual};

  const counts={all:events.length,yard:0,brake:0,annual:0};
  events.forEach(e=>{counts[e.type]++;});
  const shown=calFilter==='all'?events:events.filter(e=>e.type===calFilter);

  let html='<div class="v2-region">';
  html+='<div class="v2-page-head"><h1>Calendar</h1>'
    +'<p>Every compliance clock in the fleet, laid out by the day it comes due.</p></div>';

  // ── Controls ──────────────────────────────────────────────────────────────
  const monthName=calendarMonth.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  const pill=(key,label,tone)=>'<button class="v2-cal-pill '+tone+(calFilter===key?' is-active':'')+'" type="button" onclick="calSetFilter(\''+key+'\')">'
    +(key==='all'?'':'<span class="v2-cal-dot"></span>')+label+' <span class="v2-cal-n">'+counts[key]+'</span></button>';
  html+='<div class="v2-cal-bar">'
    +'<div class="v2-cal-nav">'
      // calPrev / calNext are the production handlers, unchanged
      +'<button class="v2-cal-arrow" type="button" onclick="calPrev()" aria-label="Previous month">'+_sv(_IC.prev,'2')+'</button>'
      +'<span class="v2-cal-month">'+esc(monthName)+'</span>'
      +'<button class="v2-cal-arrow" type="button" onclick="calNext()" aria-label="Next month">'+_sv(_IC.next,'2')+'</button>'
      +'<button class="v2-cal-today-btn" type="button" onclick="calToday()">Today</button>'
    +'</div>'
    +'<div class="v2-cal-filters" role="group" aria-label="Filter events by type">'
      +pill('all','All events','v2-accent-amber')
      +pill('yard','Yard','v2-accent-blue')
      +pill('brake','Brakes','v2-accent-red')
      +pill('annual','Annual DOT','v2-accent-cyan')
    +'</div></div>';

  // ── Month grid ────────────────────────────────────────────────────────────
  html+='<div class="v2-cal-card"><div class="v2-cal-grid">';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>{html+='<div class="v2-cal-dow">'+d+'</div>';});
  for(let i=0;i<firstDay;i++) html+='<div class="v2-cal-day is-blank" aria-hidden="true"></div>';
  // A day with a dozen brake events would push the grid row to an unusable
  // height, so cap the chips and count the rest.
  const CAP=3;
  for(let d=1;d<=daysInMonth;d++){
    const dateStr=year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const dayEvents=shown.filter(e=>e.date===dateStr);
    const isToday=dateStr===todayStr;
    html+='<div class="v2-cal-day'+(isToday?' is-today':'')+(dayEvents.length?' has-events':'')+'">'
      +'<span class="v2-cal-num">'+d+'</span>';
    if(dayEvents.length){
      html+='<span class="v2-cal-events">';
      dayEvents.slice(0,CAP).forEach(e=>{
        html+='<span class="v2-cap '+TONE[e.type]+'" title="'+esc(e.label)+'">'
          +'<span class="v2-cap-dot"></span><span class="v2-cap-text">'+esc(e.short)+'</span></span>';
      });
      if(dayEvents.length>CAP){
        const rest=dayEvents.slice(CAP).map(e=>e.label).join('\n');
        html+='<span class="v2-cap-more" title="'+esc(rest)+'">+'+(dayEvents.length-CAP)+' more</span>';
      }
      html+='</span>';
    }
    html+='</div>';
  }
  html+='</div></div>';

  // ── Upcoming stream ───────────────────────────────────────────────────────
  // Next few of EACH clock, merged back into date order — not simply the next N
  // dates. A 30-day brake cycle across a 40-odd truck fleet produces roughly one
  // brake event per truck per month, so a purely chronological list runs about
  // 90% brakes and the yard visit and certificate expiry sit dozens of rows
  // below the fold. Per-clock quotas keep every deadline type visible.
  const CAL_PER_TYPE=5;
  const _calFuture=shown.filter(e=>e.date>=todayStr).sort((a,b)=>a.date.localeCompare(b.date));
  const types=calFilter==='all'?['yard','brake','annual']:[calFilter];
  const upcoming=types
    .reduce((acc,t)=>acc.concat(_calFuture.filter(e=>e.type===t).slice(0,CAL_PER_TYPE)),[])
    .sort((a,b)=>a.date.localeCompare(b.date));

  html+='<section class="v2-table-card" aria-label="Upcoming events">'
    +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.annual)+'</span>'
    +'<h2>Upcoming</h2>'
    +'<span class="v2-console-note">'
      +(upcoming.length?'Next '+CAL_PER_TYPE+' of each type &middot; '+_calFuture.length+' upcoming in total':'Nothing upcoming')
    +'</span></div>';
  if(upcoming.length===0){
    html+='<div style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No upcoming events</div>';
  } else {
    html+='<div class="v2-stream">';
    upcoming.forEach(e=>{
      const days=daysBetween(todayStr,e.date);
      const urgency=days<=7?' is-urgent':days<=14?' is-soon':'';
      html+='<div class="v2-stream-row '+TONE[e.type]+'">'
        +'<span class="v2-stream-ic">'+_sv(ICON[e.type])+'</span>'
        +'<span class="v2-stream-main"><span class="v2-stream-label">Truck #'+esc(e.truck)+'</span>'
        +'<span class="v2-stream-type">'+esc(e.kind)+(e.iv?' &middot; '+e.iv+'-day':'')+'</span></span>'
        +'<span class="v2-stream-date">'+fmtDate(e.date)+'</span>'
        +'<span class="v2-countdown'+urgency+'">'+(days===0?'Today':days+'d')+'</span>'
      +'</div>';
    });
    html+='</div>';
  }
  html+='</section>';

  html+='</div>';
  return html;
}
function calPrev(){calendarMonth.setMonth(calendarMonth.getMonth()-1);render();}
function calNext(){calendarMonth.setMonth(calendarMonth.getMonth()+1);render();}

// ═══════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// DRIVER PTI COMPLIANCE & SAFETY SCORE
// ═══════════════════════════════════════════════════════
// Tunable in one place so the numbers can be argued with rather than guessed at.
const PTI_WINDOW_DAYS   = 30;
const THOROUGH_FULL_SEC = 180;  // walk-around at/above this earns full thoroughness
const THOROUGH_ZERO_SEC = 60;   // at/below this scores zero — a 40s "inspection" is a cab-check
const SCORE_COMPLIANCE_MAX = 60;
const SCORE_THOROUGH_MAX   = 40;

// Mon–Fri days in the window. A DVIR is required per driving day and we do not
// record which days a truck actually ran, so business days is a proxy — the same
// assumption the SMS reminder bot already makes by pausing at weekends.
function businessDaysInWindow(days){
  const out=[]; const d=new Date(today()+'T00:00:00Z');
  for(let i=0;i<days;i++){
    const wd=d.getUTCDay();
    if(wd!==0&&wd!==6) out.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate()-1);
  }
  return out;
}
function median(nums){
  const a=nums.filter(n=>typeof n==='number'&&n>=0).sort((x,y)=>x-y);
  if(!a.length) return null;
  const m=Math.floor(a.length/2);
  return a.length%2 ? a[m] : Math.round((a[m-1]+a[m])/2);
}
function driverPtiStats(driverId){
  const biz=businessDaysInWindow(PTI_WINDOW_DAYS);
  const from=biz[biz.length-1];
  const mine=INSPECTIONS.filter(r=>r.driverId===driverId&&r.submittedAt&&String(r.submittedAt).split('T')[0]>=from);
  const daysDone=new Set(mine.map(r=>String(r.submittedAt).split('T')[0]));
  const onBiz=[...daysDone].filter(d=>biz.includes(d)).length;
  const expected=biz.length;
  return {
    expected, done:onBiz,
    pct: expected? Math.round(onBiz/expected*100) : null,
    medianSec: median(mine.map(r=>r.durationSec)),
    // Defects FOUND are deliberately reported as a positive, never a penalty —
    // scoring them down would pay drivers to stay quiet about faults.
    defectsFound: mine.filter(r=>r.overallResult==='defect'||r.overallResult==='minor').length,
    total: mine.length,
    lastPti: mine.map(r=>r.submittedAt).sort().pop()||null
  };
}
function driverSafetyScore(st){
  const compliance = st.pct==null ? 0 : Math.round(SCORE_COMPLIANCE_MAX*Math.min(st.pct,100)/100);
  let thorough = 0;
  if(st.medianSec!=null){
    const span=THOROUGH_FULL_SEC-THOROUGH_ZERO_SEC;
    const t=(st.medianSec-THOROUGH_ZERO_SEC)/span;
    thorough=Math.round(SCORE_THOROUGH_MAX*Math.max(0,Math.min(1,t)));
  }
  return {score:compliance+thorough, compliance, thorough};
}
const scoreColour=s=>s>=80?'var(--success)':s>=55?'var(--warning)':'var(--danger)';

function _driverSafetyCard(scopeIds){
  // Only drivers who could actually have done a PTI: one needs an assigned truck,
  // and a driver currently on vacation would otherwise read as non-compliant.
  // scopeIds, when passed, narrows that to the drivers on those vehicles, so a
  // report scoped to one truck does not show the whole fleet's compliance.
  const _pool=scopeIds?VEHICLES.filter(v=>scopeIds.has(v.id)):VEHICLES;
  const eligible=DRIVERS.filter(d=>!d.on_vacation&&_pool.some(v=>v.assignedDriverId===d.id));
  const rows=eligible.map(d=>{
    const st=driverPtiStats(d.id);
    return {d,st,sc:driverSafetyScore(st)};
  }).sort((a,b)=>a.sc.score-b.sc.score);   // weakest first — that is who needs attention

  const fleetPct=rows.length?Math.round(rows.reduce((t,r)=>t+(r.st.pct||0),0)/rows.length):null;
  const caught=rows.reduce((t,r)=>t+r.st.defectsFound,0);

  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const vest='<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>';

  let html='<section class="v2-table-card v2-rep-section" aria-label="Driver pre-trip compliance">'
    +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(vest)+'</span>'
    +'<h2>Driver pre-trip compliance</h2>'
    +'<span class="v2-console-note">Last '+PTI_WINDOW_DAYS+' days &middot; business days only &middot; weakest first</span>'
    +'<span class="v2-rep-actions">'
      +(fleetPct!==null?'<span class="v2-rtag '+(fleetPct>=80?'is-ok':fleetPct>=55?'is-warn':'is-crit')+'">Fleet '+fleetPct+'%</span>':'')
      +(caught?'<span class="v2-rtag">'+caught+' defect'+(caught>1?'s':'')+' caught</span>':'')
    +'</span></div>';

  if(!rows.length){
    return html+'<div style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No drivers with an assigned truck.</div></section>';
  }

  html+='<div class="v2-table-wrap"><table class="v2-table v2-drv-table"><thead><tr>'
    +'<th>Driver</th><th>PTIs done</th><th>Compliance</th><th>Median walk-around</th>'
    +'<th>Defects caught</th><th>Last PTI</th><th>Score</th></tr></thead><tbody>';
  rows.forEach(r=>{
    const d=r.d, st=r.st, sc=r.sc;
    const pc=st.pct==null?0:st.pct;
    // v2-reports.css names these is-t-*, not is-*: .v2-meter-fill.is-ok simply
    // does not exist and the bar renders transparent. Caught by measuring the
    // computed background rather than by reading the markup.
    const pcTone=pc>=80?'is-t-ok':pc>=55?'is-t-warn':'is-t-bad';
    const dur=st.medianSec==null?'&mdash;':inspDur(st.medianSec);
    // Same three bands as before: below THOROUGH_ZERO_SEC is a red flag, below
    // THOROUGH_FULL_SEC is partial credit, at or above it is full.
    const durTone=st.medianSec==null?'is-t-none':st.medianSec<THOROUGH_ZERO_SEC?'is-t-bad':st.medianSec<THOROUGH_FULL_SEC?'is-t-warn':'is-t-ok';
    html+='<tr>'
      +'<td class="v2-cell-strong">'+esc(d.name)+'</td>'
      +'<td class="v2-cell-num">'+st.done+' / '+st.expected+'</td>'
      +'<td><span class="v2-meter"><span class="v2-meter-track"><span class="v2-meter-fill '+pcTone+'" style="width:'+Math.min(pc,100)+'%"></span></span>'
        +'<span class="v2-meter-pct '+pcTone+'">'+pc+'%</span></span></td>'
      +'<td class="v2-cell-dur '+durTone+'">'+dur+'</td>'
      +'<td>'+(st.defectsFound
        ? '<span class="v2-cell-caught" title="Catching defects is good — it never lowers the score">&check; '+st.defectsFound+'</span>'
        : '<span class="v2-cell-dim">&mdash;</span>')+'</td>'
      +'<td class="v2-cell-num">'+(st.lastPti?fmtDate(st.lastPti):'<span class="v2-cell-never">never</span>')+'</td>'
      +'<td><span class="v2-score" style="background:'+scoreColour(sc.score)+'" title="Compliance '+sc.compliance+'/'+SCORE_COMPLIANCE_MAX+' + thoroughness '+sc.thorough+'/'+SCORE_THOROUGH_MAX+'">'+sc.score+'</span></td>'
    +'</tr>';
  });
  html+='</tbody></table></div>'
    +'<p class="v2-rep-note"><b>Score</b> = compliance ('+SCORE_COMPLIANCE_MAX+') + walk-around thoroughness ('+SCORE_THOROUGH_MAX+'). '
    +'Full thoroughness at '+Math.round(THOROUGH_FULL_SEC/60)+' min, zero at '+THOROUGH_ZERO_SEC+'s.<br>'
    +'<b>Reporting a defect never lowers a score</b> &mdash; a driver who finds faults is doing the job, and penalising it would only teach them to stay quiet.<br>'
    +'Compliance counts business days, since driving days are not recorded; a driver off sick or on leave during the window will read low.</p>'
    +'</section>';
  return html;
}

// ── Reports controls ────────────────────────────────────────────────────────
// Scope for the Reports page only. Both are presentation state: they change
// which rows are summarised, never what is stored. The 'rep' prefix is free —
// js/reminders.js uses 'rem'.
let repRangeDays = 30;
let repVehicleId = '';          // '' = every vehicle

function repSetRange(sel){ repRangeDays = parseInt(sel.value,10)||30; render(); }
function repSetVehicle(sel){ repVehicleId = sel.value||''; render(); }
function repPrint(){ window.print(); }

// Exports the per-vehicle summary as it is currently scoped. Built in the
// browser from data already loaded — no request, nothing leaves the page except
// into the user's own downloads.
function repExportCSV(){
  const rows=(repVehicleId?VEHICLES.filter(v=>v.id===repVehicleId):VEHICLES);
  const head=['Truck','Trailer','Driver','Dispatcher','Last brake','Last tyre','Last service','Status'];
  const q=x=>'"'+String(x==null?'':x).replace(/"/g,'""')+'"';
  const body=rows.map(v=>{
    const st=getVehicleStatus(v.id);
    const d=DRIVERS.find(x=>x.id===v.assignedDriverId);
    return [v.truckNumber,v.trailerNumber||'',d?d.name:'',v.assignedDispatcher||'',
      st.lastBrake?st.lastBrake.testDate:'',
      st.lastTyre?st.lastTyre.photoDate:'',
      st.lastService?st.lastService.serviceDate:(st.maint?st.maint.serviceDate:''),
      st.critical?'Critical':st.warning?'Warning':'OK'].map(q).join(',');
  });
  const csv=head.map(q).join(',')+'\r\n'+body.join('\r\n');
  const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='fleetguard-vehicles-'+today()+'.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast('Exported '+rows.length+' vehicle'+(rows.length===1?'':'s'),'success');
}

function renderReports(){
  // v2 components against live data. Styles: v2-reports.css + v2-inspections.css
  // (table shell) + v2-shell.css (.v2-page-head).
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const _IC={
    heart:'<path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>',
    clip:'<path d="M9 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/>',
    shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    brake:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    truck:'<path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l3 3v5h-2"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    vest:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    print:'<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/>',
    down:'<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/>',
    chev:'<path d="m6 9 6 6 6-6"/>',
  };
  const pctOf=(n,d)=>d?Math.round(n/d*1000)/10:0;
  const bdRow=(tone,label,n,total)=>'<div class="v2-bd-row v2-accent-'+tone+'">'
    +'<span class="v2-bd-key"><span class="v2-bd-dot"></span>'+label+'</span>'
    +'<span class="v2-bd-meter"><span class="v2-bd-fill" style="width:'+pctOf(n,total)+'%"></span></span>'
    +'<span class="v2-bd-n">'+n+'</span><span class="v2-bd-pct">'+pctOf(n,total)+'%</span></div>';

  // ── Scope ─────────────────────────────────────────────────────────────────
  // One truck or the whole fleet. Everything below is derived from these, so a
  // scoped report is genuinely scoped rather than a filtered table under
  // fleet-wide headline numbers.
  const scopeVeh = repVehicleId ? VEHICLES.filter(v=>v.id===repVehicleId) : VEHICLES;
  const scopeIds = new Set(scopeVeh.map(v=>v.id));
  const inScope = arr => repVehicleId ? arr.filter(r=>scopeIds.has(r.vehicleId)) : arr;
  const scopeIns = inScope(INSPECTIONS), scopeBrake = inScope(BRAKE_TESTS), scopeDot = inScope(DOT_INSPECTIONS);
  const scopeMaint = inScope(MAINTENANCE);
  const scopedVehicle = repVehicleId ? VEHICLES.find(v=>v.id===repVehicleId) : null;

  const statuses=scopeVeh.map(v=>({v,s:getVehicleStatus(v.id)}));
  const roadworthy=statuses.filter(x=>!x.s.critical&&!x.s.tyreOverdue).length,pending=scopeVeh.length-roadworthy;
  const brakePass=scopeBrake.filter(b=>b.result==='pass').length,brakeFail=scopeBrake.filter(b=>b.result==='fail').length;

  // ── Window ────────────────────────────────────────────────────────────────
  const winStart=new Date(Date.now()-repRangeDays*86400000).toISOString().split('T')[0];
  const inWindow=scopeIns.filter(i=>String(i.submittedAt||'').split('T')[0]>=winStart);
  const bizDays=businessDaysInWindow(repRangeDays).length;
  const ptiDrivers=new Set(inWindow.map(i=>i.driverId).filter(Boolean)).size;

  // ── Metrics ───────────────────────────────────────────────────────────────
  const healthPct=scopeVeh.length?Math.round(roadworthy/scopeVeh.length*100):0;
  const defects=inWindow.filter(i=>i.overallResult==='defect'||i.overallResult==='minor');
  const resolved=REPAIRS_AVAILABLE?defects.filter(i=>!isOpenDefect(i)).length:0;
  const stillOpen=defects.length-resolved;
  const resPct=defects.length?Math.round(resolved/defects.length*100):0;
  // Driver compliance, same population the compliance table scores.
  const compDrivers=DRIVERS.filter(d=>!d.on_vacation&&scopeVeh.some(v=>v.assignedDriverId===d.id));
  const compStats=compDrivers.map(d=>driverPtiStats(d.id));
  const compPct=compStats.length?Math.round(compStats.reduce((t,x)=>t+(x.pct||0),0)/compStats.length):null;
  const caughtTotal=compStats.reduce((t,x)=>t+x.defectsFound,0);
  const quickDrivers=compStats.filter(x=>x.medianSec!=null&&x.medianSec<THOROUGH_ZERO_SEC).length;

  let html='<div class="v2-region">';
  html+='<div class="v2-page-head"><h1>Reports &amp; Analytics</h1>'
    +'<p>Compliance, inspection and maintenance performance across the fleet.</p></div>';

  // ── Controls ──────────────────────────────────────────────────────────────
  const rangeOpts=[[7,'Last 7 days'],[30,'Last 30 days'],[90,'Last 90 days'],[365,'Last 12 months']]
    .map(o=>'<option value="'+o[0]+'"'+(repRangeDays===o[0]?' selected':'')+'>'+o[1]+'</option>').join('');
  const vehOpts='<option value=""'+(repVehicleId?'':' selected')+'>All vehicles ('+VEHICLES.length+')</option>'
    +VEHICLES.slice().sort((a,b)=>String(a.truckNumber).localeCompare(String(b.truckNumber),undefined,{numeric:true}))
      .map(v=>'<option value="'+v.id+'"'+(repVehicleId===v.id?' selected':'')+'>Truck #'+esc(v.truckNumber)+'</option>').join('');
  html+='<div class="v2-rep-bar">'
    +'<div class="v2-rep-group"><label class="v2-rep-label" for="rep-range">Date range</label>'
      +'<span class="v2-rep-select"><select id="rep-range" onchange="repSetRange(this)">'+rangeOpts+'</select>'+_sv(_IC.chev,'1.8')+'</span></div>'
    +'<div class="v2-rep-group"><label class="v2-rep-label" for="rep-veh">Vehicle</label>'
      +'<span class="v2-rep-select"><select id="rep-veh" onchange="repSetVehicle(this)">'+vehOpts+'</select>'+_sv(_IC.chev,'1.8')+'</span></div>'
    +'<div class="v2-rep-actions">'
      +'<button class="v2-rep-btn" type="button" onclick="repPrint()">'+_sv(_IC.print)+'Print summary</button>'
      +'<button class="v2-rep-btn is-primary" type="button" onclick="repExportCSV()">'+_sv(_IC.down)+'Export CSV</button>'
    +'</div></div>';

  if(scopedVehicle){
    html+='<p class="v2-rep-note" style="margin-bottom:var(--v2-s6)">Scoped to <b>Truck #'+esc(scopedVehicle.truckNumber)+'</b>. '
      +'Every figure below counts this vehicle only.</p>';
  }

  // ── Metrics ───────────────────────────────────────────────────────────────
  html+='<div class="v2-metrics">'
    +'<article class="v2-metric v2-accent-green"><div class="v2-metric-head">'
      +'<span class="v2-metric-ic">'+_sv(_IC.heart)+'</span><span class="v2-metric-label">Fleet health score</span></div>'
      +'<span class="v2-metric-val">'+healthPct+'<span class="v2-metric-unit">%</span></span>'
      // The Dashboard counts only active vehicles and so reads higher. Saying so
      // here is cheaper than letting someone find both numbers and distrust each.
      +'<span class="v2-metric-sub">'+roadworthy+' of '+scopeVeh.length+' roadworthy &middot; '+pending+' pending.'
      +(repVehicleId?'':' Counts every vehicle; the Dashboard counts active ones only.')+'</span>'
      +'<div class="v2-metric-meter"><div style="width:'+healthPct+'%"></div></div></article>'
    +'<article class="v2-metric v2-accent-cyan"><div class="v2-metric-head">'
      +'<span class="v2-metric-ic">'+_sv(_IC.clip)+'</span><span class="v2-metric-label">Inspections completed</span></div>'
      +'<span class="v2-metric-val">'+inWindow.length+'</span>'
      +'<span class="v2-metric-sub">Last '+repRangeDays+' days &middot; '+bizDays+' business days &middot; '+ptiDrivers+' driver'+(ptiDrivers===1?'':'s')+'</span></article>'
    +(REPAIRS_AVAILABLE?'<article class="v2-metric v2-accent-blue"><div class="v2-metric-head">'
      +'<span class="v2-metric-ic">'+_sv(_IC.shield)+'</span><span class="v2-metric-label">Defect resolution rate</span></div>'
      +'<span class="v2-metric-val">'+resPct+'<span class="v2-metric-unit">%</span></span>'
      +'<span class="v2-metric-sub">'+resolved+' of '+defects.length+' resolved &middot; '+stillOpen+' still open</span>'
      +'<div class="v2-metric-meter"><div style="width:'+resPct+'%"></div></div></article>':'')
    +'<article class="v2-metric v2-accent-amber"><div class="v2-metric-head">'
      +'<span class="v2-metric-ic">'+_sv(_IC.vest)+'</span><span class="v2-metric-label">Driver compliance</span></div>'
      +'<span class="v2-metric-val">'+(compPct===null?'&mdash;':compPct+'<span class="v2-metric-unit">%</span>')+'</span>'
      // Fixed at PTI_WINDOW_DAYS on purpose: driverPtiStats scores against that
      // constant, and letting the date range move it would put a number here
      // that the compliance table below could not reproduce.
      +'<span class="v2-metric-sub">'+compDrivers.length+' driver'+(compDrivers.length===1?'':'s')+' with a truck &middot; fixed '+PTI_WINDOW_DAYS+'-day window</span>'
      +(compPct===null?'':'<div class="v2-metric-meter"><div style="width:'+compPct+'%"></div></div>')+'</article>'
    +'</div>';

  // ── Breakdown + DOT, two up ───────────────────────────────────────────────
  const insPass=inWindow.filter(i=>i.overallResult!=='defect'&&i.overallResult!=='minor').length;
  const insMinor=inWindow.filter(i=>i.overallResult==='minor').length;
  const insDefect=inWindow.filter(i=>i.overallResult==='defect').length;

  const _rNow=new Date();
  const _MO=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const _MOF=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const _dotMS=(y,m)=>{const pfx=y+'-'+String(m+1).padStart(2,'0');const inM=scopeDot.filter(d=>d.inspectionDate&&d.inspectionDate.startsWith(pfx));const tot=inM.length,cln=inM.filter(d=>d.result==='pass').length;return{total:tot,clean:cln,issues:tot-cln,pct:tot>0?Math.round(cln/tot*100):null};};
  const _cDot=_dotMS(_rNow.getFullYear(),_rNow.getMonth());
  const _tone=p=>p===null?'is-t-none':p>70?'is-t-ok':p>50?'is-t-warn':'is-t-bad';
  const _dotHist=[];for(let _i=1;_i<=12;_i++){let _y=_rNow.getFullYear(),_m=_rNow.getMonth()-_i;while(_m<0){_m+=12;_y--;}_dotHist.push(Object.assign({year:_y,month:_m},_dotMS(_y,_m)));}

  html+='<div class="v2-rep-grid">'
    +'<section class="v2-table-card" aria-label="Inspection log breakdown">'
      +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.clip)+'</span>'
      +'<h2>Inspection log breakdown</h2><span class="v2-console-note">'+inWindow.length+' in window</span></div>'
      +'<div class="v2-bd">'
        +bdRow('green','Roadworthy',insPass,inWindow.length)
        +bdRow('amber','Minor',insMinor,inWindow.length)
        +bdRow('red','Defect',insDefect,inWindow.length)
      +'</div>'
      +'<div class="v2-rep-note"><b>'+caughtTotal+' defect'+(caughtTotal===1?'':'s')+' caught</b> by drivers in the window '
      +'&mdash; reported as a positive, never a penalty. Scoring a driver down for finding faults would only pay them to stay quiet.<br>'
      +'<b>'+quickDrivers+' driver'+(quickDrivers===1?'':'s')+'</b> have a median walk-around under '+THOROUGH_ZERO_SEC+'s, '
      +'the threshold the inspection log flags as suspiciously quick.</div>'
    +'</section>'
    +'<section class="v2-table-card" aria-label="DOT clean rate">'
      +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.clip)+'</span>'
      +'<h2>DOT clean rate &middot; monthly</h2>'
      +'<span class="v2-console-note">'+_MOF[_rNow.getMonth()]+' '+_rNow.getFullYear()+'</span>'
      +'<span class="v2-rep-actions"><span class="v2-rtag">'+scopeDot.length+' total</span></span></div>'
      +'<div class="v2-table-wrap"><table class="v2-table v2-drv-table"><thead><tr>'
      +'<th>Month</th><th>Total</th><th>Clean</th><th>Violation</th><th>% clean</th>'
      +'</tr></thead><tbody>';
  if(!_dotHist.some(r=>r.total>0)&&_cDot.total===0){
    html+='<tr><td colspan="5" style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No DOT inspection data yet</td></tr>';
  }
  _dotHist.forEach(r=>{
    const t=_tone(r.pct);
    html+='<tr><td class="v2-cell-strong">'+_MO[r.month]+' '+r.year+'</td>'
      +'<td class="v2-cell-num">'+r.total+'</td>'
      +'<td class="v2-cell-num">'+(r.clean?'<span class="v2-cell-caught">'+r.clean+'</span>':'<span class="v2-cell-dim">0</span>')+'</td>'
      +'<td class="v2-cell-num">'+(r.issues?'<span class="v2-cell-never">'+r.issues+'</span>':'<span class="v2-cell-dim">&mdash;</span>')+'</td>'
      +'<td>'+(r.pct!==null
        ?'<span class="v2-meter"><span class="v2-meter-track"><span class="v2-meter-fill '+t+'" style="width:'+r.pct+'%"></span></span><span class="v2-meter-pct '+t+'">'+r.pct+'%</span></span>'
        :'<span class="v2-cell-dim">&mdash;</span>')+'</td></tr>';
  });
  html+='</tbody></table></div></section></div>';

  // ── Roadworthiness + brakes, two up ───────────────────────────────────────
  html+='<div class="v2-rep-grid">'
    +'<section class="v2-table-card" aria-label="Fleet roadworthiness">'
      +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.truck)+'</span>'
      +'<h2>Fleet roadworthiness</h2><span class="v2-console-note">'+scopeVeh.length+' vehicle'+(scopeVeh.length===1?'':'s')+'</span></div>'
      +'<div class="v2-bd">'+bdRow('green','Roadworthy',roadworthy,scopeVeh.length)+bdRow('red','Pending',pending,scopeVeh.length)+'</div></section>'
    +'<section class="v2-table-card" aria-label="Brake test results">'
      +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.brake)+'</span>'
      +'<h2>Brake test results</h2><span class="v2-console-note">'+scopeBrake.length+' test'+(scopeBrake.length===1?'':'s')+'</span></div>'
      +'<div class="v2-bd">'+bdRow('green','Pass',brakePass,scopeBrake.length)+bdRow('red','Fail',brakeFail,scopeBrake.length)+'</div></section>'
    +'</div>';

  // ── Driver compliance ─────────────────────────────────────────────────────
  html+=_driverSafetyCard(repVehicleId?scopeIds:null);

  // ── Per-vehicle summary ───────────────────────────────────────────────────
  html+='<section class="v2-table-card v2-rep-section" aria-label="Vehicle maintenance overview">'
    +'<div class="v2-console-head"><span class="v2-console-ic">'+_sv(_IC.truck)+'</span>'
    +'<h2>Vehicle maintenance overview</h2>'
    +'<span class="v2-console-note">'+scopeVeh.length+' vehicle'+(scopeVeh.length===1?'':'s')+' &middot; '+scopeMaint.length+' service records</span></div>'
    +'<div class="v2-table-wrap"><table class="v2-table"><thead><tr>'
    +'<th>Truck</th><th>Last brake</th><th>Last tyre</th><th>Last service</th><th>Status</th>'
    +'</tr></thead><tbody>';
  if(scopeVeh.length===0){
    html+='<tr><td colspan="5" style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No vehicles</td></tr>';
  }
  scopeVeh.forEach(v=>{
    const st=getVehicleStatus(v.id);
    const tone=st.critical?'is-defect':st.warning?'is-minor':'is-pass';
    const label=st.critical?'Critical':st.warning?'Warning':'OK';
    html+='<tr onclick="navigate(\'vehicle\',\''+v.id+'\')" style="cursor:pointer" title="Open truck">'
      +'<td class="v2-cell-strong">Truck #'+esc(v.truckNumber)+'</td>'
      +'<td class="v2-cell-num">'+(st.lastBrake?fmtDate(st.lastBrake.testDate):'<span class="v2-cell-dim">&mdash;</span>')+'</td>'
      +'<td class="v2-cell-num">'+(st.lastTyre?fmtDate(st.lastTyre.photoDate):'<span class="v2-cell-dim">&mdash;</span>')+'</td>'
      +'<td class="v2-cell-num">'+(st.lastService?fmtDate(st.lastService.serviceDate):st.maint?fmtDate(st.maint.serviceDate):'<span class="v2-cell-dim">&mdash;</span>')+'</td>'
      +'<td><span class="v2-chip-status '+tone+'">'+label+'</span></td></tr>';
  });
  html+='</tbody></table></div></section>';

  html+='</div>';
  return html;
}

// ═══════════════════════════════════════════════════════
// DRIVER PORTAL
// ═══════════════════════════════════════════════════════
function renderPortal(){
  let html=`<div style="max-width:520px;margin:0 auto">
    <div style="text-align:center;padding:20px 0 24px"><div style="font-size:40px;margin-bottom:8px">🛡️</div><div style="font-size:20px;font-weight:700">Driver Portal</div><div class="text-sm">Submit tyre checks and mileage</div></div>
    <div id="portal-success" style="display:none" class="alert alert-success"><div><div class="alert-title">✅ Submitted!</div>Your report has been saved.</div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-header">Who are you?</div><div class="card-body">
      <div class="form-grid form-grid-2">
        <div><label>Your Name</label><select id="p-driver"><option value="">— select —</option>${DRIVERS.map(d=>`<option value="${d.id}">${d.name}</option>`).join('')}</select></div>
        <div><label>Vehicle</label><select id="p-vehicle"><option value="">— select —</option>${VEHICLES.map(v=>`<option value="${v.id}">Truck #${v.truckNumber}</option>`).join('')}</select></div>
      </div>
    </div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-header">📍 Current Mileage</div><div class="card-body"><input type="number" id="p-mileage" placeholder="e.g. 125000" min="0" max="9999999"/></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-header">⭕ Tyre Check</div><div class="card-body">
      <div style="margin-bottom:12px"><label>Photo Date</label><input type="date" id="p-tyredate" value="${today()}" max="${today()}"/></div>
      <div class="tyre-grid">`;
  AXLES.forEach((axle,ai)=>{
    html+=`<div class="axle-row"><div class="axle-name">${axle.name}</div><div class="tyre-selects">`;
    axle.sides.forEach(pos=>{html+=`<div class="tyre-select-row"><label>${pos.replace('-','/')}</label><select id="p-t-${ai}-${pos}"><option value="good">Good</option><option value="bad">Bad</option><option value="uneven">Uneven</option></select></div>`;});
    html+=`</div></div>`;
  });
  html+=`</div></div></div>
    <button class="btn btn-primary" style="width:100%;padding:14px;font-size:15px" onclick="doSubmitPortal()">Submit Report</button>
  </div>`;
  return html;
}
async function doSubmitPortal(){
  const driverId=document.getElementById('p-driver').value,vehicleId=document.getElementById('p-vehicle').value;
  if(!driverId||!vehicleId){showToast('Select your name and vehicle','danger');return;}
  const mileage=parseInt(document.getElementById('p-mileage').value),tyreDate=document.getElementById('p-tyredate').value;
  if(mileage>0&&mileage<=9999999) await addMileage(vehicleId,driverId,mileage);
  else if(mileage>9999999){showToast('Mileage value is too high','danger');return;}
  if(tyreDate){const readings=[];AXLES.forEach((axle,ai)=>{axle.sides.forEach(pos=>{const el=document.getElementById(`p-t-${ai}-${pos}`);if(el)readings.push({axleIndex:ai,position:pos,status:el.value});});});await addTyreRecord(vehicleId,tyreDate,readings);}
  document.getElementById('p-mileage').value='';document.getElementById('p-driver').value='';document.getElementById('p-vehicle').value='';document.getElementById('p-tyredate').value=today();
  AXLES.forEach((axle,ai)=>{axle.sides.forEach(pos=>{const el=document.getElementById(`p-t-${ai}-${pos}`);if(el)el.value='good';});});
  const succ=document.getElementById('portal-success');if(succ){succ.style.display='flex';setTimeout(()=>{succ.style.display='none';},4000);}
  showToast('Report submitted!','success');
}

// ═══════════════════════════════════════════════════════
// USER MANAGEMENT (admin only)
// ═══════════════════════════════════════════════════════
async function renderUsers(){
  if(!isAdmin()) return`<div class="alert alert-danger">Access denied.</div>`;
  const users=await loadAllUsers();
  const palette=['#da6536','#6366f1','#0ea5e9','#16a34a','#d97706','#8b5cf6','#ec4899','#14b8a6'];
  const avatarColor=e=>palette[e.charCodeAt(0)%palette.length];
  const initials=e=>e.substring(0,2).toUpperCase();
  const admins=users.filter(u=>u.role==='admin').length;
  const dispatchers=users.filter(u=>u.role==='dispatcher').length;
  const activeToday=users.filter(u=>u.last_sign_in_at&&Math.floor((Date.now()-new Date(u.last_sign_in_at))/86400000)===0).length;
  const relLabel=iso=>{
    if(!iso)return{label:'Never',bg:'var(--surface-high)',fg:'var(--text3)'};
    const d=Math.floor((Date.now()-new Date(iso))/86400000);
    if(d===0)return{label:'Today',bg:'var(--success-bg)',fg:'var(--success)'};
    if(d===1)return{label:'Yesterday',bg:'var(--warning-bg)',fg:'var(--warning)'};
    if(d<=7)return{label:d+'d ago',bg:'var(--warning-bg)',fg:'var(--warning)'};
    return{label:d+'d ago',bg:'var(--surface-high)',fg:'var(--text3)'};
  };
  let html=`<div class="card" style="max-width:920px"><div class="card-header" style="display:flex;align-items:center;justify-content:space-between"><div style="display:flex;align-items:center;gap:10px"><span>👥 User Management</span><span class="badge badge-blue">${admins} admin${admins!==1?'s':''}</span><span class="badge badge-gray">${dispatchers} dispatcher${dispatchers!==1?'s':''}</span>${activeToday>0?`<span class="badge badge-green">● ${activeToday} active today</span>`:''}</div><span style="font-size:11px;color:var(--text3);font-weight:400">Times shown in CST</span></div><div class="card-body" style="padding:0">
    <div class="table-wrap"><table><thead><tr><th style="padding-left:18px">User</th><th>Role</th><th>Last Day</th><th>Last Activity (CST)</th><th>Action</th></tr></thead><tbody>`;
  if(users.length===0) html+=`<tr><td colspan="5" class="empty" style="padding:20px">No users yet</td></tr>`;
  users.forEach((u,i)=>{
    const isSelf=u.id===currentUser?.id;
    const act=fmtCSTDate(u.last_sign_in_at);
    const rel=relLabel(u.last_sign_in_at);
    const isNew=!u.last_sign_in_at;
    const color=avatarColor(u.email);
    const rowBg=isSelf?'background:var(--primary-dim)':i%2===1?'background:var(--row-stripe)':'';
    html+=`<tr style="${rowBg}" onmouseover="this.style.background='var(--surface-high)'" onmouseout="this.style.background='${isSelf?'var(--primary-dim)':i%2===1?'var(--row-stripe)':''}'">
      <td style="padding:11px 14px 11px 18px"><div style="display:flex;align-items:center;gap:10px"><div style="width:34px;height:34px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:800;color:#fff;flex-shrink:0;opacity:${isNew?'0.45':'1'}">${initials(u.email)}</div><div><div style="font-size:13px;font-weight:600;color:${isNew?'var(--text3)':'var(--text)'}">${esc(u.email)}${isSelf?' <span class="badge badge-blue" style="font-size:10px">You</span>':''}</div>${isNew?'<div style="font-size:10.5px;color:var(--text3);margin-top:2px">Never logged in</div>':''}</div></div></td>
      <td style="padding:11px 14px">${isSelf?`<span class="badge ${u.role==='admin'?'badge-blue':'badge-gray'}">${u.role==='admin'?'👑 Admin':'👁 Dispatcher'}</span>`:`<select onchange="doChangeRole('${u.id}',this.value)" style="padding:4px 8px;border-radius:6px;font-size:12px;border:1px solid var(--border);background:var(--surface-high);color:var(--text)"><option value="admin" ${u.role==='admin'?'selected':''}>👑 Admin</option><option value="dispatcher" ${u.role==='dispatcher'?'selected':''}>👁 Dispatcher</option></select>`}</td>
      <td style="padding:11px 14px;white-space:nowrap"><div style="display:flex;align-items:center;gap:7px"><span style="background:${rel.bg};color:${rel.fg};font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;letter-spacing:0.04em;white-space:nowrap">${rel.label}</span><span style="font-size:12px;color:var(--text3)">${act.date}</span></div></td>
      <td style="padding:11px 14px;font-size:13px;font-weight:600;color:${isNew?'var(--text3)':'var(--text2)'};white-space:nowrap">${act.time}</td>
      <td style="padding:11px 14px">${isSelf?'<span style="color:var(--text3);font-size:12px">—</span>':`<button class="btn btn-sm del-user-btn" data-uid="${esc(u.id)}" data-email="${esc(u.email)}" style="background:transparent;border:1px solid var(--danger-bg);color:var(--danger);font-weight:700" onmouseover="this.style.background='var(--danger-bg)'" onmouseout="this.style.background='transparent'">✕ Remove</button>`}</td>
    </tr>`;
  });
  html+=`</tbody></table></div></div></div>
  <div class="card" style="max-width:920px;margin-top:20px"><div class="card-header">➕ Invite New User</div><div class="card-body">
    <p class="text-sm" style="margin-bottom:12px;line-height:1.6">Invite users via Supabase dashboard, then assign their role here.</p>
    <div style="background:var(--surface-low);border-radius:8px;padding:12px;font-size:12px;color:var(--text2)">Supabase Dashboard → Authentication → Users → Invite user</div>
  </div></div>`;
  return html;
}
async function doChangeRole(userId,role){if(!['admin','dispatcher'].includes(role))return;await updateUserRole(userId,role);showToast('Role updated!','success');}
async function doDeleteUser(userId,email){
  const ok=await confirm2(`Remove user "${email}"?`,'They will be immediately signed out and blocked from FleetGuard.');
  if(!ok) return;
  await sb.from('profiles').update({banned_at: new Date().toISOString()}).eq('id',userId);
  showToast('User removed','warning'); navigate('users');
}

// ═══════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════
let toastTimer;
function showToast(msg,type='success'){
  let toast=document.getElementById('toast');
  if(!toast){toast=document.createElement('div');toast.id='toast';toast.style.cssText='position:fixed;bottom:24px;right:24px;padding:12px 18px;border-radius:10px;font-weight:600;font-size:13px;z-index:1000;box-shadow:0 4px 16px rgba(0,0,0,.15);transition:opacity .3s;';document.body.appendChild(toast);}
  const colors={success:'background:#15803d;color:#fff',danger:'background:#dc2626;color:#fff',warning:'background:#d97706;color:#fff'};
  toast.style.cssText+=';'+(colors[type]||colors.success);toast.textContent=msg;toast.style.opacity='1';
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.style.opacity='0';},3000);
}
async function confirm2(title,body,okLabel,okClass){
  return new Promise(resolve=>{
    window._confirmResolve=resolve;
    document.getElementById('confirm-title').textContent=title;document.getElementById('confirm-body').textContent=body;
    const okBtn=document.getElementById('confirm-ok');
    if(okBtn){ okBtn.textContent=okLabel||'Delete'; okBtn.className=okClass||'btn btn-danger'; }
    document.getElementById('confirm-modal').style.display='flex';
  });
}
function confirmResolve(val){document.getElementById('confirm-modal').style.display='none';if(window._confirmResolve){window._confirmResolve(val);window._confirmResolve=null;}}

// ═══════════════════════════════════════════════════════
// LIVE REFRESH
// ═══════════════════════════════════════════════════════
// Keep the screen current without a manual F5. A 30s timer covers the active
// tab; the focus/visibility listeners cover the real gap — browsers freeze
// background timers, so data is stale exactly when the dispatcher tabs back in.
// Never reload while a form or modal is open, so a refresh can't wipe input.
let _refreshing=false,_lastRefresh=0;
function isUserBusy(){
  const ae=document.activeElement;
  if(ae&&/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return true;
  for(const m of document.querySelectorAll('.modal-overlay')){
    if(getComputedStyle(m).display!=='none') return true;
  }
  return false;
}
async function refreshData(){
  if(!sb||!currentUser||_refreshing) return;
  if(Date.now()-_lastRefresh<1500) return;   // collapse focus+visibility double-fire
  _refreshing=true;
  try{
    // Security: enforce bans on every cycle, even mid-edit.
    const {data:p}=await sb.from('profiles').select('banned_at').eq('id',currentUser.id).single();
    if(p?.banned_at){await sb.auth.signOut();localStorage.removeItem('sb_key');localStorage.removeItem('sb_url');showLoginScreen();return;}
    if(isUserBusy()) return;                  // don't clobber in-progress input
    await loadAll(); render();
    _lastRefresh=Date.now();
  }catch(e){/* transient — next tick recovers */}
  finally{_refreshing=false;}
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
async function init(){
  document.getElementById('loading-overlay').style.display='flex';
  await initAuth();
  setInterval(refreshData,30000);
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') refreshData(); });
  window.addEventListener('focus',refreshData);
  window.addEventListener('online',refreshData);
}
init();
