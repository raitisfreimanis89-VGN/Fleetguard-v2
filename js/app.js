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
  if (mode === 'db') {
    document.getElementById('login-db-setup').style.display = 'block';
    document.getElementById('login-form-section').style.display = 'none';
  } else {
    document.getElementById('login-db-setup').style.display = 'none';
    document.getElementById('login-form-section').style.display = 'block';
  }
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
let DRIVERS=[], VEHICLES=[], MAINTENANCE=[], BRAKE_TESTS=[], TYRE_RECORDS=[], DOT_INSPECTIONS=[], MILEAGE=[], SERVICE_RECORDS=[], INSPECTIONS=[], LINK_SENDS=[];

async function loadAll() {
  if (!sb) return;
  const [d,v,m,b,t,dot,mil,svc,insp,ls] = await Promise.all([
    sb.from('drivers').select('id,name,on_vacation,created_at').order('created_at'),
    sb.from('vehicles').select('id,truck_number,trailer_number,assigned_driver_id,assigned_dispatcher,created_at').order('created_at'),
    sb.from('maintenance_records').select('id,vehicle_id,service_date,next_inspection_date,notes').order('created_at'),
    sb.from('brake_tests').select('id,vehicle_id,test_date,result,notes').order('created_at'),
    sb.from('tyre_records').select('id,vehicle_id,photo_date,readings').order('created_at'),
    sb.from('dot_inspections').select('id,vehicle_id,driver_id,inspection_date,result,notes').order('created_at'),
    sb.from('mileage_records').select('id,vehicle_id,driver_id,mileage,date').order('created_at'),
    sb.from('service_records').select('id,vehicle_id,service_date,result,notes').order('created_at'),
    sb.from('inspections').select('id,ref,vehicle_id,driver_id,truck_number,trailer_number,submitted_at,duration_sec,odometer,overall_result,tyres_flagged,checks_failed').order('submitted_at',{ascending:false}).limit(500),
    sb.from('link_sends').select('driver_id,vehicle_id,status,created_at').order('created_at',{ascending:false}).limit(1000),
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
  // link_sends: now admin+dispatcher readable (RLS 005) — powers "last PTI link sent" on the vehicle PTI tab
  if (!ls.error && ls.data) LINK_SENDS = ls.data.map(r=>({...r,driverId:r.driver_id,vehicleId:r.vehicle_id,createdAt:r.created_at}));
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
async function addVehicle(truckNumber,trailerNumber,assignedDriverId,assignedDispatcher) {
  const rec={id:crypto.randomUUID(),truckNumber,trailerNumber,assignedDriverId:assignedDriverId||null,assignedDispatcher:assignedDispatcher||'',created_at:new Date().toISOString()};
  VEHICLES.push(rec); await sb.from('vehicles').insert({id:rec.id,truck_number:truckNumber,trailer_number:trailerNumber,assigned_driver_id:assignedDriverId||null,assigned_dispatcher:assignedDispatcher||'',created_at:rec.created_at}); return rec;
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
  // Tyres are on a weekly cadence — flag overdue at 7d so the card matches the SMS reminder bot (2026-07-03).
  const brakeOverdue=brakeDays>42,brakeDueSoon=brakeDays>35&&!brakeOverdue,tyreOverdue=tyreDays>=7;
  const serviceOverdue=serviceDays>60,serviceDueSoon=serviceDays>53&&!serviceOverdue;
  // nextDue warning: use maintenance nextInspectionDate if it has passed
  const nextDue=maint[0]?.nextInspectionDate;
  const nextDueOverdue=nextDue&&daysBetween(nextDue,now)>0;
  const hasOOS=lastDot&&lastDot.result==='oos';
  const viciousCircle=maint.some(m=>!brakes.find(b=>b.testDate===m.serviceDate));
  const critical=brakeOverdue||serviceOverdue,warning=brakeDueSoon||tyreOverdue||viciousCircle||nextDueOverdue; // OOS is a silent record now — never drives critical/red (2026-07-01)
  return{lastBrake,lastTyre,lastDot,lastService,maint:maint[0],brakeDays,tyreDays,serviceDays,brakeOverdue,brakeDueSoon,tyreOverdue,serviceOverdue,serviceDueSoon,nextDueOverdue,hasOOS,viciousCircle:viciousCircle&&maint.length>0,critical,warning,lastPreTrip,preTripToday:!!(lastPreTrip&&String(lastPreTrip.submittedAt||'').split('T')[0]===now)};
}

// ═══════════════════════════════════════════════════════
// PRE-TRIP INSPECTIONS (driver portal results)
// ═══════════════════════════════════════════════════════
const DRIVER_FN_BASE='https://tmpdsiuadafbkmldvlki.supabase.co/functions/v1';
function inspDur(s){ if(s==null) return '—'; const m=Math.floor(s/60),x=s%60; return m+'m '+(x<10?'0':'')+x+'s'; }
function inspDT(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }

function renderInspections(){
  const rows=INSPECTIONS.slice().sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')));
  const todayStr=today();
  const todayCount=rows.filter(i=>String(i.submittedAt||'').split('T')[0]===todayStr).length;
  const defectCount=rows.filter(i=>i.overallResult==='defect').length;
  let html=`<div class="card" style="max-width:1040px;margin-bottom:18px"><div class="card-header"><span class="card-header-accent"></span>📋 Driver Pre-Trip Inspections</div><div class="card-body">
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <span class="badge badge-blue">${rows.length} total</span>
      ${todayCount?`<span class="badge badge-green">● ${todayCount} today</span>`:`<span class="badge badge-gray">none today</span>`}
      ${defectCount?`<span class="badge badge-red">${defectCount} with defects</span>`:''}
    </div>`;
  if(isAdmin()){
    const opts=VEHICLES.filter(v=>v.assignedDriverId).map(v=>{const d=DRIVERS.find(x=>x.id===v.assignedDriverId);return `<option value="${v.id}">Truck #${esc(v.truckNumber)} · ${esc(d?d.name:'')}</option>`;}).join('');
    html+=`<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div style="flex:1;min-width:220px"><label>Send pre-trip link to a driver</label>
        <select id="sl-vehicle"><option value="">— select truck —</option>${opts}</select></div>
      <button class="btn btn-primary" onclick="doSendLinkFromPicker()">📲 Send link</button>
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button id="pti-bulk-btn" class="btn btn-ghost" style="border:1px solid var(--border-strong)" onclick="doBulkSendAll()">📨 Send PTI link to ALL drivers</button>
      <span class="text-sm" id="pti-queue-status" style="color:var(--text2)"></span>
    </div>
    <div class="text-sm" style="margin-top:8px;color:var(--text3)">🔒 Links are sent only when you click here — never automatically. Bulk sends go out in waves of 5 every 5 minutes.</div>`;
    setTimeout(loadPtiQueueStatus,50);
  }
  html+=`</div></div>`;
  html+=`<div class="card" style="max-width:1040px"><div class="card-body" style="padding:0"><div class="table-wrap"><table>
    <thead><tr><th style="padding-left:18px">When</th><th>Truck</th><th>Driver</th><th>Result</th><th>Tyres</th><th>Checks</th><th>Walk-around</th><th>Ref</th></tr></thead><tbody>`;
  if(rows.length===0){
    html+=`<tr><td colspan="8" class="empty" style="padding:26px">No inspections yet.${isAdmin()?' Send a driver a link above to get the first one.':''}</td></tr>`;
  }
  rows.slice(0,200).forEach(i=>{
    const d=DRIVERS.find(x=>x.id===i.driverId);
    const rb=i.overallResult==='defect'?'badge-red':i.overallResult==='minor'?'badge-yellow':'badge-green';
    const rl=i.overallResult==='defect'?'Defect':i.overallResult==='minor'?'Minor':'Roadworthy';
    const quick=i.durationSec!=null&&i.durationSec<120;
    html+=`<tr onclick="openInspection('${i.id}')" style="cursor:pointer" title="Open full inspection">
      <td style="padding-left:18px;white-space:nowrap">${inspDT(i.submittedAt)}</td>
      <td><strong>#${esc(i.truckNumber||'')}</strong></td>
      <td>${esc(d?d.name:'—')}</td>
      <td><span class="badge ${rb}">${rl}</span></td>
      <td>${i.tyresFlagged?`<span style="color:var(--danger)">${i.tyresFlagged} flagged</span>`:`<span style="color:var(--success)">OK</span>`}</td>
      <td>${i.checksFailed?`<span style="color:var(--danger)">${i.checksFailed} failed</span>`:`<span style="color:var(--success)">OK</span>`}</td>
      <td style="white-space:nowrap">${inspDur(i.durationSec)}${quick?` <span title="Completed very quickly" style="color:var(--warning)">⚠</span>`:''}</td>
      <td class="text-sm">${esc(i.ref||'')}</td>
    </tr>`;
  });
  html+=`</tbody></table></div></div></div>`;
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
const PAGE_TITLES={dashboard:'Dashboard',vehicles:'Vehicles',drivers:'Drivers',calendar:'Calendar',reports:'Reports',inspections:'Pre-Trip Inspections',portal:'Driver Portal',vehicle:'Vehicle Detail',users:'User Management','dispatcher-board':'Dispatch Board',reminders:'Reminders'};

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
  // Collect unique dispatcher names from vehicle data
  const names=[...new Set(VEHICLES.map(v=>v.assignedDispatcher).filter(n=>n&&n.trim()!=''))].sort();
  const unassigned=VEHICLES.filter(v=>!v.assignedDispatcher||v.assignedDispatcher.trim()==='');

  // ── FILTERED VIEW: one dispatcher selected ──────────────
  if(currentDispatcherFilter!==null){
    const dispName=currentDispatcherFilter;
    const fleet=VEHICLES.filter(v=>v.assignedDispatcher===dispName);
    const initials=dispName.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    let html=`<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
      <button class="btn btn-ghost btn-sm" onclick="currentDispatcherFilter=null;render()" style="display:flex;align-items:center;gap:5px">
        <span style="font-family:'Material Symbols Outlined';font-size:16px;font-weight:300;line-height:1">arrow_back</span> All Dispatchers
      </button>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#ff8a65);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;flex-shrink:0">${initials}</div>
        <div>
          <div style="font-size:16px;font-weight:700">${esc(dispName)}'s Fleet</div>
          <div style="font-size:12px;color:var(--text2)">${fleet.length} truck${fleet.length!==1?'s':''} assigned</div>
        </div>
      </div>
    </div>`;
    if(fleet.length===0){
      html+=`<div class="empty" style="padding:40px">No trucks assigned to ${esc(dispName)}</div>`;
      return html;
    }
    const _fvVacSet=new Set(DRIVERS.filter(d=>d.on_vacation).map(d=>d.id));
    html+=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">`;
    fleet.forEach(v=>{
      const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
      const isVac=_fvVacSet.has(v.assignedDriverId);
      if(isVac){
        html+=`<div class="card" style="cursor:pointer;opacity:.55" onclick="navigate('vehicle','${v.id}')">
          <div class="card-body" style="padding:16px">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
              <div>
                <div style="font-size:15px;font-weight:700;color:var(--text2)">Truck #${esc(v.truckNumber)}</div>
                <div style="font-size:12px;color:var(--text3)">Trailer #${esc(v.trailerNumber)}</div>
              </div>
              <span style="background:rgba(245,158,11,.18);color:var(--warning);font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px">🏖️ Vacation</span>
            </div>
            ${driver?`<div style="font-size:12px;color:var(--text3);margin-bottom:6px">👤 ${esc(driver.name)}</div>`:''}
            <div style="font-size:11px;color:var(--text3)">Frozen — no alerts while on vacation</div>
          </div>
        </div>`;
        return;
      }
      const s=getVehicleStatus(v.id);
      const sb=s.critical?`<span class="badge badge-red">Critical</span>`:s.warning?`<span class="badge badge-yellow">Warning</span>`:`<span class="badge badge-green">OK</span>`;
      const brakeClass=s.brakeOverdue?'badge-red':s.brakeDueSoon?'badge-yellow':'badge-green';
      const tyreClass=s.tyreOverdue?'badge-yellow':'badge-green';
      const svcClass=s.serviceOverdue?'badge-red':s.serviceDueSoon?'badge-yellow':'badge-green';
      html+=`<div class="card" style="cursor:pointer" onclick="navigate('vehicle','${v.id}')">
        <div class="card-body" style="padding:16px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
            <div>
              <div style="font-size:15px;font-weight:700">Truck #${esc(v.truckNumber)}</div>
              <div style="font-size:12px;color:var(--text2)">Trailer #${esc(v.trailerNumber)}</div>
            </div>
            ${sb}
          </div>
          ${driver?`<div style="font-size:12px;color:var(--text2);margin-bottom:3px">👤 ${esc(driver.name)}</div>`:''}
          <div style="font-size:12px;color:var(--text2);margin-bottom:10px">📡 ${esc(dispName)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px">
            <span class="status-pill ${brakeClass}">🔧 Brakes ${s.brakeDays!==null?s.brakeDays+'d':'None'}</span>
            <span class="status-pill ${tyreClass}">⭕ Tyres ${s.tyreDays!==null?s.tyreDays+'d':'None'}</span>
            <span class="status-pill ${svcClass}">🔵 Service ${s.serviceDays!==null?s.serviceDays+'d':'None'}</span>
            <span class="status-pill ${s.preTripToday?'badge-green':'badge-gray'}">📋 PTI ${s.preTripToday?'✓ today':(s.lastPreTrip?fmtDate(s.lastPreTrip.submittedAt):'none')}</span>
          </div>
        </div>
      </div>`;
    });
    if(isAdmin()) html+=`<div class="card" style="cursor:pointer;min-height:160px;border:2px dashed var(--border);background:transparent;display:flex;align-items:center;justify-content:center;transition:border-color .15s,box-shadow .15s" onmouseover="this.style.borderColor='var(--primary)';this.style.boxShadow='0 0 0 1px var(--primary)'" onmouseout="this.style.borderColor='';this.style.boxShadow=''" onclick="openAddVehicleModal('${dispName.replace(/'/g,"\\'")}')"><div style="text-align:center;color:var(--text3);pointer-events:none"><div style="font-size:48px;font-weight:200;line-height:1">+</div><div style="font-size:12px;font-weight:600;margin-top:8px">Add New</div></div></div>`;
    html+=`</div>`;
    return html;
  }

  // ── BOARD VIEW: all dispatchers ─────────────────────────
  const _dbVacSet=new Set(DRIVERS.filter(d=>d.on_vacation).map(d=>d.id));
  let html='';
  if(!isAdmin()) html+=dispatcherNotice();
  if(names.length===0&&unassigned.length===0){
    return`<div class="empty" style="padding:60px;text-align:center">No vehicles with dispatcher assignments yet.<br><span style="font-size:12px;color:var(--text3)">Assign dispatchers to vehicles on the Vehicles page.</span></div>`;
  }
  html+=`<div class="db-board">`;
  names.forEach(name=>{
    const trucks=VEHICLES.filter(v=>v.assignedDispatcher===name);
    const activeTrucks=trucks.filter(v=>!_dbVacSet.has(v.assignedDriverId));
    const vacTrucks=trucks.filter(v=>_dbVacSet.has(v.assignedDriverId));
    const statuses=activeTrucks.map(v=>getVehicleStatus(v.id));
    const critCount=statuses.filter(s=>s.critical).length;
    const warnCount=statuses.filter(s=>s.warning&&!s.critical).length;
    const okCount=activeTrucks.length-critCount-warnCount;
    const healthPct=activeTrucks.length?Math.round((okCount/activeTrucks.length)*100):100;
    const barColor=critCount>0?'var(--danger)':warnCount>0?'var(--warning)':'var(--success)';
    const initials=name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const chipHtml=
      (okCount>0   ?`<span class="db-fleet-chip ok">✅ ${okCount} Good</span>`:'')
     +(warnCount>0 ?`<span class="db-fleet-chip warn">⚠ ${warnCount} Warn</span>`:'')
     +(critCount>0 ?`<span class="db-fleet-chip crit">🔴 ${critCount} Critical</span>`:'')
     +(vacTrucks.length>0?`<span class="db-fleet-chip" style="background:rgba(245,158,11,.12);color:var(--warning)">🏖️ ${vacTrucks.length} Vacation</span>`:'')
     +`<div class="db-health-bar-wrap"><div class="db-health-bar-fill" style="width:${healthPct}%;background:${barColor}"></div></div>`;
    const activeRows=activeTrucks.map((v,i)=>{
      const s=statuses[i];
      const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
      const brakeClass=s.brakeOverdue?'badge-red':s.brakeDueSoon?'badge-yellow':'badge-green';
      const tyreClass=s.tyreOverdue?'badge-yellow':'badge-green';
      const svcClass=s.serviceOverdue?'badge-red':s.serviceDueSoon?'badge-yellow':'badge-green';
      const rowPulse=s.critical?'fg-row-crit':s.warning?'fg-row-warn':'';
      return`<div class="db-truck-row ${rowPulse}">
        <div class="db-truck-icon">local_shipping</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;line-height:1.2">#${esc(v.truckNumber)}</div>
          ${driver?`<div style="font-size:11px;color:var(--text2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">👤 ${esc(driver.name)}</div>`:''}
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <span class="status-pill ${brakeClass}" style="font-size:9px">🔧 ${s.brakeDays!==null?s.brakeDays+'d':'—'}</span>
          <span class="status-pill ${tyreClass}" style="font-size:9px">⭕ ${s.tyreDays!==null?s.tyreDays+'d':'—'}</span>
          <span class="status-pill ${svcClass}" style="font-size:9px">🔵 ${s.serviceDays!==null?s.serviceDays+'d':'—'}</span>
          <span class="status-pill ${s.preTripToday?'badge-green':'badge-gray'}" style="font-size:9px">📋 ${s.preTripToday?'✓':'—'}</span>
        </div>
      </div>`;
    });
    const vacRows=vacTrucks.map(v=>{
      const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
      return`<div class="db-truck-row" style="opacity:.5">
        <div class="db-truck-icon">local_shipping</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;line-height:1.2;color:var(--text3)">#${esc(v.truckNumber)}</div>
          ${driver?`<div style="font-size:11px;color:var(--text3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">👤 ${esc(driver.name)}</div>`:''}
        </div>
        <span style="font-size:9px;background:rgba(245,158,11,.15);color:var(--warning);padding:2px 7px;border-radius:20px;font-weight:700;flex-shrink:0">🏖️ Vacation</span>
      </div>`;
    });
    const rows=[...activeRows,...vacRows].join('');
    html+=`<div class="card" style="cursor:pointer;overflow:hidden;transition:border-color .15s,box-shadow .15s,transform .15s" onmouseover="this.style.borderColor='var(--primary)';this.style.boxShadow='0 0 0 1px var(--primary)';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='';this.style.boxShadow='';this.style.transform=''" onclick="currentDispatcherFilter='${name.replace(/'/g,"\\'")}';render()">
      <div style="padding:16px 18px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#ff8a65);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#fff;flex-shrink:0;box-shadow:0 0 12px var(--primary-glow)">${initials}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:800">${esc(name)}</div>
            <div style="font-size:11px;color:var(--text2);margin-top:2px">${trucks.length} truck${trucks.length!==1?'s':''} &nbsp;·&nbsp; <span style="color:var(--primary)">View fleet →</span></div>
          </div>
        </div>
        <div class="db-fleet-stats">${chipHtml}</div>
      </div>
      <div>${rows}</div>
    </div>`;
  });
  if(unassigned.length>0){
    const rows=unassigned.map(v=>`<div class="db-truck-row">
      <div class="db-truck-icon">local_shipping</div>
      <div style="font-size:13px;font-weight:700">Truck #${v.truckNumber}</div>
    </div>`).join('');
    html+=`<div class="card" style="opacity:.65;overflow:hidden">
      <div style="padding:16px 18px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:44px;height:44px;border-radius:50%;background:var(--surface-highest,#32353c);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">?</div>
          <div>
            <div style="font-size:15px;font-weight:800;color:var(--text2)">Unassigned</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${unassigned.length} truck${unassigned.length!==1?'s':''}</div>
          </div>
        </div>
      </div>
      <div>${rows}</div>
    </div>`;
  }
  html+=`</div>`;
  return html;
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
  let html=`<div class="stats-grid">
    <div class="stat-card"><div class="stat-icon" style="background:#dbeafe">🚛</div><div><div class="stat-num">${VEHICLES.length}</div><div class="stat-label">Total vehicles</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#dcfce7">✅</div><div><div class="stat-num" style="color:var(--success)">${roadworthy}</div><div class="stat-label">Roadworthy</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#fee2e2">⚠️</div><div><div class="stat-num" style="color:var(--danger)">${critical}</div><div class="stat-label">Critical issues</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#f3e8ff">👤</div><div><div class="stat-num">${DRIVERS.length}</div><div class="stat-label">Drivers</div></div></div>
  </div>`;
  if(serviceOverdue.length>0) html+=`<div class="alert-urgent"><div style="flex:1"><div class="au-title">🚨 Service Overdue — YARD VISIT ASAP</div>${serviceOverdue.map(x=>{const dr=DRIVERS.find(d=>d.id===x.v.assignedDriverId);const drName=dr?esc(dr.name):'Unassigned Driver';const disp=esc(x.v.assignedDispatcher||'Unassigned');return`<div class="au-row"><div><div class="au-truck">Truck #${esc(x.v.truckNumber)}</div><div class="au-detail">${drName} &nbsp;·&nbsp; ${disp}</div></div><a href="#" onclick="navigate('vehicle','${x.v.id}');return false"><span class="au-badge">OVERDUE</span></a></div>`;}).join('')}</div></div>`;
  if(vicious.length>0) html+=`<div class="alert alert-warning"><div><div class="alert-title">🔄 Vicious Circle Alert</div>${vicious.map(x=>`<a href="#" onclick="navigate('vehicle','${x.v.id}');return false"><span class="badge badge-yellow" style="margin-right:6px">Truck #${esc(x.v.truckNumber)}</span></a>`).join('')}</div></div>`;
  html+=`<div class="two-col">`;
  html+=`<div class="card"><div class="card-header">🔴 Brake Inspection Overdue</div><div class="card-body">`;
  if(brakeOverdue.length===0) html+=`<div class="empty">All vehicles within 42-day schedule</div>`;
  brakeOverdue.forEach(x=>{html+=`<div class="history-item" style="border-left:3px solid var(--danger);cursor:pointer" onclick="navigate('vehicle','${x.v.id}')"><div><div class="fw-600">Truck #${esc(x.v.truckNumber)}</div><div class="text-sm">${x.s.lastBrake?x.s.brakeDays+' days since last test':'No test on record'}</div></div><span class="badge badge-red">OVERDUE</span></div>`;});
  html+=`</div></div>`;
  html+=`<div class="card"><div class="card-header">🟡 Brake Test Due Soon</div><div class="card-body">`;
  if(brakeDueSoon.length===0) html+=`<div class="empty">No vehicles due in next 7 days</div>`;
  brakeDueSoon.forEach(x=>{const d=42-x.s.brakeDays;html+=`<div class="history-item" style="cursor:pointer" onclick="navigate('vehicle','${x.v.id}')"><div><div class="fw-600">Truck #${esc(x.v.truckNumber)}</div><div class="text-sm">Due in ${d} day${d===1?'':'s'}</div></div><span class="badge badge-yellow">DUE SOON</span></div>`;});
  html+=`</div></div>`;
  html+=`<div class="card"><div class="card-header">🟠 Tyre Check Overdue</div><div class="card-body">`;
  if(tyreOverdue.length===0) html+=`<div class="empty">All tyre checks are current</div>`;
  tyreOverdue.forEach(x=>{html+=`<div class="history-item" style="cursor:pointer" onclick="navigate('vehicle','${x.v.id}')"><div><div class="fw-600">Truck #${esc(x.v.truckNumber)}</div><div class="text-sm">${x.s.lastTyre?x.s.tyreDays+' days since last check':'No check on record'}</div></div><span class="badge badge-yellow">${x.s.tyreDays===null?'NONE':x.s.tyreDays+' days'}</span></div>`;});
  html+=`</div></div>`;
  html+=`<div class="card"><div class="card-header">🔵 Service Overdue (60-day)</div><div class="card-body">`;
  if(serviceOverdue.length===0) html+=`<div class="empty">All vehicles within 60-day service schedule</div>`;
  serviceOverdue.forEach(x=>{html+=`<div class="history-item" style="border-left:3px solid var(--primary);cursor:pointer" onclick="navigate('vehicle','${x.v.id}')"><div><div class="fw-600">Truck #${esc(x.v.truckNumber)}</div><div class="text-sm">${x.s.serviceDays+' days since last service'}</div></div><span class="badge badge-blue">OVERDUE</span></div>`;});
  html+=`</div></div>`;
  const allRecent=[...MAINTENANCE.map(r=>({date:r.serviceDate,label:`Service – Truck #${VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'}`,type:'maint'})),...BRAKE_TESTS.map(r=>({date:r.testDate,label:`Brake ${r.result} – Truck #${VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'}`,type:'brake',pass:r.result==='pass'})),...SERVICE_RECORDS.map(r=>({date:r.serviceDate,label:`Vehicle Service ${r.result} – Truck #${VEHICLES.find(v=>v.id===r.vehicleId)?.truckNumber||'?'}`,type:'svc',pass:r.result==='pass'}))].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6);
  html+=`<div class="card"><div class="card-header">📋 Recent Activity</div><div class="card-body">`;
  if(allRecent.length===0) html+=`<div class="empty">No activity yet</div>`;
  allRecent.forEach(r=>{const badge=r.type==='brake'?(r.pass?'badge-green':'badge-red'):r.type==='svc'?(r.pass?'badge-green':'badge-yellow'):'badge-blue';html+=`<div class="history-item"><span>${r.label}</span><span class="badge ${badge}">${fmtDate(r.date)}</span></div>`;});
  html+=`</div></div></div>`;
  if(VEHICLES.length===0) html+=`<div class="alert alert-success" style="margin-top:20px"><div><div class="alert-title">👋 Welcome to FleetGuard!</div>Start by adding drivers and vehicles.${isAdmin()?` <a href="#" onclick="navigate('vehicles');return false" style="color:var(--primary);font-weight:600">→ Add your first vehicle</a>`:''}</div></div>`;
  return html;
}

// ═══════════════════════════════════════════════════════
// VEHICLES
// ═══════════════════════════════════════════════════════
function renderVehicles(){
  let html='';
  if(isAdmin()){
    html+=`<div class="card mb-4" style="margin-bottom:20px;max-width:640px"><div class="card-header">🚛 Add Vehicle</div><div class="card-body">
      <div class="form-grid form-grid-3" style="margin-bottom:12px">
        <div><label>Truck Number</label><input type="text" id="v-truck" placeholder="e.g. T001"/></div>
        <div><label>Trailer Number</label><input type="text" id="v-trailer" placeholder="e.g. TR001"/></div>
        <div><label>Assign Driver</label><select id="v-driver"><option value="">— optional —</option>${DRIVERS.map(d=>`<option value="${d.id}">${d.name}</option>`).join('')}</select></div>
        <div><label>Assign Dispatcher</label><input type="text" id="v-dispatcher" placeholder="Dispatcher name"/></div>
      </div>
      <button class="btn btn-primary" onclick="doAddVehicle()">+ Add Vehicle</button>
    </div></div>`;
  } else { html+=dispatcherNotice(); }
  html+=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">`;
  if(VEHICLES.length===0) html+=`<div class="empty" style="grid-column:1/-1;padding:40px">No vehicles yet${isAdmin()?' — add one above.':'.'}</div>`;
  VEHICLES.forEach(v=>{
    const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
    const s=getVehicleStatus(v.id);
    const sb2=s.critical?`<span class="badge badge-red">Critical</span>`:s.warning?`<span class="badge badge-yellow">Warning</span>`:`<span class="badge badge-green">OK</span>`;
    html+=`<div class="card" id="vcard-${v.id}">
      <!-- VIEW MODE -->
      <div id="vview-${v.id}" class="card-body" style="padding:16px">
        <div class="flex-between mb-4" style="margin-bottom:10px">
          <div onclick="navigate('vehicle','${v.id}')" style="cursor:pointer;flex:1">
            <div class="fw-600" style="font-size:15px">Truck #${esc(v.truckNumber)}</div>
            <div class="text-sm">Trailer #${esc(v.trailerNumber)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            ${sb2}
            ${isAdmin()?`<button class="btn btn-ghost btn-sm" onclick="startEditVehicle('${v.id}')" title="Edit">✏️</button><button class="btn btn-ghost btn-sm btn-icon" onclick="event.stopPropagation();doDeleteVehicle('${v.id}','${v.truckNumber}')" title="Delete">🗑</button>`:''}
          </div>
        </div>
        ${driver?`<div class="text-sm">👤 ${esc(driver.name)}</div>`:''}
        ${v.assignedDispatcher?`<div class="text-sm">📡 ${esc(v.assignedDispatcher)}</div>`:''}
        <div class="status-row" style="margin-top:10px">
          <span class="status-pill ${s.brakeOverdue?'badge-red':s.brakeDueSoon?'badge-yellow':'badge-green'}">🔧 Brakes ${s.lastBrake?s.brakeDays+'d':'None'}</span>
          <span class="status-pill ${s.tyreOverdue?'badge-yellow':'badge-green'}">⭕ Tyres ${s.lastTyre?s.tyreDays+'d':'None'}</span>
          <span class="status-pill ${s.serviceOverdue?'badge-red':s.serviceDueSoon?'badge-yellow':'badge-green'}">🔵 Service ${s.serviceDays!==null?s.serviceDays+'d':'None'}</span>
          <span class="status-pill ${s.preTripToday?'badge-green':'badge-gray'}">📋 Pre-trip ${s.preTripToday?'✓ today':(s.lastPreTrip?fmtDate(s.lastPreTrip.submittedAt):'none')}</span>
        </div>
        ${isAdmin()&&v.assignedDriverId?`<button class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%" onclick="doSendLink('${v.assignedDriverId}','${v.id}','${esc(v.truckNumber)}')">📲 Send pre-trip link</button>`:''}
      </div>
      <!-- EDIT MODE -->
      <div id="vedit-${v.id}" style="display:none" class="card-body" style="padding:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:10px">✏️ Edit Vehicle</div>
        <div class="form-grid" style="margin-bottom:10px">
          <div><label>Truck #</label><input type="text" id="ve-truck-${v.id}" value="${esc(v.truckNumber)}"/></div>
          <div><label>Trailer #</label><input type="text" id="ve-trailer-${v.id}" value="${esc(v.trailerNumber)}"/></div>
          <div><label>Driver</label><select id="ve-driver-${v.id}"><option value="">— none —</option>${DRIVERS.map(d=>`<option value="${d.id}"${v.assignedDriverId===d.id?' selected':''}>${esc(d.name)}</option>`).join('')}</select></div>
          <div><label>Dispatcher</label><input type="text" id="ve-dispatcher-${v.id}" value="${esc(v.assignedDispatcher||'')}"/></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="doSaveVehicle('${v.id}')">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelEditVehicle('${v.id}')">Cancel</button>
        </div>
      </div>
    </div>`;
  });
  html+=`</div>`;
  return html;
}

async function doAddVehicle(){
  if(!isAdmin()) return;
  const truck=document.getElementById('v-truck').value.trim(),trailer=document.getElementById('v-trailer').value.trim(),driver=document.getElementById('v-driver').value,dispatcher=document.getElementById('v-dispatcher').value.trim();
  if(!truck||!trailer){showToast('Enter truck and trailer numbers','danger');return;}
  await addVehicle(truck,trailer,driver||null,dispatcher||''); showToast('Vehicle added!','success'); render();
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
  await addVehicle(truck,trailer,driverId||null,dispatcher||_avmDispatcher);
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
function renderVehicleDetail(){
  const v=VEHICLES.find(v=>v.id===currentVehicleId);
  if(!v) return`<div class="alert alert-danger">Vehicle not found. <a href="#" onclick="navigate('vehicles');return false">Back</a></div>`;
  const driver=DRIVERS.find(d=>d.id===v.assignedDriverId);
  const s=getVehicleStatus(v.id);
  const maint=MAINTENANCE.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
  const brakes=BRAKE_TESTS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.testDate.localeCompare(a.testDate));
  const tyres=TYRE_RECORDS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.photoDate.localeCompare(a.photoDate));
  const dots=DOT_INSPECTIONS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.inspectionDate.localeCompare(a.inspectionDate));
  const miles=MILEAGE.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.date.localeCompare(a.date));
  const svcs=SERVICE_RECORDS.filter(r=>r.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
  const tabs=['maintenance','brakes','tyres','dot','pti'];
  const tabLabels={maintenance:'🔧 Service',brakes:'🛑 Brakes',tyres:'⭕ Tyres',dot:'📋 DOT',pti:'🚛 PTI'};
  let html=`<div style="margin-bottom:16px;display:flex;align-items:center;gap:12px">
    <button class="btn btn-ghost btn-sm" onclick="navigate('vehicles')">← Back</button>
    <div>
      <div style="font-size:20px;font-weight:700">Truck #${esc(v.truckNumber)}</div>
      <div class="text-sm">Trailer #${esc(v.trailerNumber)}${driver?' · Driver: '+esc(driver.name):''}${v.assignedDispatcher?' · Dispatcher: '+esc(v.assignedDispatcher):''}</div>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px">${s.critical?`<span class="badge badge-red">Critical</span>`:s.warning?`<span class="badge badge-yellow">Warning</span>`:`<span class="badge badge-green">Roadworthy</span>`}</div>
  </div>
  ${!isAdmin()?dispatcherNotice():''}
  <div class="tabs">${tabs.map(t=>`<button class="tab ${currentVehicleTab===t?'active':''}" onclick="setVTab('${t}')">${tabLabels[t]}</button>`).join('')}</div>`;

  if(currentVehicleTab==='maintenance'){
    const allSvcRecords=[
      ...maint.map(r=>({...r,_type:'maint',_date:r.serviceDate,_result:null})),
      ...svcs.map(r=>({...r,_type:'svc',_date:r.serviceDate,_result:r.result}))
    ].sort((a,b)=>b._date.localeCompare(a._date));
    const nextDueDate=maint[0]?.nextInspectionDate||null;
    const nextDueDays=nextDueDate?daysBetween(today(),nextDueDate):null;
    const svcWarning=s.serviceOverdue||s.serviceDueSoon;
    html+=`<div class="two-col">`;
    if(isAdmin()) html+=`<div class="card"><div class="card-header">Record Service</div><div class="card-body">
      <div class="form-grid">
        <div><label>Service Date</label><input type="date" id="svc-date" value="${today()}" max="${today()}"/></div>
        <div><label>Result</label><div class="toggle-group"><button class="toggle-btn active-pass" id="svctog-pass" onclick="setServiceResult('pass')">✓ Pass</button><button class="toggle-btn" id="svctog-fail" onclick="setServiceResult('fail')">✗ Fail</button></div></div>
        <div><label>Notes (optional)</label><textarea id="svc-notes" rows="2" placeholder="Any notes..."></textarea></div>
      </div>
      <button class="btn btn-primary mt-4" style="margin-top:12px" onclick="doAddUnifiedService('${v.id}')">Save Service Record</button>
    </div></div>`;
    html+=`<div class="card"><div class="card-header">Service History (${allSvcRecords.length})`;
    if(nextDueDate) html+=` <span class="badge ${nextDueDays!==null&&nextDueDays<0?'badge-red':nextDueDays!==null&&nextDueDays<=14?'badge-yellow':'badge-blue'}" style="margin-left:8px">Next due: ${fmtDate(nextDueDate)}</span>`;
    html+=`</div><div class="card-body">`;
    if(svcWarning) html+=`<div class="history-item" style="border-left:3px solid ${s.serviceOverdue?'var(--danger)':'var(--warning)'};margin-bottom:8px"><div class="fw-600" style="color:${s.serviceOverdue?'var(--danger)':'var(--warning)'}">${s.serviceOverdue?'⚠️ Service overdue — '+s.serviceDays+' days since last service':'🔔 Service due soon — '+s.serviceDays+' days since last service'}</div></div>`;
    if(allSvcRecords.length===0) html+=`<div class="empty">No records yet</div>`;
    allSvcRecords.forEach(r=>{
      if(r._type==='maint'){
        html+=`<div class="history-item"><div><div class="fw-600">Service: ${fmtDate(r.serviceDate)}</div><div class="text-sm">Next due: ${fmtDate(r.nextInspectionDate)}</div>${r.notes?`<div class="text-sm">${esc(r.notes)}</div>`:''}</div><div style="display:flex;gap:8px;align-items:center"><span class="badge badge-blue">LOGGED</span>${isAdmin()?`<button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteMaintenance('${r.id}')">🗑</button>`:''}</div></div>`;
      } else {
        html+=`<div class="history-item"><div><div class="fw-600">${fmtDate(r.serviceDate)}</div>${r.notes?`<div class="text-sm">${esc(r.notes)}</div>`:''}</div><div style="display:flex;gap:8px;align-items:center"><span class="badge ${r.result==='pass'?'badge-green':'badge-red'}">${r.result.toUpperCase()}</span>${isAdmin()?`<button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteService('${r.id}')">🗑</button>`:''}</div></div>`;
      }
    });
    html+=`</div></div></div>`;
  }
  if(currentVehicleTab==='brakes'){
    html+=`<div class="two-col">`;
    if(isAdmin()) html+=`<div class="card"><div class="card-header">Record Brake Test</div><div class="card-body">
      <div class="form-grid">
        <div><label>Test Date</label><input type="date" id="b-date" value="${today()}" max="${today()}"/></div>
        <div><label>Result</label><div class="toggle-group"><button class="toggle-btn active-pass" id="btog-pass" onclick="setBrakeResult('pass')">✓ Pass</button><button class="toggle-btn" id="btog-fail" onclick="setBrakeResult('fail')">✗ Fail</button></div></div>
        <div><label>Notes (optional)</label><textarea id="b-notes" rows="2"></textarea></div>
      </div>
      <button class="btn btn-primary mt-4" style="margin-top:12px" onclick="doAddBrake('${v.id}')">Save Brake Test</button>
    </div></div>`;
    html+=`<div class="card"><div class="card-header">Brake History (${brakes.length})</div><div class="card-body">`;
    if(brakes.length===0) html+=`<div class="empty">No tests yet</div>`;
    brakes.forEach(r=>{html+=`<div class="history-item"><div><div class="fw-600">${fmtDate(r.testDate)}</div>${r.notes?`<div class="text-sm">${esc(r.notes)}</div>`:''}</div><div style="display:flex;gap:8px;align-items:center"><span class="badge ${r.result==='pass'?'badge-green':'badge-red'}">${r.result.toUpperCase()}</span>${isAdmin()?`<button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteBrake('${r.id}')">🗑</button>`:''}</div></div>`;});
    html+=`</div></div></div>`;
  }
  if(currentVehicleTab==='tyres'){
    html+=`<div class="two-col">`;
    if(isAdmin()){
      html+=`<div class="card"><div class="card-header">Record Tyre Check</div><div class="card-body">
        <div style="margin-bottom:12px"><label>Photo Date</label><input type="date" id="t-date" value="${today()}" max="${today()}"/></div>
        <div class="tyre-grid">`;
      AXLES.forEach((axle,ai)=>{
        html+=`<div class="axle-row"><div class="axle-name">${axle.name}</div><div class="tyre-selects">`;
        axle.sides.forEach(pos=>{html+=`<div class="tyre-select-row"><label>${pos.replace('-','<br>')}</label><select id="t-${ai}-${pos}" onchange="updateTyreDot(this,'t-dot-${ai}-${pos}')"><option value="good">Good</option><option value="bad">Bad</option><option value="uneven">Uneven</option></select><div class="tyre-dot dot-good" id="t-dot-${ai}-${pos}"></div></div>`;});
        html+=`</div></div>`;
      });
      html+=`</div><button class="btn btn-primary mt-4" style="margin-top:14px" onclick="doAddTyre('${v.id}')">Save Tyre Record</button></div></div>`;
    }
    html+=`<div class="card"><div class="card-header">Tyre History (${tyres.length})</div><div class="card-body">`;
    if(tyres.length===0) html+=`<div class="empty">No tyre records yet</div>`;
    tyres.forEach(r=>{const readings=Array.isArray(r.readings)?r.readings:[];const hasBad=readings.some(rd=>rd.status==='bad'),hasUneven=readings.some(rd=>rd.status==='uneven');html+=`<div class="history-item"><div><div class="fw-600">Photo: ${fmtDate(r.photoDate)}</div><div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">${readings.map(rd=>`<div class="tyre-dot ${rd.status==='good'?'dot-good':rd.status==='bad'?'dot-bad':'dot-uneven'}" title="${rd.position}: ${rd.status}"></div>`).join('')}</div></div><div style="display:flex;gap:6px;align-items:center">${hasBad?`<span class="badge badge-red">Bad</span>`:hasUneven?`<span class="badge badge-yellow">Uneven</span>`:`<span class="badge badge-green">OK</span>`}${isAdmin()?`<button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteTyre('${r.id}')">🗑</button>`:''}</div></div>`;});
    html+=`</div></div></div>`;
  }
  if(currentVehicleTab==='dot'){
    html+=`<div class="two-col">`;
    if(isAdmin()) html+=`<div class="card"><div class="card-header">Record DOT Inspection</div><div class="card-body">
      <div class="form-grid">
        <div><label>Inspection Date</label><input type="date" id="d-date" value="${today()}" max="${today()}"/></div>
        <div><label>Driver</label><select id="d-driver"><option value="">— select —</option>${DRIVERS.map(d=>`<option value="${d.id}">${d.name}</option>`).join('')}</select></div>
        <div><label>Result</label><div class="toggle-group"><button class="toggle-btn active-pass" id="dtog-pass" onclick="setDotResult('pass')">✓ Pass</button><button class="toggle-btn" id="dtog-violation" onclick="setDotResult('violation')">⚠ Violation</button><button class="toggle-btn" id="dtog-oos" onclick="setDotResult('oos')">🚫 OOS</button></div></div>
        <div><label>Notes (optional)</label><textarea id="d-notes" rows="2"></textarea></div>
      </div>
      <button class="btn btn-primary mt-4" style="margin-top:12px" onclick="doAddDOT('${v.id}')">Save DOT Inspection</button>
    </div></div>`;
    html+=`<div class="card"><div class="card-header">DOT History (${dots.length})</div><div class="card-body">`;
    if(dots.length===0) html+=`<div class="empty">No DOT inspections recorded</div>`;
    dots.forEach(r=>{const dName=DRIVERS.find(d=>d.id===r.driverId)?.name;html+=`<div class="history-item"><div><div class="fw-600">${fmtDate(r.inspectionDate)}</div>${dName?`<div class="text-sm">👤 ${esc(dName)}</div>`:''}${r.notes?`<div class="text-sm">${esc(r.notes)}</div>`:''}</div><div style="display:flex;gap:6px;align-items:center"><span class="badge ${r.result==='pass'?'badge-green':r.result==='violation'?'badge-yellow':'badge-red'}">${r.result.toUpperCase()}</span>${isAdmin()?`<button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteDOT('${r.id}')">🗑</button>`:''}</div></div>`;});
    html+=`</div></div></div>`;
  }
  if(currentVehicleTab==='pti'){
    const preTrips=INSPECTIONS.filter(r=>r.vehicleId===v.id).sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')));
    const lastLink=LINK_SENDS.filter(r=>r.status==='sent'&&(r.vehicleId===v.id||(v.assignedDriverId&&r.driverId===v.assignedDriverId))).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0];
    html+=`<div class="two-col">`;
    html+=`<div class="card"><div class="card-header">Send Pre-Trip Link</div><div class="card-body">`;
    html+=`<div class="text-sm" style="margin-bottom:10px">📤 Last PTI link sent: <b>${lastLink?fmtDate(lastLink.createdAt):'never'}</b></div>`;
    if(v.assignedDriverId){
      html+=`<div class="text-sm" style="margin-bottom:12px;color:var(--text2)">Text the driver a link to complete a fresh pre-trip inspection (tyre photos required).</div>
        <button class="btn btn-primary" onclick="doSendLink('${v.assignedDriverId}','${v.id}','${esc(v.truckNumber)}')">📲 Send PTI link${driver?' to '+esc(driver.name):''}</button>
        <div class="text-sm" style="margin-top:10px;color:var(--text3)">🔒 Sent only when you click — never automatically.</div>`;
    } else {
      html+=`<div class="empty">No driver assigned — assign a driver to this truck to send a PTI link.</div>`;
    }
    html+=`</div></div>`;
    html+=`<div class="card"><div class="card-header">Pre-Trip History (${preTrips.length})</div><div class="card-body">`;
    if(preTrips.length===0) html+=`<div class="empty">No pre-trip inspections yet</div>`;
    preTrips.forEach(r=>{
      const rb=r.overallResult==='defect'?'badge-red':r.overallResult==='minor'?'badge-yellow':'badge-green';
      const rl=r.overallResult==='defect'?'Defect':r.overallResult==='minor'?'Minor':'Roadworthy';
      const dName=DRIVERS.find(d=>d.id===r.driverId)?.name;
      const flags=[];
      if(r.tyresFlagged) flags.push(`${r.tyresFlagged} tyre${r.tyresFlagged>1?'s':''} flagged`);
      if(r.checksFailed) flags.push(`${r.checksFailed} check${r.checksFailed>1?'s':''} failed`);
      html+=`<div class="history-item" style="cursor:pointer" onclick="openInspection('${r.id}')" title="Open full inspection"><div><div class="fw-600">${inspDT(r.submittedAt)}</div>${dName?`<div class="text-sm">👤 ${esc(dName)}</div>`:''}${flags.length?`<div class="text-sm" style="color:var(--danger)">${flags.join(' · ')}</div>`:''}</div><div style="display:flex;gap:6px;align-items:center"><span class="badge ${rb}">${rl}</span></div></div>`;
    });
    html+=`</div></div></div>`;
  }
  return html;
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
  let html='';
  if(isAdmin()){
    html+=`<div class="card mb-4" style="margin-bottom:20px;max-width:480px"><div class="card-header">👤 Add Driver</div><div class="card-body">
      <div style="display:flex;gap:10px"><input type="text" id="d-name" placeholder="Full name" style="flex:1" onkeydown="if(event.key==='Enter')doAddDriver()"/><button class="btn btn-primary" onclick="doAddDriver()">+ Add</button></div>
    </div></div>`;
  } else {html+=dispatcherNotice();}
  html+=`<div class="card" style="max-width:640px"><div class="card-header">All Drivers (${DRIVERS.length})</div><div class="card-body" style="padding:0">`;
  html+=`<div class="table-wrap"><table><thead><tr><th>Driver</th><th>Assigned Truck</th><th>Dispatcher</th>${isAdmin()?'<th>Actions</th>':''}</tr></thead><tbody>`;
  if(DRIVERS.length===0) html+=`<tr><td colspan="${isAdmin()?4:3}" class="empty" style="padding:20px;text-align:center">No drivers added yet</td></tr>`;
  DRIVERS.forEach(d=>{
    const assignedVehicles=VEHICLES.filter(v=>v.assignedDriverId===d.id);
    const truckNames=assignedVehicles.map(v=>`Truck #${esc(v.truckNumber)}`).join(', ')||'—';
    const dispatchers=[...new Set(assignedVehicles.map(v=>v.assignedDispatcher).filter(Boolean))].map(esc).join(', ')||'—';
    const isVac=!!d.on_vacation;
    html+=`<tr id="driver-row-${d.id}" style="${isVac?'opacity:.6;background:rgba(245,158,11,.04)':''}">
      <td>
        <div id="driver-view-${d.id}" style="display:flex;align-items:center;gap:8px">
          <span class="fw-600" style="color:${isVac?'var(--text3)':''}">${esc(d.name)}</span>
          ${isVac?'<span style="background:rgba(245,158,11,.18);color:var(--warning);font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px">🏖️ Vacation</span>':''}
        </div>
        <div id="driver-edit-${d.id}" style="display:none;gap:8px;align-items:center">
          <input type="text" value="${d.name}" id="dedit-${d.id}" style="flex:1;min-width:120px"/>
          <button class="btn btn-success btn-sm" onclick="doUpdateDriver('${d.id}')">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="cancelEditDriver('${d.id}')">Cancel</button>
        </div>
      </td>
      <td class="text-sm">${truckNames}</td>
      <td class="text-sm">${dispatchers}</td>
      ${isAdmin()?`<td><div style="display:flex;gap:6px" id="driver-btns-${d.id}">${isVac
        ?`<button class="btn btn-sm" onclick="toggleDriverVacation('${d.id}',false)" style="background:rgba(120,220,119,.1);border:1px solid rgba(120,220,119,.4);color:var(--success);font-size:11.5px">↩ Return</button>`
        :`<button class="btn btn-ghost btn-sm" onclick="startEditDriver('${d.id}')">✏ Edit</button><button class="btn btn-ghost btn-sm btn-icon" onclick="doDeleteDriver('${d.id}','${d.name.replace(/'/g,"\\'")}')">🗑</button><button class="btn btn-sm" onclick="toggleDriverVacation('${d.id}',true)" style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.35);color:var(--warning);font-size:11px;font-weight:700" title="Set on vacation">🏖️</button>`
      }</div></td>`:''}
    </tr>`;
  });
  html+=`</tbody></table></div></div></div>`;
  return html;
}
async function doAddDriver(){if(!isAdmin())return;const name=document.getElementById('d-name').value.trim();if(!name){showToast('Enter a driver name','danger');return;}await addDriver(name);document.getElementById('d-name').value='';showToast('Driver added!','success');render();}
function startEditDriver(id){document.getElementById('driver-view-'+id).style.display='none';document.getElementById('driver-edit-'+id).style.display='flex';document.getElementById('driver-btns-'+id).style.display='none';document.getElementById('dedit-'+id).focus();}
function cancelEditDriver(id){document.getElementById('driver-view-'+id).style.display='flex';document.getElementById('driver-edit-'+id).style.display='none';document.getElementById('driver-btns-'+id).style.display='flex';}
async function doUpdateDriver(id){if(!isAdmin())return;const name=document.getElementById('dedit-'+id).value.trim();if(!name){showToast('Name cannot be empty','danger');return;}await updateDriver(id,name);showToast('Driver updated!','success');render();}
async function doDeleteDriver(id,name){if(!isAdmin())return;const ok=await confirm2(`Delete driver "${name}"?`,'This driver will be removed from all vehicles.');if(!ok)return;await deleteDriver(id);showToast('Driver deleted','warning');render();}

// ═══════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════
function renderCalendar(){
  const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth();
  const firstDay=new Date(year,month,1).getDay(),daysInMonth=new Date(year,month+1,0).getDate();
  const todayStr=today(),events=[];
  const _calVacSet=new Set(DRIVERS.filter(d=>d.on_vacation).map(d=>d.id));
  VEHICLES.forEach(v=>{
    if(_calVacSet.has(v.assignedDriverId)) return;
    const brakes=BRAKE_TESTS.filter(b=>b.vehicleId===v.id).sort((a,b)=>b.testDate.localeCompare(a.testDate));
    const maint=MAINTENANCE.filter(m=>m.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
    const svcs=SERVICE_RECORDS.filter(s=>s.vehicleId===v.id).sort((a,b)=>b.serviceDate.localeCompare(a.serviceDate));
    if(brakes[0]){const d=new Date(brakes[0].testDate);d.setDate(d.getDate()+42);events.push({date:d.toISOString().split('T')[0],label:`Truck #${esc(v.truckNumber)} brake due`,type:'brake'});}
    if(maint[0]) events.push({date:maint[0].nextInspectionDate,label:`Truck #${esc(v.truckNumber)} inspection`,type:'maint'});
    // FIX: use 60-day interval and fall back to maintenance date if no service_records
    const svcRefDate=svcs[0]?.serviceDate||maint[0]?.serviceDate||null;
    if(svcRefDate){const d=new Date(svcRefDate);d.setDate(d.getDate()+60);events.push({date:d.toISOString().split('T')[0],label:`Truck #${esc(v.truckNumber)} service due`,type:'svc'});}
  });
  const monthName=calendarMonth.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  let html=`<div class="card" style="margin-bottom:20px"><div class="card-body">
    <div class="cal-header"><button class="btn btn-ghost btn-sm" onclick="calPrev()">← Prev</button><div class="cal-month-title">${monthName}</div><button class="btn btn-ghost btn-sm" onclick="calNext()">Next →</button></div>
    <div class="cal-grid">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="cal-day-header">${d}</div>`).join('')}${Array(firstDay).fill('<div></div>').join('')}`;
  for(let d=1;d<=daysInMonth;d++){
    const dateStr=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayEvents=events.filter(e=>e.date===dateStr),isToday=dateStr===todayStr;
    html+=`<div class="cal-day ${isToday?'today':''} ${dayEvents.length?'has-events':''}"><div class="cal-day-num">${d}</div>${dayEvents.map(e=>`<div class="cal-event cal-event-${e.type}" title="${e.label}">${e.label.split(' ').slice(0,2).join(' ')}</div>`).join('')}</div>`;
  }
  html+=`</div></div></div><div class="card"><div class="card-header">📋 Upcoming Events</div><div class="card-body">`;
  const upcoming=events.filter(e=>e.date>=todayStr).sort((a,b)=>a.date.localeCompare(b.date));
  if(upcoming.length===0) html+=`<div class="empty">No upcoming events</div>`;
  upcoming.forEach(e=>{const d=daysBetween(todayStr,e.date);html+=`<div class="history-item"><span>${e.label}</span><div style="display:flex;gap:8px;align-items:center"><span class="text-sm">${fmtDate(e.date)}</span><span class="badge ${d<=7?'badge-red':d<=14?'badge-yellow':'badge-blue'}">${d===0?'Today':d+'d'}</span></div></div>`;});
  html+=`</div></div>`;
  return html;
}
function calPrev(){calendarMonth.setMonth(calendarMonth.getMonth()-1);render();}
function calNext(){calendarMonth.setMonth(calendarMonth.getMonth()+1);render();}

// ═══════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════
function renderReports(){
  const statuses=VEHICLES.map(v=>({v,s:getVehicleStatus(v.id)}));
  const roadworthy=statuses.filter(x=>!x.s.critical&&!x.s.tyreOverdue).length,pending=VEHICLES.length-roadworthy;
  const brakePass=BRAKE_TESTS.filter(b=>b.result==='pass').length,brakeFail=BRAKE_TESTS.filter(b=>b.result==='fail').length;
  const dotPass=DOT_INSPECTIONS.filter(d=>d.result==='pass').length,dotViol=DOT_INSPECTIONS.filter(d=>d.result==='violation').length,dotOOS=DOT_INSPECTIONS.filter(d=>d.result==='oos').length;
  const maxBar=Math.max(brakePass,brakeFail,1);
  // ── DOT monthly stats ──────────────────────────────────
  const _rNow=new Date();
  const _MO=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const _MOF=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const _dotMS=(y,m)=>{const pfx=`${y}-${String(m+1).padStart(2,'0')}`;const inM=DOT_INSPECTIONS.filter(d=>d.inspectionDate&&d.inspectionDate.startsWith(pfx));const tot=inM.length,cln=inM.filter(d=>d.result==='pass').length;return{total:tot,clean:cln,issues:tot-cln,pct:tot>0?Math.round(cln/tot*100):null};};
  const _cDot=_dotMS(_rNow.getFullYear(),_rNow.getMonth());
  const _cCol=_cDot.pct===null?'var(--text3)':_cDot.pct>70?'var(--success)':_cDot.pct>50?'var(--warning)':'var(--danger)';
  const _dotHist=[];for(let _i=1;_i<=12;_i++){let _y=_rNow.getFullYear(),_m=_rNow.getMonth()-_i;while(_m<0){_m+=12;_y--;}_dotHist.push({year:_y,month:_m,..._dotMS(_y,_m)});}
  const _pCol=p=>p>70?'var(--success)':p>50?'var(--warning)':'var(--danger)';
  const _pBg=p=>p>70?'var(--success-bg)':p>50?'var(--warning-bg)':'var(--danger-bg)';
  const _dotRowsHtml=_dotHist.map((r,i)=>{
    const pc=r.pct,pcc=pc!==null?_pCol(pc):'var(--text3)',pcb=pc!==null?_pBg(pc):'transparent';
    const stripe=i%2===1?'background:var(--row-stripe)':'';
    const issuesTd=r.issues>0?`<span style="font-size:13px;font-weight:700;color:var(--danger)">${r.issues}</span>`:`<span style="color:var(--text3);font-size:13px">—</span>`;
    const pctTd=pc!==null?`<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px"><div style="width:56px;height:5px;background:var(--surface3);border-radius:3px;overflow:hidden;flex-shrink:0"><div style="height:100%;width:${pc}%;background:${pcc};border-radius:3px"></div></div><span style="display:inline-block;min-width:44px;text-align:center;background:${pcb};color:${pcc};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">${pc}%</span></div>`:`<span style="color:var(--text3)">—</span>`;
    return `<tr style="${stripe}"><td style="padding:10px 16px;font-size:13px;font-weight:600">${_MO[r.month]} ${r.year}</td><td style="padding:10px 16px;text-align:center;font-size:13px;color:var(--text2)">${r.total}</td><td style="padding:10px 16px;text-align:center"><span style="font-size:13px;font-weight:700;color:var(--success)">${r.clean}</span></td><td style="padding:10px 16px;text-align:center">${issuesTd}</td><td style="padding:10px 16px;text-align:right">${pctTd}</td></tr>`;
  }).join('');
  const _dotCardHtml=`<div class="card" style="grid-column:1/-1">
    <div class="card-header" style="display:flex;align-items:center;justify-content:space-between"><div style="display:flex;align-items:center;gap:10px"><div style="width:30px;height:30px;border-radius:8px;background:rgba(147,51,234,.15);display:flex;align-items:center;justify-content:center;font-size:15px">📋</div><div><div style="font-size:13px;font-weight:700">DOT Inspection Results</div><div style="font-size:11px;color:var(--text3);font-weight:400;margin-top:1px">Clean vs Issues · Monthly breakdown</div></div></div><span style="background:rgba(147,51,234,.12);color:#a855f7;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700">${DOT_INSPECTIONS.length} total</span></div>
    <div style="padding:20px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--text3);margin-bottom:16px">📅 ${_MOF[_rNow.getMonth()]} ${_rNow.getFullYear()} — Current Month</div>
      <div style="display:flex;align-items:center;gap:28px">
        <div style="text-align:center;flex-shrink:0;min-width:90px">
          <div style="font-size:52px;font-weight:800;line-height:1;color:${_cCol};letter-spacing:-2px">${_cDot.pct!==null?_cDot.pct+'%':'—'}</div>
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);margin-top:5px">Clean Rate</div>
        </div>
        <div style="flex:1">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
            <div style="background:var(--success-bg);border:1px solid rgba(120,220,119,.15);border-radius:11px;padding:12px 14px"><div style="font-size:26px;font-weight:800;color:var(--success);line-height:1">${_cDot.clean}</div><div style="font-size:11px;color:var(--text2);margin-top:4px">✅ Clean (Pass)</div></div>
            <div style="background:var(--danger-bg);border:1px solid rgba(255,68,68,.15);border-radius:11px;padding:12px 14px"><div style="font-size:26px;font-weight:800;color:var(--danger);line-height:1">${_cDot.issues}</div><div style="font-size:11px;color:var(--text2);margin-top:4px">⚠ Violation (Viol+OOS)</div></div>
            <div style="background:var(--surface3);border:1px solid var(--border);border-radius:11px;padding:12px 14px"><div style="font-size:26px;font-weight:800;line-height:1">${_cDot.total}</div><div style="font-size:11px;color:var(--text2);margin-top:4px">📋 Total</div></div>
          </div>
          <div style="height:8px;background:var(--surface3);border-radius:4px;overflow:hidden">${_cDot.total>0?`<div style="height:100%;width:${_cDot.pct}%;background:${_cCol};border-radius:4px"></div>`:''}</div>
          <div style="display:flex;justify-content:space-between;margin-top:5px"><div style="font-size:10px;color:var(--text3)">${_cDot.clean} clean passes</div><div style="font-size:10px;color:var(--text3)">${_cDot.issues} violations / OOS</div></div>
        </div>
      </div>
      ${_cDot.total===0?'<div style="font-size:12px;color:var(--text3);margin-top:12px;text-align:center">No inspections recorded this month yet</div>':''}
    </div>
    <div>
      <div style="padding:14px 20px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--text3)">📊 Last 12 Months</div>
      <div class="table-wrap"><table><thead><tr><th>Month</th><th style="text-align:center">Total</th><th style="text-align:center">✅ Clean</th><th style="text-align:center">⚠ Violation</th><th style="text-align:right">% Clean</th></tr></thead><tbody>${_dotRowsHtml||`<tr><td colspan="5" class="empty">No DOT inspection data yet</td></tr>`}</tbody></table></div>
    </div>
  </div>`;
  let html=`<div class="stats-grid" style="margin-bottom:24px">
    <div class="stat-card"><div class="stat-icon" style="background:#dbeafe">🚛</div><div><div class="stat-num">${VEHICLES.length}</div><div class="stat-label">Vehicles</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#dcfce7">🔧</div><div><div class="stat-num">${MAINTENANCE.length}</div><div class="stat-label">Service records</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#fef3c7">🛑</div><div><div class="stat-num">${BRAKE_TESTS.length}</div><div class="stat-label">Brake tests</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:#f3e8ff">📋</div><div><div class="stat-num">${DOT_INSPECTIONS.length}</div><div class="stat-label">DOT inspections</div></div></div>
  </div><div class="two-col">
  <div class="card"><div class="card-header">Fleet Roadworthiness</div><div class="card-body"><div style="display:flex;gap:16px;align-items:flex-end"><div style="flex:1"><div class="chart-bar-wrap">
    <div class="chart-bar-col"><div class="chart-bar-val" style="color:var(--success)">${roadworthy}</div><div class="chart-bar" style="background:var(--success);height:${VEHICLES.length?(roadworthy/VEHICLES.length)*100:0}%"></div><div class="chart-bar-label">Roadworthy</div></div>
    <div class="chart-bar-col"><div class="chart-bar-val" style="color:var(--danger)">${pending}</div><div class="chart-bar" style="background:var(--danger);height:${VEHICLES.length?(pending/VEHICLES.length)*100:0}%"></div><div class="chart-bar-label">Pending</div></div>
  </div></div><div style="font-size:13px;color:var(--text2);min-width:120px"><div><span style="color:var(--success);font-weight:700">${VEHICLES.length?Math.round(roadworthy/VEHICLES.length*100):0}%</span> roadworthy</div><div style="margin-top:4px">${VEHICLES.length} total vehicles</div></div></div></div></div>
  <div class="card"><div class="card-header">Brake Test Results</div><div class="card-body"><div class="chart-bar-wrap">
    <div class="chart-bar-col"><div class="chart-bar-val" style="color:var(--success)">${brakePass}</div><div class="chart-bar" style="background:var(--success);height:${Math.round(brakePass/maxBar*100)}%"></div><div class="chart-bar-label">Pass</div></div>
    <div class="chart-bar-col"><div class="chart-bar-val" style="color:var(--danger)">${brakeFail}</div><div class="chart-bar" style="background:var(--danger);height:${Math.round(brakeFail/maxBar*100)}%"></div><div class="chart-bar-label">Fail</div></div>
  </div><div class="text-sm" style="margin-top:8px">Pass rate: <strong>${BRAKE_TESTS.length?Math.round(brakePass/BRAKE_TESTS.length*100):0}%</strong></div></div></div>
  ${_dotCardHtml}
  <div class="card" style="grid-column:1/-1"><div class="card-header">Per-Vehicle Summary</div><div class="card-body" style="padding:0"><div class="table-wrap"><table>
    <thead><tr><th>Truck</th><th>Last brake</th><th>Last tyre</th><th>Last service</th><th>Status</th></tr></thead>
    <tbody>${VEHICLES.length===0?`<tr><td colspan="5" class="empty">No vehicles</td></tr>`:VEHICLES.map(v=>{const s=getVehicleStatus(v.id);return`<tr style="cursor:pointer" onclick="navigate('vehicle','${v.id}')"><td><strong>Truck #${esc(v.truckNumber)}</strong></td><td>${s.lastBrake?fmtDate(s.lastBrake.testDate):'—'}</td><td>${s.lastTyre?fmtDate(s.lastTyre.photoDate):'—'}</td><td>${s.lastService?fmtDate(s.lastService.serviceDate):s.maint?fmtDate(s.maint.serviceDate):'—'}</td><td><span class="badge ${s.critical?'badge-red':s.warning?'badge-yellow':'badge-green'}">${s.critical?'Critical':s.warning?'Warning':'OK'}</span></td></tr>`;}).join('')}</tbody>
  </table></div></div></div>
  </div>`;
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
