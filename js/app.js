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


const SB_URL = 'https://tmpdsiuadafbkmldvlki.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRtcGRzaXVhZGFmYmttbGR2bGtpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2OTA1MzcsImV4cCI6MjA5MTI2NjUzN30.EpALvafgN7q0HAgS1K286IU7B2xGrkQQwpriMOvAr6o';

async function initAuth() {
  const fn = getCreateClient();
  if (!fn) { showLoginScreen(); return; }
  try {
    sb = fn(SB_URL, SB_KEY);
    const { data: { session } } = await sb.auth.getSession();
    if (session) { await setUserFromSession(session); }
    else { showLoginScreen(); }
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) { await setUserFromSession(session); }
      else if (event === 'SIGNED_OUT') { currentUser = null; currentRole = null; showLoginScreen(); }
    });
  } catch(e) { showLoginScreen(); }
}


async function setUserFromSession(session) {
  currentUser = session.user;
  try {
    const { data } = await sb.from('profiles').select('role').eq('id', currentUser.id).single();
