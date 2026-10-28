'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scrollBehavior = () => reducedMotion.matches ? 'auto' : 'smooth';

  // ============================================================
  // First-party analytics + real lead submit — ported unchanged from
  // the live /vgn/ page so the refreshed design reuses the SAME engine.
  // Cookieless, aggregate-only: only an opaque session id, allowlisted
  // attribution, foreground active-time and interaction TYPES are sent
  // to va-collect. Names/phones go ONLY to the secure driver-apply
  // endpoint on submit — never to analytics.
  // ============================================================
  function qp(k){ try{ return (new URLSearchParams(location.search).get(k)||'').slice(0,120); }catch(e){ return ''; } }
  var utmSource=qp('utm_source').slice(0,60);
  var attribution={ utm_source:utmSource, utm_medium:qp('utm_medium'), utm_campaign:qp('utm_campaign'), utm_content:qp('utm_content'), utm_term:qp('utm_term'), posting_city:qp('posting_city'), creative_id:qp('creative_id') };
  var referrerHost=''; try{ referrerHost=document.referrer?new URL(document.referrer).hostname.slice(0,120):''; }catch(e){}
  var leadSrc=(function(u,r){u=(u||'').toLowerCase();if(u.indexOf('indeed')>=0)return'indeed';if(u.indexOf('instagram')>=0||u==='ig'||u==='insta')return'instagram';if(u.indexOf('tiktok')>=0||u==='tt')return'tiktok';if(u.indexOf('facebook')>=0||u==='fb'||u==='meta')return'facebook';if(u.indexOf('craigslist')>=0||u==='cl')return'craigslist';if(!u){r=(r||'').toLowerCase();if(r.indexOf('indeed')>=0)return'indeed';if(r.indexOf('instagram')>=0)return'instagram';if(r.indexOf('tiktok')>=0)return'tiktok';if(r.indexOf('facebook')>=0||r.indexOf('fb.')>=0)return'facebook';if(r.indexOf('craigslist')>=0)return'craigslist';}return'direct';})(utmSource,referrerHost);
  var device=(function(){ var w=Math.min(screen.width||window.innerWidth||1024, window.innerWidth||screen.width||1024); var touch=('ontouchstart' in window)||(navigator.maxTouchPoints>0); if(w<768) return 'mobile'; if(w<=1024&&touch) return 'tablet'; return 'desktop'; })();
  var ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRtcGRzaXVhZGFmYmttbGR2bGtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2OTA1MzcsImV4cCI6MjA5MTI2NjUzN30.EpALvafgN7q0HAgS1K286IU7B2xGrkQQwpriMOvAr6o';
  var API='https://tmpdsiuadafbkmldvlki.supabase.co/functions/v1';
  var hdrs={'Content-Type':'application/json','apikey':ANON,'Authorization':'Bearer '+ANON};
  // Only send analytics from the real site; skip local/dev hosts so previews don't pollute.
  var trackOK = !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname) && !/\.localhost$/.test(location.hostname);
  var SESSION_GAP=30*60*1000, IDLE_CUTOFF=60*1000;
  function newId(){ return (window.crypto&&crypto.randomUUID)?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);return v.toString(16);}); }
  var sessionId, activeMs=0;
  try{ var saved=JSON.parse(sessionStorage.getItem('vgn_va')||'null'); if(saved&&saved.sid&&(Date.now()-(saved.last||0))<SESSION_GAP){ sessionId=saved.sid; activeMs=saved.activeMs||0; } }catch(e){}
  if(!sessionId){ sessionId=newId(); activeMs=0; }
  function persist(){ try{ sessionStorage.setItem('vgn_va', JSON.stringify({sid:sessionId, activeMs:Math.round(activeMs), last:Date.now()})); }catch(e){} }
  var lastTick=performance.now(), lastInteraction=performance.now(), vaVisible=(document.visibilityState==='visible');
  function isActive(){ return vaVisible && (performance.now()-lastInteraction)<IDLE_CUTOFF; }
  function accumulate(){ var now=performance.now(), d=now-lastTick; lastTick=now; if(d<0)d=0; if(d>65000)d=65000; if(isActive()) activeMs+=d; persist(); }
  function getActiveMs(){ accumulate(); return Math.round(activeMs); }
  ['scroll','click','keydown','pointerdown','pointermove','touchstart','wheel'].forEach(function(ev){ window.addEventListener(ev,function(){ lastInteraction=performance.now(); },{passive:true,capture:true}); });
  var evQueue=[];
  function markEvent(type, detail){ evQueue.push({type:type, detail:detail||null}); }
  function sendVA(keepalive){
    if(!trackOK){ return; }
    accumulate();
    var body={ session_id:sessionId, active_ms:Math.round(activeMs), path:location.pathname, source:leadSrc,
      utm_source:attribution.utm_source, utm_medium:attribution.utm_medium, utm_campaign:attribution.utm_campaign,
      utm_content:attribution.utm_content, utm_term:attribution.utm_term, posting_city:attribution.posting_city,
      creative_id:attribution.creative_id, referrer_host:referrerHost, device:device };
    if(evQueue.length){ body.events=evQueue.splice(0,40); }
    try{ fetch(API+'/va-collect',{method:'POST',keepalive:!!keepalive,headers:hdrs,body:JSON.stringify(body)}).catch(function(){}); }catch(e){}
  }
  sendVA(false); // initial session beacon
  setInterval(function(){ accumulate(); if(evQueue.length||isActive()) sendVA(false); }, 15000);
  document.addEventListener('visibilitychange', function(){ accumulate(); vaVisible=(document.visibilityState==='visible'); if(vaVisible){ lastTick=performance.now(); lastInteraction=performance.now(); } else { sendVA(true); } });
  window.addEventListener('pagehide', function(){ accumulate(); sendVA(true); });
  // interaction events wired to the NEW DOM (types only, no PII):
  $$('#vgn-faq details').forEach(function(d,i){ d.addEventListener('toggle', function(){ if(d.open){ markEvent('faq_open','faq'+(i+1)); } }); });
  $$('a[href="#vgn-callback"], a[href="#callback-form"]').forEach(function(a){ a.addEventListener('click', function(){ markEvent('callback_cta'); }); });
  $$('a[href^="tel:"]').forEach(function(a){ a.addEventListener('click', function(){ markEvent('call_click', /515/.test(a.getAttribute('href'))?'carl':'ray'); sendVA(true); }); });
  $$('a[href^="sms:"]').forEach(function(a){ a.addEventListener('click', function(){ markEvent('text_click', /515/.test(a.getAttribute('href'))?'carl':'ray'); sendVA(true); }); });
  $$('a[href*="intelliapp"]').forEach(function(a){ a.addEventListener('click', function(){ markEvent('intelliapp_click'); sendVA(true); }); });

  const menu = $('.menu-toggle');
  const navigation = $('#site-navigation');
  const closeMenu = () => {
    navigation.classList.remove('is-open');
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open navigation');
  };
  menu.addEventListener('click', () => {
    const open = !navigation.classList.contains('is-open');
    navigation.classList.toggle('is-open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
  $$('#site-navigation a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navigation.classList.contains('is-open')) {
      closeMenu();
      menu.focus();
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.site-header')) closeMenu();
  });

  // Program selections stay in memory; personal details are never persisted.
  const programSelect = $('#program-interest');
  $$('[data-program]').forEach(link => link.addEventListener('click', () => {
    programSelect.value = link.dataset.program;
    updateSelectedProgram();
    markEvent('program_cta', link.dataset.program);
  }));
  function updateSelectedProgram() {
    $$('[data-program-card]').forEach(card => card.classList.toggle('is-selected', card.dataset.programCard === programSelect.value));
  }
  programSelect.addEventListener('change', updateSelectedProgram);

  const track = $('#video-track');
  const cards = $$('.video-card', track);
  const previousVideo = $('[data-video-prev]');
  const nextVideo = $('[data-video-next]');
  function updateVideoControls() {
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    previousVideo.disabled = track.scrollLeft < 4;
    nextVideo.disabled = track.scrollLeft >= maxScroll - 4;
    const left = track.scrollLeft;
    const visible = cards.map((card, i) => ({i, left: card.offsetLeft - track.offsetLeft, width: card.offsetWidth}))
      .filter(card => card.left + card.width > left + 16 && card.left < left + track.clientWidth - 24);
    const first = visible[0]?.i ?? 0;
    const last = visible[visible.length - 1]?.i ?? first;
    $('#video-position').textContent = `${first + 1}${last > first ? '–' + (last + 1) : ''} / ${cards.length}`;
  }
  function moveVideo(direction) {
    const distance = cards[0].getBoundingClientRect().width + parseFloat(getComputedStyle(track).gap || '24');
    track.scrollBy({left: direction * distance, behavior: scrollBehavior()});
  }
  previousVideo.addEventListener('click', () => moveVideo(-1));
  nextVideo.addEventListener('click', () => moveVideo(1));
  track.addEventListener('scroll', updateVideoControls, {passive: true});
  track.addEventListener('keydown', event => {
    if (event.target !== track) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      moveVideo(event.key === 'ArrowRight' ? 1 : -1);
    }
  });
  window.addEventListener('resize', updateVideoControls, {passive: true});
  window.addEventListener('load', updateVideoControls, {once: true});
  updateVideoControls();

  const gallery = [
    {src: 'assets/truck-volvo.jpg', alt: 'White VGN Volvo tractor at the Lansing yard', title: 'Volvo VNL', caption: 'Real equipment from our yard.'},
    {src: 'assets/truck-cascadia.jpg', alt: 'White Freightliner Cascadia with grille guard at the VGN yard', title: 'Freightliner Cascadia', caption: 'A closer look at the truck.'},
    {src: 'assets/truck-rear.jpg', alt: 'Rear view of a VGN tractor at the truck yard', title: 'A look from the rear', caption: 'Real yard photography.'},
    {src: 'assets/truck-front.jpg', alt: 'Front view of a white VGN truck', title: 'Up front', caption: 'See the equipment before you decide.'}
  ];
  let galleryIndex = 0;
  const galleryStage = $('#gallery-stage');
  function setGallery(index) {
    galleryIndex = (index + gallery.length) % gallery.length;
    const photo = gallery[galleryIndex];
    $('#gallery-image').src = photo.src;
    $('#gallery-image').alt = photo.alt;
    $('.gallery-backdrop').src = photo.src;
    $('#gallery-count').textContent = `${galleryIndex + 1} / ${gallery.length}`;
    const caption = $('#gallery-caption');
    $('strong', caption).textContent = photo.title;
    $('span', caption).textContent = photo.caption;
    $$('[data-gallery-index]').forEach(button => {
      if (Number(button.dataset.galleryIndex) === galleryIndex) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  }
  $('[data-gallery-prev]').addEventListener('click', () => setGallery(galleryIndex - 1));
  $('[data-gallery-next]').addEventListener('click', () => setGallery(galleryIndex + 1));
  $$('[data-gallery-index]').forEach(button => button.addEventListener('click', () => setGallery(Number(button.dataset.galleryIndex))));
  galleryStage.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setGallery(galleryIndex + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  let touchStart;
  galleryStage.addEventListener('touchstart', event => {
    if (event.touches.length === 1) touchStart = {x: event.touches[0].clientX, y: event.touches[0].clientY};
  }, {passive: true});
  galleryStage.addEventListener('touchend', event => {
    if (!touchStart || !event.changedTouches[0]) return;
    const dx = event.changedTouches[0].clientX - touchStart.x;
    const dy = event.changedTouches[0].clientY - touchStart.y;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) setGallery(galleryIndex + (dx < 0 ? 1 : -1));
    touchStart = null;
  }, {passive: true});
  galleryStage.addEventListener('touchcancel', () => { touchStart = null; }, {passive: true});

  // Reuse the 3 videos already in the repo (byte-identical to the handoff's);
  // only Arnulfo is new. Avoids committing ~48 MB of duplicate video.
  const stories = {
    week: {title: 'My week at VGN — Mitch', src: 'assets/testimonials/review-1-mitch.mp4', poster: 'assets/driver-week.jpg'},
    support: {title: 'Considering VGN? A driver answers.', src: 'assets/testimonials/review-2-highlights.mp4', poster: 'assets/driver-support.jpg'},
    real: {title: 'Keeping it real — full driver review', src: 'assets/testimonials/review-3-keeping-it-real.mp4', poster: 'assets/driver-real.jpg'},
    arnulfo: {title: 'Arnulfo’s story', src: 'assets/testimonials/driver-arnulfo.mp4', poster: 'assets/driver-arnulfo.png'}
  };
  const statements = {
    '3158': {date: 'September 13–19, 2026', net: '$3,158.88', gross: '$10,000'},
    '4703': {date: 'September 13–19, 2026', net: '$4,703.72', gross: '$11,200'},
    '3413': {date: 'September 6–12, 2026', net: '$3,413.20', gross: '$10,200'},
    '4511': {date: 'September 6–12, 2026', net: '$4,511.20', gross: '$11,550'}
  };
  const dialog = $('#media-dialog');
  const dialogBody = $('#dialog-body');
  let activeVideo;
  let opener;
  function showDialog(title, kind, trigger) {
    opener = trigger;
    $('#dialog-title').textContent = title;
    dialog.classList.toggle('is-video', kind === 'video');
    document.body.classList.add('dialog-open');
    dialog.showModal();
    $('.dialog-close').focus();
  }
  function closeDialog() {
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener('close', () => {
    if (activeVideo) {
      activeVideo.pause();
      activeVideo.removeAttribute('src');
      activeVideo.load();
      activeVideo = null;
    }
    dialogBody.replaceChildren();
    document.body.classList.remove('dialog-open');
    opener?.focus({preventScroll: true});
  });
  $('.dialog-close').addEventListener('click', closeDialog);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
  });
  $$('[data-story]').forEach(button => button.addEventListener('click', () => {
    const story = stories[button.dataset.story];
    markEvent('video_click', button.dataset.story);
    dialogBody.replaceChildren();
    if (story.src) {
      const video = document.createElement('video');
      video.className = 'dialog-video';
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.poster = story.poster;
      video.src = story.src;
      video.setAttribute('aria-label', story.title);
      video.addEventListener('error', () => {
        let notice = $('.video-error', dialogBody);
        if (!notice) {
          notice = document.createElement('p');
          notice.className = 'video-note video-error';
          notice.textContent = 'This video file is not available in this preview. Its original will be connected before release.';
          dialogBody.append(notice);
        }
      });
      dialogBody.append(video);
      activeVideo = video;
      const note = document.createElement('p');
      note.className = 'video-note';
      note.textContent = 'Individual driver experience. Results vary.';
      dialogBody.append(note);
      showDialog(story.title, 'video', button);
      video.play().catch(() => { /* Native play controls remain available. */ });
    } else {
      const pending = document.createElement('div');
      pending.className = 'pending-media';
      const image = document.createElement('img');
      image.src = story.poster;
      image.alt = 'Supplied Arnulfo story cover';
      const note = document.createElement('p');
      note.textContent = 'Arnulfo’s supplied cover is in place. His video will be added when the original is provided.';
      pending.append(image, note);
      dialogBody.append(pending);
      showDialog(story.title, 'video', button);
    }
  }));
  $$('[data-statement]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.statement;
    markEvent('statement_open', key);
    const statement = statements[key];
    const source = `assets/statement-${key}-full.png`;
    dialogBody.replaceChildren();
    const toolbar = document.createElement('div');
    toolbar.className = 'dialog-statement-toolbar';
    const summary = document.createElement('span');
    summary.textContent = `${statement.gross} gross · ${statement.net} settlement · Tap the document to zoom`;
    const original = document.createElement('a');
    original.href = source;
    original.target = '_blank';
    original.rel = 'noopener';
    original.textContent = 'Open original image ↗';
    toolbar.append(summary, original);
    const view = document.createElement('div');
    view.className = 'statement-view';
    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.setAttribute('aria-label', 'Zoom in on statement');
    zoom.setAttribute('aria-pressed', 'false');
    const image = document.createElement('img');
    image.src = source;
    image.alt = `Original VGN statement, ${statement.date}, ${statement.gross} gross, ${statement.net} settlement after listed deductions.`;
    zoom.append(image);
    zoom.addEventListener('click', () => {
      const enlarged = view.classList.toggle('is-zoomed');
      zoom.setAttribute('aria-pressed', String(enlarged));
      zoom.setAttribute('aria-label', enlarged ? 'Zoom out on statement' : 'Zoom in on statement');
    });
    view.append(zoom);
    dialogBody.append(toolbar, view);
    showDialog(statement.date, 'statement', button);
  }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeVideo) activeVideo.pause();
  });

  // Live callback form — wired to the shared driver-apply + va-collect engine above.
  const form = $('#callback-form');
  const phone = $('#driver-phone');
  const phoneError = $('#phone-error');
  const status = $('#form-status');
  // On a phone, callback CTAs land directly on the form instead of the long section intro.
  $$('a[href="#vgn-callback"]').forEach(link => link.addEventListener('click', event => {
    if (!window.matchMedia('(max-width: 650px)').matches) return;
    event.preventDefault();
    form.scrollIntoView({behavior: scrollBehavior(), block: 'start'});
  }));
  // Keep the phone contact dock away from the visible form and native video dialog.
  if ('IntersectionObserver' in window) {
    const callbackObserver = new window.IntersectionObserver(entries => {
      document.body.classList.toggle('callback-in-view', entries.some(entry => entry.isIntersecting));
    }, {threshold: 0});
    callbackObserver.observe($('#vgn-callback'));
  }
  function validUSPhone(value) {
    if (!/^[+\d\s().-]+$/.test(value)) return false;
    const digits = value.replace(/\D/g, '');
    return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
  }
  phone.addEventListener('input', () => {
    phone.setCustomValidity('');
    phone.removeAttribute('aria-invalid');
    phoneError.hidden = true;
    status.hidden = true;
  });
  form.addEventListener('input', () => { status.hidden = true; });
  // form_start fires once, when the driver first focuses the form.
  let formStarted = false, submitting = false;
  form.addEventListener('focusin', () => { if (!formStarted) { formStarted = true; markEvent('form_start'); sendVA(false); } });
  function setStatus(msg, ok) { status.hidden = false; status.textContent = msg; status.classList.toggle('is-error', !ok); }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submitting) return;
    if (form.company && form.company.value) { setStatus('Thanks — we’ll be in touch.', true); return; } // honeypot: silent, send nothing
    const validPhone = validUSPhone(phone.value);
    phone.setCustomValidity(validPhone ? '' : 'Enter a valid 10-digit US phone number.');
    phone.setAttribute('aria-invalid', String(!validPhone));
    phoneError.hidden = validPhone;
    const driverName = $('#driver-name');
    driverName.setCustomValidity(driverName.value.trim() ? '' : 'Enter your name.');
    if (!form.reportValidity()) return;
    const name = driverName.value.trim();
    const phoneRaw = phone.value.trim();
    const recruiter = ($('input[name="recruiter"]:checked', form) || {}).value || 'Either';
    const program = programSelect.value;
    const bestTime = form.bestTime ? (form.bestTime.value || '').trim() : '';
    submitting = true;
    const submitBtn = form.querySelector('button[type=submit]');
    submitBtn.disabled = true; const oldLabel = submitBtn.textContent; submitBtn.textContent = 'Sending…';
    markEvent('submit_attempt'); sendVA(false);
    // Same secure endpoint, routing and payload as the live page: the text goes
    // to Ray; the recruiter preference and program are recorded on the lead.
    fetch(API + '/driver-apply', { method: 'POST', headers: hdrs,
      body: JSON.stringify({ full_name: name, phone: phoneRaw, recruiter: recruiter, program: program, best_time: bestTime, consent: true, source: leadSrc, utm_source: utmSource, session_id: sessionId, active_ms: getActiveMs() }) })
      .then(r => r.json().then(j => ({ ok: r.ok, j: j })).catch(() => ({ ok: r.ok, j: {} })))
      .then(res => {
        if (res.ok && res.j && res.j.ok) {
          const who = recruiter === 'Either' ? 'Ray or Carl' : recruiter;
          markEvent('submit_success'); sendVA(false);
          form.reset(); programSelect.value = program; updateSelectedProgram();
          setStatus(`Thanks, ${name.split(' ')[0]}. Your request is in — ${who} will call you${bestTime ? ' (' + bestTime + ')' : ''}. Prefer to call now? Ray 708-232-8523 · Carl 515-603-0686.`, true);
        } else {
          markEvent('submit_fail', 'server'); sendVA(false);
          setStatus((res.j && res.j.error) || 'Something went wrong. Please call Ray at 708-232-8523 or Carl at 515-603-0686.', false);
        }
      })
      .catch(() => setStatus('Network error. Please call Ray at 708-232-8523 or Carl at 515-603-0686.', false))
      .finally(() => { submitting = false; submitBtn.disabled = false; submitBtn.textContent = oldLabel; });
  });
  $('#driver-name').addEventListener('input', event => event.target.setCustomValidity(''));
})();
