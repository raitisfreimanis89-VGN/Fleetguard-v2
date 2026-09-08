// ═══════════════════════════════════════════════════════════════
// REMINDERS MODULE — Admin only
// Loaded after app.js. Uses globals: sb, isAdmin, VEHICLES,
// DRIVERS, esc, fmtDate, navigate, currentRole
// ═══════════════════════════════════════════════════════════════

let REM_SCHEDULES = [], SMS_NOTIFS = [], SMS_REPLIES = [], ESCALATIONS = [], DRIVER_PHONES = [];
let remTab = 'overview';

// ── Data loader ───────────────────────────────────────────────
async function loadReminders() {
  if (!sb || !isAdmin()) return;
  const [rs, sn, sr, el, dp] = await Promise.all([
    sb.from('reminder_schedules').select('id,vehicle_id,reminder_type,interval_days,warning_days_before,escalation_hours,enabled').order('reminder_type'),
    sb.from('sms_notifications').select('id,vehicle_id,driver_id,reminder_type,phone_number,message_body,status,sent_at,acknowledged_at,error_message,created_at').order('created_at', {ascending:false}).limit(200),
    sb.from('sms_replies').select('id,from_number,body,driver_id,notification_id,received_at').order('received_at', {ascending:false}).limit(100),
    sb.from('escalation_log').select('id,notification_id,escalated_to,escalation_type,sent_at,notes').order('sent_at', {ascending:false}).limit(50),
    sb.from('driver_phones').select('driver_id,phone_number,verified').order('driver_id'),
  ]);
  if (!rs.error && rs.data) REM_SCHEDULES = rs.data;
  if (!sn.error && sn.data) SMS_NOTIFS    = sn.data;
  if (!sr.error && sr.data) SMS_REPLIES   = sr.data;
  if (!el.error && el.data) ESCALATIONS   = el.data;
  if (!dp.error && dp.data) DRIVER_PHONES = dp.data;
}

// ── Master render ─────────────────────────────────────────────
function renderReminders() {
  if (!isAdmin()) return '<div class="empty">Access restricted to administrators.</div>';

  const pendingReplies = SMS_REPLIES.filter(r => {
    const notif = SMS_NOTIFS.find(n => n.id === r.notification_id);
    return !notif || notif.status !== 'acknowledged';
  }).length;

  const _sv = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const IC = {
    overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    history:  '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    replies:  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="m8 10 2.5 2.5L15 8"/>',
    schedule: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  };
  // remSwitchTab takes the button as its second argument and reads it to move
  // the active class, so the handler shape here is load-bearing.
  const tab = (key, icon, label, badge) =>
    '<button class="v2-subtab' + (remTab === key ? ' is-active' : '') + '" type="button"' +
    (remTab === key ? ' aria-current="page"' : '') +
    ' onclick="remSwitchTab(\'' + key + '\',this)">' + _sv(icon) + label +
    (badge ? '<span class="v2-subtab-badge">' + badge + '</span>' : '') + '</button>';

  return '<div class="v2-region" id="view-reminders">' +
    '<div class="v2-page-head"><h1>Reminders</h1>' +
    '<p>Automated service reminders, the numbers they go to, and the schedules that trigger them.</p></div>' +
    '<nav class="v2-subtabs" aria-label="Reminders sections">' +
      tab('overview', IC.overview, 'Overview') +
      tab('history',  IC.history,  'SMS History') +
      tab('replies',  IC.replies,  'Driver Replies', pendingReplies > 0 ? pendingReplies : 0) +
      tab('schedule', IC.schedule, 'Schedule Config') +
    '</nav>' +
    '<div id="rem-tab-content">' + remRenderTab() + '</div>' +
  '</div>';
}

// Takes the clicked button so the active state does not depend on matching the
// tab key against the label text. The old text match worked only because every
// label happened to contain its key — "SMS History" contains "history" — which
// a rename would have broken silently. The text match is kept as a fallback for
// any caller that does not pass the button.
function remSwitchTab(tab, btn) {
  remTab = tab;
  const el = document.getElementById('rem-tab-content');
  if (el) el.innerHTML = remRenderTab();
  document.querySelectorAll('.v2-subtab').forEach(b => {
    const on = btn ? b === btn : b.textContent.toLowerCase().includes(tab);
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

function remRenderTab() {
  if (remTab === 'overview')  return remRenderOverview();
  if (remTab === 'history')   return remRenderHistory();
  if (remTab === 'replies')   return remRenderReplies();
  if (remTab === 'schedule')  return remRenderSchedule();
  return '';
}

// ── OVERVIEW ──────────────────────────────────────────────────
function remRenderOverview() {
  const overdue  = SMS_NOTIFS.filter(n => !['acknowledged','completed','failed'].includes(n.status));
  const acked    = SMS_NOTIFS.filter(n => n.status === 'acknowledged' || n.status === 'completed');
  const replies  = SMS_REPLIES.length;
  const sent30d  = SMS_NOTIFS.filter(n => {
    const d = new Date(n.created_at);
    return Date.now() - d.getTime() < 30 * 86400000;
  }).length;

  // Compute per-vehicle overdue state from local data
  const critAlerts = [], warnAlerts = [];
  VEHICLES.forEach(v => {
    const s = getVehicleStatus(v.id);
    const driver = DRIVERS.find(d => d.id === v.assignedDriverId);
    if (!driver) return;
    const phone = DRIVER_PHONES.find(p => p.driver_id === driver.id);
    const phoneStr = phone ? maskPhone(phone.phone_number) : '— no phone';

    // intervals come from getVehicleStatus so a truck on a custom schedule shows its own numbers
    if (s.brakeOverdue)   critAlerts.push({ v, driver, phoneStr, label:'Brake Inspection',  days: s.brakeDays,   interval:s.brakeInterval,   icon:'brake', type:'brake_service'  });
    if (s.serviceOverdue) critAlerts.push({ v, driver, phoneStr, label:'Periodic Inspection', days: s.serviceDays, interval:s.serviceInterval, icon:'yard',  type:'dot_inspection' });
    if (s.brakeDueSoon)   warnAlerts.push({ v, driver, phoneStr, label:'Brake Inspection',  days: s.brakeDays,   interval:s.brakeInterval,   icon:'brake', type:'brake_service'  });
    if (s.serviceDueSoon) warnAlerts.push({ v, driver, phoneStr, label:'PM Service',     days: s.serviceDays, interval:s.serviceInterval, icon:'yard',  type:'pm_service'     });
  });

  const recentNotifs = SMS_NOTIFS.slice(0, 6);
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const IC = {
    alert:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
    sms:  '<path d="M4 4h16v12H7l-3 3Z"/><path d="M8 9h8M8 12h5"/>',
    brake:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M21 12h-3M6 12H3"/>',
    yard: '<path d="M9 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    hist: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
  };
  const metric = (tone, icon, val, label, sub) =>
    '<article class="v2-metric ' + tone + '"><div class="v2-metric-head">' +
    '<span class="v2-metric-ic">' + _sv(icon) + '</span>' +
    '<span class="v2-metric-label">' + label + '</span></div>' +
    '<span class="v2-metric-val">' + val + '</span>' +
    (sub ? '<span class="v2-metric-sub">' + sub + '</span>' : '') + '</article>';

  // The whole row is the click target, exactly as before, and the eight
  // arguments to remOpenSendModal are unchanged — this is the SMS send path.
  const alertRow = (a, tone) => {
    const isOver = a.days > a.interval;
    const daysOver = a.days - a.interval;
    const daysLeft = a.interval - a.days;
    const lastNotif = SMS_NOTIFS.find(n => n.vehicle_id === a.v.id && n.reminder_type === a.type);
    const note = lastNotif
      ? (lastNotif.status === 'acknowledged' ? '<span class="v2-cell-caught">Driver confirmed</span>'
        : lastNotif.status === 'sent'        ? '<span class="v2-rem-await">SMS sent &mdash; awaiting reply</span>'
        : '<span class="v2-cell-dim">No SMS sent yet</span>')
      : '<span class="v2-cell-dim">No SMS sent yet</span>';
    return '<div class="v2-stream-row ' + tone + '" style="cursor:pointer" title="Send a reminder for this truck"' +
      ' onclick="remOpenSendModal(\'' + esc(a.v.truckNumber) + '\',\'' + esc(a.v.id) + '\',\'' + esc(a.driver.id) +
      '\',\'' + esc(a.type) + '\',\'' + esc(a.label) + '\',' + isOver + ',' + daysOver + ',' + daysLeft + ')">' +
      '<span class="v2-stream-ic">' + _sv(IC[a.icon]) + '</span>' +
      '<span class="v2-stream-main">' +
        '<span class="v2-stream-label">Truck #' + esc(a.v.truckNumber) + ' &middot; ' + esc(a.label) + '</span>' +
        '<span class="v2-stream-type">' + esc(a.driver.name) + ' &middot; ' + esc(a.phoneStr) + ' &middot; ' + note + '</span>' +
      '</span>' +
      '<span class="v2-countdown' + (isOver ? ' is-urgent' : ' is-soon') + '">' +
        (isOver ? '+' + daysOver + 'd' : daysLeft + 'd left') + '</span>' +
    '</div>';
  };

  let html = '<div class="v2-metrics">' +
    metric('v2-accent-red',   IC.alert, critAlerts.length, 'Overdue now',    'Action required today') +
    metric('v2-accent-amber', IC.clock, warnAlerts.length, 'Due this week',  'Inside the warning window') +
    metric('v2-accent-green', IC.chat,  replies,           'Driver replies', 'Inbound over all time') +
    metric('v2-accent-cyan',  IC.sms,   sent30d,           'SMS sent (30d)', 'Outbound reminders') +
  '</div>';

  html += '<div class="v2-rem-grid"><div class="v2-rep-col">';
  if (critAlerts.length) {
    html += '<section class="v2-table-card" aria-label="Overdue">' +
      '<div class="v2-panel-head v2-accent-red"><span class="v2-panel-ic">' + _sv(IC.alert) + '</span>' +
      '<h2>Overdue &mdash; action required</h2><span class="v2-panel-tag">' + critAlerts.length + '</span></div>' +
      '<div class="v2-stream">' + critAlerts.map(a => alertRow(a, 'v2-accent-red')).join('') + '</div></section>';
  }
  if (warnAlerts.length) {
    html += '<section class="v2-table-card" aria-label="Due soon">' +
      '<div class="v2-panel-head v2-accent-amber"><span class="v2-panel-ic">' + _sv(IC.clock) + '</span>' +
      '<h2>Due soon</h2><span class="v2-panel-tag">' + warnAlerts.length + '</span></div>' +
      '<div class="v2-stream">' + warnAlerts.map(a => alertRow(a, 'v2-accent-amber')).join('') + '</div></section>';
  }
  if (!critAlerts.length && !warnAlerts.length) {
    html += '<section class="v2-table-card"><div style="padding:var(--v2-s10);text-align:center;color:var(--v2-ink-3)">' +
      'All vehicles are on schedule &mdash; no reminders due.</div></section>';
  }
  html += '</div><div class="v2-rep-col">';

  // Recent SMS activity
  html += '<section class="v2-table-card" aria-label="Recent SMS activity">' +
    '<div class="v2-panel-head v2-accent-cyan"><span class="v2-panel-ic">' + _sv(IC.sms) + '</span>' +
    '<h2>Recent SMS activity</h2><span class="v2-panel-tag">Live</span></div>';
  if (!recentNotifs.length) {
    html += '<div style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No SMS sent yet</div>';
  } else {
    html += '<div class="v2-phone-list">' + recentNotifs.map(n => remSmsRow(n)).join('') + '</div>';
  }
  html += '</section>';

  // Manual trigger
  html += '<section class="v2-table-card" aria-label="Manual trigger">' +
    '<div class="v2-panel-head v2-accent-primary"><span class="v2-panel-ic">' + _sv(IC.send) + '</span>' +
    '<h2>Manual trigger</h2></div>' +
    '<div style="padding:var(--v2-s5)">' +
      '<p class="v2-rem-hint">Force the daily reminder scan right now. It normally fires automatically when the Google Voice service starts each morning.</p>' +
      '<div style="display:flex;gap:var(--v2-s3);flex-wrap:wrap">' +
        '<button class="v2-btn-primary" type="button" onclick="remTriggerScan(this)">' + _sv(IC.send,'2') + 'Run scan now</button>' +
        '<button class="v2-btn-ghost" type="button" onclick="remSwitchTab(\'history\')">' + _sv(IC.hist,'1.8') + 'View log</button>' +
      '</div>' +
      // remTriggerScan writes its result here and flips display, so the id and
      // the starting display:none are both load-bearing.
      '<div id="rem-trigger-result" style="display:none" class="rem-trigger-result"></div>' +
    '</div></section>';

  html += '</div></div>';
  return html;
}

function remStatCard(icon, color, bg, num, label) {
  return `
<div class="stat-card">
  <div class="stat-icon" style="background:${bg}">
    <span class="nav-icon" style="font-family:'Material Symbols Outlined';font-weight:300;line-height:1;color:${color};font-size:22px">${icon}</span>
  </div>
  <div>
    <div class="stat-num" style="color:${color}">${num}</div>
    <div class="stat-label">${label}</div>
  </div>
</div>`;
}

function remAlertRow(a, cls) {
  const overdue = a.days > a.interval;
  const daysOver = a.days - a.interval;
  const daysLeft = a.interval - a.days;
  const daysLabel = overdue ? `+${daysOver}d OD` : `${daysLeft}d left`;
  const lastNotif = SMS_NOTIFS.find(n => n.vehicle_id === a.v.id && n.reminder_type === a.type);
  const notifNote = lastNotif
    ? (lastNotif.status === 'acknowledged' ? '<span style="color:var(--success)">Driver confirmed ✓</span>'
      : lastNotif.status === 'sent'        ? '<span style="color:var(--warning)">SMS sent — awaiting reply</span>'
      : 'No SMS sent yet')
    : 'No SMS sent yet';

  return `
<div class="rem-alert ${cls}" onclick="remOpenSendModal('${esc(a.v.truckNumber)}','${esc(a.v.id)}','${esc(a.driver.id)}','${esc(a.type)}','${esc(a.label)}',${overdue},${daysOver},${daysLeft})">
  <div class="rem-alert-icon">
    <span class="nav-icon" style="font-family:'Material Symbols Outlined';font-weight:300;line-height:1">${a.icon}</span>
  </div>
  <div class="rem-alert-meta">
    <div class="rem-alert-truck">Truck #${esc(a.v.truckNumber)} — ${esc(a.label)}</div>
    <div class="rem-alert-sub">👤 ${esc(a.driver.name)} &nbsp;·&nbsp; 📱 ${esc(a.phoneStr)}</div>
    <div class="rem-alert-note">${notifNote}</div>
  </div>
  <div class="rem-days ${cls}">${daysLabel}</div>
</div>`;
}

function remSmsRow(n) {
  const v      = VEHICLES.find(x => x.id === n.vehicle_id);
  const driver = DRIVERS.find(d => d.id === n.driver_id);
  const initials = driver ? driver.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() : '??';
  const toneMap  = { pending:'is-none', sent:'is-warn', failed:'is-crit', acknowledged:'is-warn', completed:'is-ok' };
  const labelMap = { pending:'Pending', sent:'Sent', failed:'Failed', acknowledged:'Confirmed', completed:'Done' };
  const ago = remTimeAgo(n.created_at);
  return '<div class="v2-phone-item">' +
    '<span class="v2-drv-avatar">' + esc(initials) + '</span>' +
    '<span class="v2-phone-who" style="flex:1;min-width:0">' +
      '<span class="v2-phone-who-name">' + esc(driver ? driver.name : '—') +
        ' <span class="v2-cell-dim">#' + esc(v && v.truckNumber != null ? v.truckNumber : '?') + '</span></span>' +
      '<span class="v2-rem-msg">' + esc(n.message_body) + '</span>' +
    '</span>' +
    '<span class="v2-cell-dim" style="white-space:nowrap">' + ago + '</span>' +
    '<span class="v2-phone-badge ' + (toneMap[n.status] || 'is-none') + '">' + (labelMap[n.status] || n.status) + '</span>' +
  '</div>';
}

// ── HISTORY ───────────────────────────────────────────────────
function remRenderHistory(filter = 'all') {
  const rows = SMS_NOTIFS.filter(n => filter === 'all' || n.status === filter);
  const typeLabel = { dot_inspection:'Periodic Inspection', brake_service:'Brake Inspection', pm_service:'PM Service' };
  const toneMap  = { pending:'is-none', sent:'is-warn', failed:'is-crit', acknowledged:'is-warn', completed:'is-ok' };
  const labelMap = { pending:'Pending', sent:'Sent', failed:'Failed', acknowledged:'Confirmed', completed:'Done' };
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const IC = {
    hist:'<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    down:'<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/>',
    chev:'<path d="m6 9 6 6 6-6"/>',
  };
  const opts = [['all','All statuses'],['sent','Sent'],['acknowledged','Confirmed (OK)'],['completed','Done'],['failed','Failed'],['pending','Pending']]
    .map(o => '<option value="' + o[0] + '"' + (filter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('');

  let html = '<section class="v2-table-card" aria-label="SMS notification log">' +
    '<div class="v2-panel-head v2-accent-cyan"><span class="v2-panel-ic">' + _sv(IC.hist) + '</span>' +
    '<h2>SMS notification log</h2>' +
    '<span class="v2-rep-actions">' +
      '<span class="v2-rep-select"><select onchange="remFilterHistory(this.value)" aria-label="Filter by status">' + opts + '</select>' + _sv(IC.chev,'1.8') + '</span>' +
      '<button class="v2-rep-btn" type="button" onclick="remExportCSV()">' + _sv(IC.down,'1.8') + 'CSV</button>' +
    '</span></div>' +
    '<div class="v2-table-wrap"><table class="v2-table v2-drv-table"><thead><tr>' +
    '<th>Date / time</th><th>Truck</th><th>Driver</th><th>Type</th><th>Phone</th><th>Status</th><th>Replied</th>' +
    '</tr></thead><tbody>';
  if (!rows.length) {
    html += '<tr><td colspan="7" style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No records match</td></tr>';
  }
  rows.forEach(n => {
    const v      = VEHICLES.find(x => x.id === n.vehicle_id);
    const driver = DRIVERS.find(d => d.id === n.driver_id);
    const replied = SMS_REPLIES.some(r => r.notification_id === n.id);
    html += '<tr>' +
      '<td class="v2-cell-num v2-cell-dim">' + fmtDate(n.created_at) + '</td>' +
      '<td class="v2-cell-strong">' + esc(v && v.truckNumber != null ? v.truckNumber : '—') + '</td>' +
      '<td>' + esc(driver ? driver.name : '—') + '</td>' +
      '<td><span class="v2-override-chip">' + (typeLabel[n.reminder_type] || n.reminder_type) + '</span></td>' +
      '<td class="v2-phone-masked">' + esc(maskPhone(n.phone_number)) + '</td>' +
      '<td><span class="v2-phone-badge ' + (toneMap[n.status] || 'is-none') + '">' + (labelMap[n.status] || n.status) + '</span></td>' +
      '<td>' + (replied ? '<span class="v2-cell-caught">Yes</span>' : '<span class="v2-cell-dim">&mdash;</span>') + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div></section>';
  return html;
}

function remFilterHistory(val) {
  const el = document.getElementById('rem-tab-content');
  if (el) el.innerHTML = remRenderHistory(val);
}

// ── REPLIES ───────────────────────────────────────────────────
function remRenderReplies() {
  const activeEscalations = ESCALATIONS.filter(e => e.escalated_to !== 'pending');
  const _sv=(d,w)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">'+d+'</svg>';
  const IC = {
    chat:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="m8 10 2.5 2.5L15 8"/>',
    esc: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  };
  const TYPE = { dot_inspection:'Periodic', brake_service:'Brakes', pm_service:'PM' };

  let html = '<div class="v2-rem-grid">';

  html += '<section class="v2-table-card" aria-label="Inbound replies">' +
    '<div class="v2-panel-head v2-accent-green"><span class="v2-panel-ic">' + _sv(IC.chat) + '</span>' +
    '<h2>Inbound replies</h2>' +
    (SMS_REPLIES.length ? '<span class="v2-panel-tag">' + SMS_REPLIES.length + '</span>' : '') + '</div>';
  if (!SMS_REPLIES.length) {
    html += '<div style="padding:var(--v2-s8);text-align:center;color:var(--v2-ink-3)">No driver replies yet</div>';
  } else {
    html += '<div class="v2-phone-list">';
    SMS_REPLIES.slice(0, 15).forEach(r => {
      const driver = DRIVERS.find(d => d.id === r.driver_id);
      const notif  = SMS_NOTIFS.find(n => n.id === r.notification_id);
      const acked  = notif && notif.status === 'acknowledged';
      const initials = (driver ? driver.name : '??').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      html += '<div class="v2-phone-item">' +
        '<span class="v2-drv-avatar">' + esc(initials) + '</span>' +
        '<span class="v2-phone-who" style="flex:1;min-width:0">' +
          '<span class="v2-phone-who-name">' + esc(driver ? driver.name : r.from_number) + '</span>' +
          '<span class="v2-rem-msg">&ldquo;' + esc(r.body) + '&rdquo;</span>' +
          (notif ? '<span class="v2-phone-who-truck">' + (TYPE[notif.reminder_type] || '') + ' reminder</span>' : '') +
        '</span>' +
        '<span class="v2-cell-dim" style="white-space:nowrap">' + remTimeAgo(r.received_at) + '</span>' +
        '<span class="v2-phone-badge ' + (acked ? 'is-ok' : 'is-warn') + '">' + (acked ? 'ACK' : 'Not acked') + '</span>' +
      '</div>';
    });
    html += '</div>';
  }
  html += '</section>';

  html += '<section class="v2-table-card" aria-label="Escalation log">' +
    '<div class="v2-panel-head v2-accent-red"><span class="v2-panel-ic">' + _sv(IC.esc) + '</span>' +
    '<h2>Escalation log</h2>' +
    (activeEscalations.length ? '<span class="v2-panel-tag">' + activeEscalations.length + '</span>' : '') + '</div>';
  if (!activeEscalations.length) {
    html += '<div class="v2-override-empty">No escalations.</div>';
  } else {
    html += '<div class="v2-override-list">';
    activeEscalations.forEach(e => {
      const notif  = SMS_NOTIFS.find(n => n.id === e.notification_id);
      const v      = VEHICLES.find(x => x.id === (notif && notif.vehicle_id));
      const driver = DRIVERS.find(d => d.id === (notif && notif.driver_id));
      html += '<div class="v2-override">' +
        '<span class="v2-override-main">' +
          '<span class="v2-override-head">' +
            '<span class="v2-override-truck">Truck #' + esc(v && v.truckNumber != null ? v.truckNumber : '?') + '</span>' +
            '<span class="v2-override-chip">' + esc(driver ? driver.name : '?') + '</span>' +
          '</span>' +
          '<span class="v2-override-params">' +
            (notif ? esc(notif.reminder_type.replace(/_/g,' ')) + ' &mdash; no reply' : '') +
            '<span class="v2-override-sep">&middot;</span>To <b>' + esc(e.escalated_to) + '</b>' +
            '<span class="v2-override-sep">&middot;</span>' + fmtDate(e.sent_at) +
          '</span>' +
        '</span></div>';
    });
    html += '</div>';
  }
  html += '</section></div>';
  return html;
}

// ── SCHEDULE CONFIG ───────────────────────────────────────────
function remRenderSchedule() {
  const types = ['dot_inspection','brake_service','tyre_check']; // pm_service retired 2026-07-01 (not tracked)
  const labels = { dot_inspection:'Periodic Inspection', brake_service:'Brake Inspection', pm_service:'PM Service', tyre_check:'Tyre Check' };
  const subtitles = { dot_inspection:'Yard inspection', brake_service:'Safety critical', pm_service:'Preventive maint.', tyre_check:'Tread photos' };
  const tone = { dot_inspection:'v2-accent-blue', brake_service:'v2-accent-red', tyre_check:'v2-accent-amber' };

  const _sv = (d,w) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="'+(w||'1.9')+'" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const IC = {
    tune:  '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    yard:  '<path d="M9 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="m9 13 2 2 4-4"/>',
    brake: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M21 12h-3M6 12H3"/>',
    tyre:  '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2Z"/>',
    save:  '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  };
  const typeIcon = { dot_inspection:IC.yard, brake_service:IC.brake, tyre_check:IC.tyre };
  const overrides = REM_SCHEDULES.filter(s => s.vehicle_id !== null);

  // Every driver, not the first ten. Production sliced to 10 of 46 with nothing
  // saying so, which reads as "these are the numbers on file" when it is not.
  // .v2-phone-list is a plain column, so the panel simply grows.
  const withPhone = DRIVERS.filter(d => DRIVER_PHONES.some(p => p.driver_id === d.id)).length;

  let html = '<section class="v2-rem-grid" aria-label="Schedule configuration">';

  // ── Global defaults ────────────────────────────────────────────────────────
  html += '<article class="v2-table-card">' +
    '<div class="v2-panel-head v2-accent-amber"><span class="v2-panel-ic">' + _sv(IC.tune) + '</span>' +
    '<h2>Global defaults</h2><span class="v2-panel-tag">Applies to all vehicles</span></div>' +
    '<div class="v2-table-wrap"><table class="v2-sched-table"><thead><tr>' +
    '<th>Service type</th><th>Interval</th><th>Warn before</th><th>Escalate after</th><th>On</th>' +
    '</tr></thead><tbody>';
  types.forEach(type => {
    const s = REM_SCHEDULES.find(r => r.vehicle_id === null && r.reminder_type === type);
    const num = (field, val, min, max, unit, aria) =>
      '<td><span class="v2-num"><input type="number" value="' + val + '" min="' + min + '" max="' + max + '"' +
      ' aria-label="' + aria + '" onchange="remSaveSchedule(null,\'' + type + '\',\'' + field + '\',+this.value)"/>' +
      '<span class="v2-num-unit">' + unit + '</span></span></td>';
    const on = s && s.enabled !== false;
    html += '<tr>' +
      '<td><span class="v2-sched-type"><span class="v2-sched-ic ' + tone[type] + '">' + _sv(typeIcon[type]) + '</span>' +
      '<span><span class="v2-sched-label">' + labels[type] + '</span>' +
      '<span class="v2-sched-sub">' + subtitles[type] + '</span></span></span></td>' +
      num('interval_days',        (s && s.interval_days) != null ? s.interval_days : 30,        1, 365, 'd', labels[type] + ' interval in days') +
      num('warning_days_before',  (s && s.warning_days_before) != null ? s.warning_days_before : 7, 1, 30,  'd', labels[type] + ' warn before, in days') +
      num('escalation_hours',     (s && s.escalation_hours) != null ? s.escalation_hours : 48,  1, 168, 'h', labels[type] + ' escalate after, in hours') +
      '<td><label class="v2-toggle"><input type="checkbox"' + (on ? ' checked' : '') +
        ' aria-label="' + labels[type] + ' reminders enabled"' +
        ' onchange="remSaveSchedule(null,\'' + type + '\',\'enabled\',this.checked)"/>' +
        '<span class="v2-toggle-track"><span class="v2-toggle-thumb"></span></span></label></td>' +
    '</tr>';
  });
  html += '</tbody></table></div>' +
    '<div class="v2-panel-foot">' +
      '<span class="v2-panel-foot-hint">Changes save as you edit; this re-saves all three.</span>' +
      '<button class="v2-btn-primary" type="button" onclick="remSaveAllSchedules()">' + _sv(IC.save,'2') + 'Save defaults</button>' +
    '</div></article>';

  // ── Driver phone numbers ───────────────────────────────────────────────────
  html += '<article class="v2-table-card">' +
    '<div class="v2-panel-head v2-accent-cyan"><span class="v2-panel-ic">' + _sv(IC.phone) + '</span>' +
    '<h2>Driver phone numbers</h2>' +
    '<span class="v2-panel-tag">' + withPhone + ' of ' + DRIVERS.length + ' on file</span></div>' +
    '<div class="v2-phone-list">';
  DRIVERS.forEach(d => {
    const phone = DRIVER_PHONES.find(p => p.driver_id === d.id);
    const v = VEHICLES.find(x => x.assignedDriverId === d.id);
    html += '<div class="v2-phone-item">' +
      '<span class="v2-phone-who"><span class="v2-phone-who-name">' + esc(d.name) + '</span>' +
      '<span class="v2-phone-who-truck">' + (v ? 'Truck #' + esc(v.truckNumber) : 'Unassigned') + '</span></span>' +
      (phone
        ? '<span class="v2-phone-masked">' + esc(maskPhone(phone.phone_number)) + '</span>' +
          '<span class="v2-phone-badge ' + (phone.verified ? 'is-ok' : 'is-warn') + '">' + (phone.verified ? 'Verified' : 'Active') + '</span>'
        : '<span class="v2-phone-unset">Not set</span>' +
          '<span class="v2-phone-badge is-crit">Missing</span>') +
    '</div>';
  });
  html += '</div></article></section>';

  // ── Per-vehicle overrides ──────────────────────────────────────────────────
  html += '<section class="v2-table-card" aria-label="Per-vehicle overrides">' +
    '<div class="v2-panel-head v2-accent-red"><span class="v2-panel-ic">' + _sv(IC.tune) + '</span>' +
    '<h2>Per-vehicle overrides</h2>' +
    '<span class="v2-panel-tag">' + (overrides.length || 'No') + ' truck' + (overrides.length === 1 ? '' : 's') + ' on custom intervals</span></div>';
  if (overrides.length === 0) {
    html += '<div class="v2-override-empty">No overrides &mdash; every vehicle is using the global defaults above.</div>';
  } else {
    html += '<div class="v2-override-list">';
    overrides.forEach(o => {
      const v = VEHICLES.find(x => x.id === o.vehicle_id);
      html += '<div class="v2-override">' +
        '<span class="v2-override-main">' +
          '<span class="v2-override-head">' +
            '<span class="v2-override-truck">Truck #' + esc(v && v.truckNumber != null ? v.truckNumber : '?') + '</span>' +
            '<span class="v2-override-chip">' + (labels[o.reminder_type] || o.reminder_type) + '</span>' +
          '</span>' +
          '<span class="v2-override-params">Interval <b>' + o.interval_days + 'd</b>' +
            '<span class="v2-override-sep">&middot;</span>Warn <b>' + o.warning_days_before + 'd</b>' +
            '<span class="v2-override-sep">&middot;</span>Escalate <b>' + o.escalation_hours + 'h</b></span>' +
        '</span>' +
        '<button class="v2-icon-btn" type="button" onclick="remDeleteOverride(\'' + o.id + '\')"' +
        ' aria-label="Remove override for Truck #' + esc(v && v.truckNumber != null ? v.truckNumber : '?') + '">' + _sv(IC.trash) + '</button>' +
      '</div>';
    });
    html += '</div>';
  }
  html += '</section>';
  return html;
}

// ── Actions ───────────────────────────────────────────────────
async function remSaveSchedule(vehicleId, type, field, value) {
  if (!sb) return;
  if (vehicleId === null) {
    await sb.from('reminder_schedules')
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .is('vehicle_id', null)
      .eq('reminder_type', type);
  } else {
    await sb.from('reminder_schedules')
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq('vehicle_id', vehicleId)
      .eq('reminder_type', type);
  }
  // Refresh local cache
  const { data } = await sb.from('reminder_schedules').select('*').order('reminder_type');
  if (data) REM_SCHEDULES = data;
}

async function remSaveAllSchedules() {
  // Re-render to reflect current input values — data already saved via onchange
  await loadReminders();
  remSwitchTab('schedule');
}

async function remDeleteOverride(id) {
  if (!sb) return;
  await sb.from('reminder_schedules').delete().eq('id', id);
  REM_SCHEDULES = REM_SCHEDULES.filter(s => s.id !== id);
  remSwitchTab('schedule');
}

async function remTriggerScan(btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';
  const el = document.getElementById('rem-trigger-result');

  try {
    // Reload data to show latest state
    await loadReminders();
    const c = document.getElementById('content');
    if (c) c.innerHTML = renderReminders();
  } catch(e) {
    if (el) { el.style.display = ''; el.innerHTML = `<span style="color:var(--danger)">Scan failed: ${esc(e.message)}</span>`; }
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ── Send SMS modal ────────────────────────────────────────────
function remOpenSendModal(truckNum, vehicleId, driverId, type, label, overdue, daysOver, daysLeft) {
  const driver = DRIVERS.find(d => d.id === driverId);
  const phone  = DRIVER_PHONES.find(p => p.driver_id === driverId);
  const msg    = overdue
    ? `FleetGuard ALERT: Truck ${truckNum} ${label.toLowerCase()} is ${daysOver} day${daysOver!==1?'s':''} OVERDUE. Reply OK to confirm you are scheduling it.`
    : `FleetGuard: Truck ${truckNum} ${label.toLowerCase()} is due in ${daysLeft} day${daysLeft!==1?'s':''}. Reply OK to confirm scheduling.`;

  if (!phone) {
    alert(`No phone number on file for ${driver?.name ?? 'this driver'}.\nAdd it in Schedule Config → Driver Phone Numbers.`);
    return;
  }

  const html = `
<div id="rem-send-modal" class="modal-overlay" onclick="if(event.target===this)remCloseSendModal()">
  <div class="modal" style="max-width:460px">
    <div class="modal-header">
      <span style="display:flex;align-items:center;gap:8px">
        <span class="nav-icon" style="font-family:'Material Symbols Outlined';font-weight:300;line-height:1;font-size:20px;color:var(--primary-text)">sms</span>
        Send SMS Reminder
      </span>
      <button class="btn btn-ghost btn-sm" onclick="remCloseSendModal()" style="padding:4px 8px;font-size:18px;line-height:1">×</button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:10px;margin-bottom:16px">
        <div style="flex:1;background:var(--surface-low);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:4px">Truck</div>
          <div style="font-weight:800;font-size:15px;font-family:'Manrope',sans-serif">Truck #${esc(truckNum)}</div>
        </div>
        <div style="flex:1;background:var(--surface-low);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:4px">Driver</div>
          <div style="font-weight:600;font-size:13px">${esc(driver?.name ?? '—')}</div>
        </div>
      </div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:6px">Message Preview</div>
      <div style="background:var(--primary-dim);border:1px solid rgba(218,101,54,.3);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--primary-text);line-height:1.6;margin-bottom:16px">${esc(msg)}</div>
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:6px">Send Via</div>
      <div style="background:var(--surface-low);border:1px solid var(--border);border-radius:10px;padding:11px 14px;display:flex;align-items:center;gap:10px">
        <div style="width:32px;height:32px;background:var(--success-bg);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px">📱</div>
        <div>
          <div style="font-weight:700;font-size:13px">Google Voice Bot</div>
          <div style="font-size:11px;color:var(--text2)">Playwright automation · auto-retries on fail</div>
        </div>
        <span class="badge badge-green" style="margin-left:auto"><span class="rem-live-dot" style="width:5px;height:5px;margin-right:3px"></span>Online</span>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="remCloseSendModal()">Cancel</button>
      <button class="btn btn-primary" onclick="remConfirmSend(this,'${esc(phone.phone_number)}','${esc(msg.replace(/'/g,"\\'"))}','${vehicleId}','${driverId}','${type}')">
        <span class="nav-icon" style="font-family:'Material Symbols Outlined';font-weight:300;line-height:1;font-size:15px">send</span> Send SMS
      </button>
    </div>
  </div>
</div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('rem-send-modal').style.display = 'flex';
}

function remCloseSendModal() {
  const m = document.getElementById('rem-send-modal');
  if (m) m.remove();
}

async function remConfirmSend(btn, phone, msg, vehicleId, driverId, type) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending...';
  try {
    // Insert notification row via Supabase (Edge Function will update status)
    const { data: notif } = await sb.from('sms_notifications').insert({
      vehicle_id:    vehicleId,
      driver_id:     driverId,
      reminder_type: type,
      phone_number:  phone,
      message_body:  msg,
      status:        'pending',
    }).select('id').single();

    if (notif) {
      SMS_NOTIFS.unshift({ ...notif, vehicle_id: vehicleId, driver_id: driverId,
        reminder_type: type, phone_number: phone, message_body: msg,
        status: 'pending', created_at: new Date().toISOString() });
    }
    remCloseSendModal();
    // Refresh view
    await loadReminders();
    const c = document.getElementById('content');
    if (c) c.innerHTML = renderReminders();
  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = orig;
    alert('Send failed: ' + e.message);
  }
}

// ── CSV export ────────────────────────────────────────────────
function remExportCSV() {
  const rows = [['Date','Truck','Driver','Type','Status','Replied']];
  SMS_NOTIFS.forEach(n => {
    const v      = VEHICLES.find(x => x.id === n.vehicle_id);
    const driver = DRIVERS.find(d => d.id === n.driver_id);
    const replied = SMS_REPLIES.some(r => r.notification_id === n.id) ? 'Yes' : 'No';
    rows.push([fmtDate(n.created_at), v?.truckNumber??'', driver?.name??'', n.reminder_type, n.status, replied]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a   = document.createElement('a');
  a.href    = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `fleetguard-sms-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
}

// ── Utilities ─────────────────────────────────────────────────
function maskPhone(p) {
  if (!p) return '—';
  return p.replace(/\d(?=\d{4})/g, '•');
}

function remTimeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}
