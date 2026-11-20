// SFAX server - uses only built-in Node.js modules (no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

let db = { senders: {}, postoffices: {}, messages: [] };
// Storage: if UPSTASH_REDIS_REST_URL/TOKEN are set, data lives in a free online Redis database (survives restarts).
// Otherwise it falls back to a local data.json file.
const REMOTE = process.env.UPSTASH_REDIS_REST_URL, RTOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const remote = (cmd) => fetch(REMOTE, { method: 'POST', headers: { Authorization: 'Bearer ' + RTOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) })
  .then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j; });
let saving = false, again = false;
const save = () => {
  if (!REMOTE) return fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  if (saving) { again = true; return; }
  saving = true;
  remote(['SET', 'sfax:db', JSON.stringify(db)]).catch(e => console.error('Save failed:', e.message))
    .finally(() => { saving = false; if (again) { again = false; save(); } });
};
async function loadDb() {
  if (REMOTE) { const j = await remote(['GET', 'sfax:db']); if (j.result) db = JSON.parse(j.result); }
  else { try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {} }
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'); // set SESSION_SECRET so logins survive restarts
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const makeUser = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: hash(pw, salt) }; };
const checkPw = (u, pw) => u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hash(pw, u.salt), 'hex'));
const newSession = (role, id, ttl) => { const p = Buffer.from(JSON.stringify({ role, id, iat: Date.now(), exp: Date.now() + (ttl || 7 * 864e5) })).toString('base64url'); return p + '.' + sign(p); };

const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=15552000',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.postalpincode.in; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };

// ---- safety helpers: rate limiting, audit log (no message content), email ----
const hits = new Map();
const limited = (key, max, ms) => { const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms); if (a.length >= max) { hits.set(key, a); return true; } a.push(now); hits.set(key, a); return false; };
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { const f = a.filter(t => now - t < 3600e3); f.length ? hits.set(k, f) : hits.delete(k); } }, 600e3).unref();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const mask = (e) => String(e).replace(/^(.).*(@.*)$/, '$1***$2');
const audit = (type, who) => { db.audit = db.audit || []; db.audit.push({ t: Date.now(), type, who: String(who || '') }); if (db.audit.length > 500) db.audit.splice(0, db.audit.length - 500); };
const mailOn = () => !!(process.env.MAIL_FROM && (process.env.BREVO_API_KEY || process.env.RESEND_API_KEY));
let mailState = { at: 0, ok: null, error: '' };   // result of the last email attempt (shown to the admin)
async function sendMail(to, subject, text) {   // HTTPS email API (Render's free plan blocks SMTP). Brevo or Resend.
  const from = process.env.MAIL_FROM;
  let ok = false, err = '';
  try {
    if (!mailOn()) err = 'Email is not set up: MAIL_FROM and BREVO_API_KEY (or RESEND_API_KEY) are missing on the server.';
    else if (process.env.BREVO_API_KEY) {
      const r = await fetch(process.env.MAIL_API_URL || 'https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { email: from, name: 'SFAX' }, to: [{ email: to }], subject, textContent: text }) });
      ok = r.ok; if (!ok) err = 'Brevo answered ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200);
    } else {
      const r = await fetch(process.env.MAIL_API_URL || 'https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'SFAX <' + from + '>', to: [to], subject, text }) });
      ok = r.ok; if (!ok) err = 'Resend answered ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200);
    }
  } catch (e) { err = 'Could not reach the mail service: ' + e.message; }
  mailState = { at: Date.now(), ok, error: ok ? '' : err };
  return ok;
}
// ---- retention: printed messages are deleted after RETAIN_PRINTED_DAYS, never-printed ones after EXPIRE_UNPRINTED_DAYS ----
const RETAIN_PRINTED_DAYS = Number(process.env.RETAIN_PRINTED_DAYS || 30), EXPIRE_UNPRINTED_DAYS = Number(process.env.EXPIRE_UNPRINTED_DAYS || 90);
function purge() {
  const now = Date.now(), before = db.messages.length;
  db.messages = db.messages.filter(m => m.printed ? now - (m.printedAt || m.at) < RETAIN_PRINTED_DAYS * 864e5 : now - m.at < EXPIRE_UNPRINTED_DAYS * 864e5);
  if (db.messages.length !== before) { audit('purge', (before - db.messages.length) + ' old messages deleted'); save(); }
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return y.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
const tokenOk = (req) => safeEq(req.headers['x-admin-token'] || '', process.env.ADMIN_TOKEN || '');   // owner's ADMIN_TOKEN (backup route)
const adminSess = (req) => {                                  // the single admin account's login session
  const [p, sig] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (!p || !sig || sig.length !== sign(p).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(p)))) return null;
  try { const t = JSON.parse(Buffer.from(p, 'base64url').toString()); if (t.role !== 'admin' || !(t.exp > Date.now()) || !db.admin) return null;
    if (db.admin.pwAt && (t.iat || 0) < db.admin.pwAt) return null; return t; } catch (e) { return null; }
};
const adminOk = (req) => tokenOk(req) || !!adminSess(req);
// ---- one-time codes sent by email (login, password reset, admin) ----
const PW_ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genPw = (n) => Array.from({ length: n }, () => PW_ALPHA[crypto.randomInt(PW_ALPHA.length)]).join('');
function putOtp(key, ms) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
  db.otp = db.otp || {}; db.otp[key] = { salt, h: hash(code, salt), exp: Date.now() + ms, tries: 0 }; save(); return code;
}
function checkOtp(key, code) {
  const r = (db.otp || {})[key]; if (!r) return false;
  if (r.exp < Date.now() || r.tries >= 5) { delete db.otp[key]; save(); return false; }
  r.tries++;
  const ok = /^[0-9]{6}$/.test(String(code)) && crypto.timingSafeEqual(Buffer.from(hash(String(code), r.salt), 'hex'), Buffer.from(r.h, 'hex'));
  if (ok) delete db.otp[key];
  save(); return ok;
}
const getAcct = (role, id) => role === 'po' ? db.postoffices[String(id || '').trim()] : db.senders[String(id || '').trim().toLowerCase()];
const SITE_KEYS = { org: 'ORG_NAME', email: 'SUPPORT_EMAIL', phone: 'SUPPORT_PHONE', address: 'ORG_ADDRESS', about: 'ORG_ABOUT', hours: 'SUPPORT_HOURS' };
const siteVal = (k) => { const v = (db.site || {})[k]; return v != null && v !== '' ? String(v) : (process.env[SITE_KEYS[k]] || ''); };
const googleOn = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && /^https?:\/\//.test(process.env.SITE_URL || ''));
const ASSET_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html')), PAGE_GZ = zlib.gzipSync(PAGE);
const ADMIN_PAGE = fs.existsSync(path.join(__dirname, 'public', 'admin.html')) ? fs.readFileSync(path.join(__dirname, 'public', 'admin.html')) : Buffer.from('Admin page missing');
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 100000) { no(new Error('Too large')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(new Error('Bad JSON')); } });
});
const auth = (req, role) => {
  const [p, sig] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (!p || !sig || sig.length !== sign(p).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(p)))) return null;
  try { const s = JSON.parse(Buffer.from(p, 'base64url').toString()); if (s.role !== role || !(s.exp > Date.now())) return null;
    const acct = role === 'po' ? db.postoffices[s.id] : db.senders[s.id];
    if (!acct || acct.suspended || (acct.pwAt && (s.iat || 0) < acct.pwAt)) return null;   // account removed, or password changed after this login
    return s; } catch (e) { return null; }
};
const emailOk = (e) => /^\S+@\S+\.\S+$/.test(e);
const codeOk = (c) => /^[A-Za-z0-9]{3,10}$/.test(c);
const b64ok = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9+/=]+$/.test(v);
const encOk = (e) => e && b64ok(e.iv, 40) && b64ok(e.ct, 60000) && b64ok(e.wk, 2000);
const ESCROW_PUB = process.env.ESCROW_PUBLIC_KEY || '', ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';   // owner's backup key (public half only!)
const MIN_APP = process.env.MIN_APP_VERSION || '';   // e.g. 1.0.0 : only the SFAX Print app (this version or newer) may fetch messages
const appOk = (req) => { if (!MIN_APP) return true; const a = String(req.headers['x-sfax-app'] || '0').split('.').map(Number), m = MIN_APP.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (m[i] || 0)) return (a[i] || 0) > (m[i] || 0); } return true; };
const needApp = (res) => send(res, 426, { error: 'Please use the SFAX Print app (version ' + MIN_APP + ' or newer) to open messages.' });
const APP_URL = /^https:\/\//.test(process.env.APP_DOWNLOAD_URL || '') ? process.env.APP_DOWNLOAD_URL : '';   // where post offices download the SFAX Print app
// ---- Messages sent before a post office has installed the SFAX Print app ----
// They are sealed to a "relay" key derived from the server's secret. When the post office's app registers its key,
// the server re-wraps each message key to that post office and forgets the relay copy. Until then the server holder can open them.
const RELAY_SECRET = process.env.RELAY_SECRET || process.env.SESSION_SECRET || '';
let RELAY = null;
if (RELAY_SECRET) { try { const e = crypto.createECDH('prime256v1'); e.setPrivateKey(Buffer.from(crypto.hkdfSync('sha256', RELAY_SECRET, '', 'sfax-relay-key-v1', 32))); RELAY = { ecdh: e, pub: e.getPublicKey().toString('base64') }; } catch (e) { RELAY = null; } }
function unwrapRelay(rk) {
  const key = Buffer.from(crypto.hkdfSync('sha256', RELAY.ecdh.computeSecret(Buffer.from(rk.epk, 'base64')), Buffer.alloc(0), 'sfax-pending-v1', 32));
  const all = Buffer.from(rk.ct, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rk.iv, 'base64'));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
}
function rewrap(po, m) {   // true if the message is now sealed straight to the post office's own key
  try {
    if (!(RELAY && po && po.publicKey && m.enc && m.enc.rk && !m.enc.wk)) return false;
    const pub = crypto.createPublicKey({ key: Buffer.from(po.publicKey, 'base64'), format: 'der', type: 'spki' });
    const wk = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, unwrapRelay(m.enc.rk));
    m.enc = { v: 1, iv: m.enc.iv, ct: m.enc.ct, wk: wk.toString('base64') };
    return true;
  } catch (e) { return false; }
}
const msgEncOk = (e) => e && b64ok(e.iv, 40) && b64ok(e.ct, 60000) && (b64ok(e.wk, 2000) || (e.rk && b64ok(e.rk.epk, 200) && b64ok(e.rk.iv, 40) && b64ok(e.rk.ct, 200)));
const fpOf = (spki) => crypto.createHash('sha256').update(Buffer.from(spki, 'base64')).digest('hex').slice(0, 32).replace(/(.{4})/g, '$1 ').trim();

async function userLogin(req, res, role, id, acct) {   // the password was already checked
  if (acct.suspended) return send(res, 403, { error: 'This account is suspended. Please contact support.' });
  // Emailed login code (if the person switched it on). The Print app is exempt: its protection is the key kept on that computer.
  if (acct.twofa && acct.email && mailOn() && !req.headers['x-sfax-app']) {
    const code = putOtp('login:' + role + ':' + id, 10 * 60e3);
    if (!(await sendMail(acct.email, 'Your SFAX login code', 'Your SFAX login code is ' + code + '. It expires in 10 minutes.\n\nIf this was not you, change your password.'))) return send(res, 502, { error: 'The login code could not be emailed right now. Please try again, or contact support.' });
    return send(res, 200, { need2fa: true, email: mask(acct.email) });
  }
  return send(res, 200, { token: newSession(role, id), ...(role === 'po' ? { code: id } : { name: acct.name }) });
}
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/privacy' || url === '/terms')) {
      const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}), ...SEC });
      return res.end(gz ? PAGE_GZ : PAGE);
    }
    if (req.method === 'GET' && url === '/admin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC }); return res.end(ADMIN_PAGE); }
    const asm = url.match(/^\/assets\/([A-Za-z0-9_-]{1,60})\.(png|jpe?g|svg|webp)$/);
    if (req.method === 'GET' && asm) {                       // logos: put the image files in public/assets
      const f = path.join(__dirname, 'public', 'assets', asm[1] + '.' + asm[2]);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': ASSET_TYPES[asm[2]], 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', ...(asm[2] === 'svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}) });
      return res.end(fs.readFileSync(f));
    }
    if (!url.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    const b = req.method === 'POST' ? await readBody(req) : {};

    // ---- site info, password reset, admin ----
    if (url === '/api/site-info' && req.method === 'GET')
      return send(res, 200, { org: siteVal('org'), email: siteVal('email'), phone: siteVal('phone'), address: siteVal('address'), about: siteVal('about'), hours: siteVal('hours'), mail: mailOn(), google: googleOn(),
        banner: (db.site || {}).banner || '', maintenance: !!(db.site || {}).maintenance });
    if (url === '/api/help' && req.method === 'POST') {      // a person who cannot use the emailed code asks the admin for help
      const role = b.role === 'po' ? 'po' : 'sender', who = String(b.id || '').trim().slice(0, 120), note = String(b.note || '').trim().slice(0, 600), contact = String(b.contact || '').trim().slice(0, 120);
      if (limited('help-ip:' + ipOf(req), 5, 3600e3) || limited('help-id:' + role + who, 3, 3600e3)) return send(res, 429, { error: 'Too many requests. Please wait a while and try again.' });
      if (!who) return send(res, 400, { error: role === 'po' ? 'Enter your post office PIN.' : 'Enter your email address.' });
      db.help = db.help || []; const h = { id: crypto.randomUUID(), role, who, note, contact, at: Date.now(), open: true };
      db.help.push(h); if (db.help.length > 200) db.help.splice(0, db.help.length - 200);
      audit('help-requested', role === 'po' ? who : mask(who)); save();
      const to = process.env.ADMIN_NOTIFY_EMAIL || (db.admin && db.admin.email);
      if (to) sendMail(to, 'SFAX: password help requested', (role === 'po' ? 'Post office ' + who : 'Sender ' + who) + ' asked for help with a password.\nContact: ' + (contact || 'not given') + '\nNote: ' + (note || 'none') + '\n\nCheck who they are first, then open the Help requests tab on your admin page.').catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (url === '/api/login2fa' && req.method === 'POST') {  // second step of login: the 6-digit code that was emailed
      const role = b.role === 'po' ? 'po' : 'sender', id = role === 'po' ? String(b.id || '').trim() : String(b.id || '').trim().toLowerCase(), acct = getAcct(role, id);
      if (limited('l2-ip:' + ipOf(req), 30, 600e3) || limited('l2-id:' + role + id, 10, 900e3)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      if (!acct || acct.suspended || !checkOtp('login:' + role + ':' + id, String(b.code || '').trim())) return send(res, 401, { error: 'That code is not correct or has expired. Please login again to get a new code.' });
      return send(res, 200, { token: newSession(role, id), ...(role === 'po' ? { code: id } : { name: acct.name }) });
    }
    if (url === '/api/account/twofa' && (req.method === 'POST' || req.method === 'GET')) {   // turn the emailed login code on or off
      const role = auth(req, 'sender') ? 'sender' : auth(req, 'po') ? 'po' : null, s0 = role && auth(req, role); if (!s0) return send(res, 401, { error: 'Please login again.' });
      const acct = getAcct(role, s0.id);
      if (req.method === 'GET') return send(res, 200, { twofa: !!acct.twofa, hasEmail: !!acct.email, mail: mailOn() });
      if (limited('tf:' + role + s0.id, 8, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait a while and try again.' });
      if (!checkPw(acct, String(b.password || ''))) return send(res, 403, { error: 'That password is not correct.' });
      if (b.enabled && !acct.email) return send(res, 400, { error: 'Add a recovery email first: the code is sent there.' });
      if (b.enabled && !mailOn()) return send(res, 503, { error: 'Email is not set up on this site yet, so login codes cannot be sent.' });
      acct.twofa = !!b.enabled; audit('twofa-' + (acct.twofa ? 'on' : 'off'), role === 'po' ? s0.id : mask(s0.id)); save();
      return send(res, 200, { ok: true, twofa: acct.twofa });
    }
    if (url === '/api/auth/google/start' && req.method === 'GET') {   // "Sign in with Google" (OpenID Connect) for senders
      if (!googleOn()) { res.writeHead(302, { Location: '/#ge=' + encodeURIComponent('Google sign-in is not set up on this site yet.') }); return res.end(); }
      const st = Buffer.from(JSON.stringify({ n: crypto.randomBytes(16).toString('hex'), exp: Date.now() + 10 * 60e3 })).toString('base64url') + '.', state = st + sign(st);
      const q = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.SITE_URL.replace(/\/$/, '') + '/api/auth/google/callback', response_type: 'code', scope: 'openid email profile', state, nonce: JSON.parse(Buffer.from(st.split('.')[0], 'base64url')).n, prompt: 'select_account' });
      res.writeHead(302, { Location: (process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth') + '?' + q, 'Cache-Control': 'no-store' }); return res.end();
    }
    if (url === '/api/auth/google/callback' && req.method === 'GET') {
      const back = (m) => { res.writeHead(302, { Location: '/#ge=' + encodeURIComponent(m), 'Cache-Control': 'no-store' }); res.end(); };
      try {
        const q = new URL(req.url, 'http://x').searchParams, state = String(q.get('state') || ''), [sp, sg] = state.split('.');
        if (!googleOn() || !sp || !sg || sg !== sign(sp + '.')) return back('The Google sign-in could not be checked. Please try again.');
        const sdata = JSON.parse(Buffer.from(sp, 'base64url').toString()); if (!(sdata.exp > Date.now())) return back('The Google sign-in took too long. Please try again.');
        if (!q.get('code')) return back('Google sign-in was cancelled.');
        const tr = await fetch(process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: q.get('code'), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.SITE_URL.replace(/\/$/, '') + '/api/auth/google/callback', grant_type: 'authorization_code' }) });
        const tj = await tr.json().catch(() => ({})); if (!tr.ok || !tj.id_token) return back('Google did not accept the sign-in. Please try again.');
        const idp = JSON.parse(Buffer.from(String(tj.id_token).split('.')[1] || '', 'base64url').toString());   // received straight from Google over HTTPS
        if (!['https://accounts.google.com', 'accounts.google.com'].includes(idp.iss) || idp.aud !== process.env.GOOGLE_CLIENT_ID || !(idp.exp * 1000 > Date.now()) || idp.nonce !== sdata.n || idp.email_verified !== true || !emailOk(String(idp.email || '')))
          return back('Google sign-in could not be verified.');
        const em = String(idp.email).toLowerCase();
        let u = db.senders[em];
        if (u && u.suspended) return back('This account is suspended. Please contact support.');
        if (!u) { u = db.senders[em] = { name: String(idp.name || em.split('@')[0]).slice(0, 60), email: em, ...makeUser(crypto.randomBytes(24).toString('hex')), google: true }; audit('google-signup', mask(em)); }
        else audit('google-login', mask(em));
        save();
        res.writeHead(302, { Location: '/#gs=' + newSession('sender', em) + '&gn=' + encodeURIComponent(u.name), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      } catch (e) { return back('Google sign-in failed. Please try again.'); }
    }
    if (url === '/api/forgot' && req.method === 'POST') {    // emails a 6-digit code; the answer is the same whether or not the account exists
      const role = b.role === 'po' ? 'po' : 'sender', idRaw = String(b.id || '').trim(), id = role === 'po' ? idRaw : idRaw.toLowerCase();
      if (limited('fg-ip:' + ipOf(req), 8, 3600e3) || limited('fg-id:' + role + id, 3, 900e3)) return send(res, 429, { error: 'Too many requests. Please wait a few minutes and try again.' });
      if (!mailOn()) return send(res, 503, { error: 'Email is not set up on this site yet, so a code cannot be sent. Please contact support.' });
      const acct = role === 'po' ? db.postoffices[id] : db.senders[id];
      if (acct && acct.email) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
        db.resets = db.resets || {}; db.resets[role + ':' + id] = { salt, h: hash(code, salt), exp: Date.now() + 10 * 60e3, tries: 0 };
        audit('reset-requested', role === 'po' ? id : mask(id)); save();
        sendMail(acct.email, 'Your SFAX verification code', 'Your SFAX verification code is ' + code + '. It expires in 10 minutes.\n\nIf you did not ask to reset your password, ignore this email. Nobody can change your password without this code.').catch(() => {});
      }
      return send(res, 200, { ok: true });
    }
    if (url === '/api/reset' && req.method === 'POST') {     // checks the code, then sets the new password and ends all old logins
      const role = b.role === 'po' ? 'po' : 'sender', idRaw = String(b.id || '').trim(), id = role === 'po' ? idRaw : idRaw.toLowerCase(), pw = String(b.password || '');
      if (limited('rs-ip:' + ipOf(req), 20, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      if (pw.length < 8) return send(res, 400, { error: 'Choose a new password of at least 8 characters.' });
      const key = role + ':' + id, r = (db.resets || {})[key], acct = role === 'po' ? db.postoffices[id] : db.senders[id];
      const bad = () => send(res, 400, { error: 'That code is not correct or has expired. Ask for a new code.' });
      if (!r || !acct) return bad();
      if (r.exp < Date.now() || r.tries >= 5) { delete db.resets[key]; save(); return bad(); }
      r.tries++;
      const code = String(b.code || '');
      if (!/^[0-9]{6,8}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(hash(code, r.salt), 'hex'), Buffer.from(r.h, 'hex'))) { save(); return bad(); }
      Object.assign(acct, makeUser(pw)); acct.pwAt = Date.now(); delete db.resets[key];
      audit('password-reset', role === 'po' ? id : mask(id)); save();
      if (acct.email) sendMail(acct.email, 'Your SFAX password was changed', 'The password for your SFAX account was just changed. If this was not you, contact support right away.').catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (url === '/api/sender/me' && req.method === 'GET') { const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' }); const u = db.senders[s.id]; return send(res, 200, { email: u.email, twofa: !!u.twofa, google: !!u.google, mail: mailOn() }); }
    if (url === '/api/po/me' && req.method === 'GET') {      // a post office sees whether it has a recovery email on file
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      const po = db.postoffices[s.id];
      return send(res, 200, { code: po.code, hasEmail: !!po.email, email: po.email ? mask(po.email) : '', hasKey: !!po.publicKey, twofa: !!po.twofa, mail: mailOn() });
    }
    if (url === '/api/po/email' && req.method === 'POST') {   // add or change the recovery email (the password must be confirmed)
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      const po = db.postoffices[s.id], em = String(b.email || '').trim().toLowerCase();
      if (limited('poem:' + s.id, 5, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait a while and try again.' });
      if (!emailOk(em)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (!checkPw(po, String(b.password || ''))) return send(res, 403, { error: 'That password is not correct.' });
      po.email = em; audit('po-email-set', 'po ' + po.code); save();
      return send(res, 200, { ok: true });
    }
    if (url.startsWith('/api/admin/')) {                      // the admin: ONE account (email + password + emailed code), or the owner's ADMIN_TOKEN
      const A = db.admin, sess = () => ({ token: newSession('admin', 'admin', 8 * 3600e3) });
      if (url === '/api/admin/status' && req.method === 'GET') return send(res, 200, { setup: !!A, mail: mailOn() });
      if (url === '/api/admin/setup' && req.method === 'POST') {   // first-time setup, once: proves you own the server with ADMIN_TOKEN
        if (limited('adm-setup:' + ipOf(req), 10, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait an hour.' });
        if (A) return send(res, 409, { error: 'The admin account already exists. Please login.' });
        const em = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
        if (!safeEq(b.token || '', ADMIN_TOKEN)) return send(res, 403, { error: 'The ADMIN_TOKEN is not correct. It is the value set on Render.' });
        if (!emailOk(em) || pw.length < 10) return send(res, 400, { error: 'Enter your email and a password of at least 10 characters.' });
        db.admin = { email: em, ...makeUser(pw), pwAt: Date.now() }; audit('admin-created', mask(em)); save();
        return send(res, 200, sess());
      }
      if (url === '/api/admin/login' && req.method === 'POST') {
        if (limited('adm-ip:' + ipOf(req), 20, 600e3) || limited('adm-id', 10, 900e3)) return send(res, 429, { error: 'Too many login attempts. Please wait a few minutes and try again.' });
        if (!A || String(b.email || '').trim().toLowerCase() !== A.email || !checkPw(A, String(b.password || ''))) { audit('admin-login-failed', ''); return send(res, 401, { error: 'Wrong email or password.' }); }
        if (mailOn()) {                                      // second step: a code sent to the admin's email
          const code = putOtp('admin-login', 10 * 60e3);
          if (!(await sendMail(A.email, 'Your SFAX admin login code', 'Your SFAX admin login code is ' + code + '. It expires in 10 minutes.\n\nIf this was not you, someone knows your password: change it right away.'))) return send(res, 502, { error: 'The login code could not be emailed: ' + mailState.error + ' If you are locked out, use "Lost access?" with your ADMIN_TOKEN.' });
          return send(res, 200, { need2fa: true, email: mask(A.email) });
        }
        audit('admin-login', 'no email code (email not set up)'); return send(res, 200, { ...sess(), noMail: true });
      }
      if (url === '/api/admin/verify' && req.method === 'POST') {
        if (limited('adm-v-ip:' + ipOf(req), 20, 600e3)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
        if (!A || !checkOtp('admin-login', String(b.code || '').trim())) return send(res, 401, { error: 'That code is not correct or has expired. Login again to get a new code.' });
        audit('admin-login', 'ok'); return send(res, 200, sess());
      }
      if (url === '/api/admin/forgot' && req.method === 'POST') {   // same answer whether or not the email matches
        if (limited('adm-fg-ip:' + ipOf(req), 5, 3600e3) || limited('adm-fg', 5, 3600e3)) return send(res, 429, { error: 'Too many requests. Please wait a while and try again.' });
        if (!mailOn()) return send(res, 503, { error: 'Email is not set up on this site, so a code cannot be sent. Use "Lost access?" with your ADMIN_TOKEN.' });
        if (A && String(b.email || '').trim().toLowerCase() === A.email) {
          const code = putOtp('admin-reset', 10 * 60e3); audit('admin-reset-requested', '');
          sendMail(A.email, 'Your SFAX admin password code', 'Your SFAX admin password reset code is ' + code + '. It expires in 10 minutes. If you did not ask for it, ignore this email.').catch(() => {});
        }
        return send(res, 200, { ok: true });
      }
      if (url === '/api/admin/reset' && req.method === 'POST') {
        if (limited('adm-rs-ip:' + ipOf(req), 20, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait a while and try again.' });
        const pw = String(b.password || ''); if (pw.length < 10) return send(res, 400, { error: 'Choose a new password of at least 10 characters.' });
        if (!A || String(b.email || '').trim().toLowerCase() !== A.email || !checkOtp('admin-reset', String(b.code || '').trim())) return send(res, 400, { error: 'That code is not correct or has expired. Ask for a new code.' });
        Object.assign(A, makeUser(pw)); A.pwAt = Date.now(); audit('admin-password-reset', ''); save(); return send(res, 200, { ok: true });
      }
      if (url === '/api/admin/recover' && req.method === 'POST') {   // lost access: the ADMIN_TOKEN owner can replace the one admin account
        if (limited('adm-rc-ip:' + ipOf(req), 10, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait an hour.' });
        if (!safeEq(b.token || '', ADMIN_TOKEN)) return send(res, 403, { error: 'The ADMIN_TOKEN is not correct.' });
        const em = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
        if (!emailOk(em) || pw.length < 10) return send(res, 400, { error: 'Enter your email and a new password of at least 10 characters.' });
        db.admin = { email: em, ...makeUser(pw), pwAt: Date.now() }; audit('admin-recovered', mask(em)); save(); return send(res, 200, sess());
      }
      if (!adminOk(req)) return send(res, 403, { error: 'Not allowed.' });
      if (url === '/api/admin/stats' && req.method === 'GET') {
        const ms = db.messages, waiting = (m) => !!(m.enc && m.enc.rk && !m.enc.wk);
        return send(res, 200, {
          senders: Object.keys(db.senders).length,
          totals: { messages: ms.length, waiting: ms.filter(waiting).length, sealed: ms.filter(m => !m.printed && !waiting(m)).length, printed: ms.filter(m => m.printed).length },
          postOffices: Object.values(db.postoffices).map(p => ({ code: p.code, appKey: !!p.publicKey, email: !!p.email, toPrint: ms.filter(m => m.code === p.code && !m.printed).length, waiting: ms.filter(m => m.code === p.code && waiting(m)).length, printed: ms.filter(m => m.code === p.code && m.printed).length })),
          audit: (db.audit || []).slice(-50).reverse(),
          config: { mail: mailOn(), google: googleOn(), mailState, helpOpen: (db.help || []).filter(h => h.open).length, adminEmail: db.admin ? db.admin.email : '', via: tokenOk(req) ? 'token' : 'login', relay: !!RELAY, minApp: MIN_APP, downloadLink: !!APP_URL, retainPrintedDays: RETAIN_PRINTED_DAYS, expireUnprintedDays: EXPIRE_UNPRINTED_DAYS },
          uptimeSeconds: Math.round(process.uptime()) });
      }
      if (url === '/api/admin/backup' && req.method === 'GET') {      // full copy of the database (contains password hashes and locked keys: keep it private)
        audit('backup-downloaded', 'admin');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="sfax-backup-' + new Date().toISOString().slice(0, 10) + '.json"', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(db));
      }
      if (url === '/api/admin/po-reset-code' && req.method === 'POST') {   // for a post office with no recovery email: after you have checked who they are, give them this one-time code
        const po = db.postoffices[String(b.code || '').trim()];
        if (!po) return send(res, 404, { error: 'No post office with that PIN.' });
        const code = String(crypto.randomInt(0, 100000000)).padStart(8, '0'), salt = crypto.randomBytes(8).toString('hex');
        db.resets = db.resets || {}; db.resets['po:' + po.code] = { salt, h: hash(code, salt), exp: Date.now() + 24 * 3600e3, tries: 0, admin: true };
        audit('po-reset-code-issued', po.code); save();
        return send(res, 200, { code, expiresInHours: 24 });
      }
      if (url === '/api/admin/po-email' && req.method === 'POST') {   // add a recovery email to a post office that has none
        const po = db.postoffices[String(b.code || '').trim()], em = String(b.email || '').trim().toLowerCase();
        if (!po || !emailOk(em)) return send(res, 400, { error: 'Enter an existing post office code and a valid email.' });
        po.email = em; audit('po-email-set', po.code); save(); return send(res, 200, { ok: true });
      }
      const am0 = url.match(/^\/api\/admin\/escrow\/([A-Za-z0-9]{3,10})$/);
      if (am0 && req.method === 'GET') {                     // key recovery needs the ADMIN_TOKEN itself, not just a login
        if (!tokenOk(req)) return send(res, 403, { error: 'Not allowed.' });
        const po = db.postoffices[am0[1]];
        if (!po || !po.escrow) return send(res, 404, { error: 'No backup stored for this post office.' });
        return send(res, 200, { code: am0[1], publicKey: po.publicKey, fingerprint: po.keyFp, escrow: po.escrow });
      }
      if (url === '/api/admin/accounts' && req.method === 'GET')
        return send(res, 200, { senders: Object.values(db.senders).map(u => ({ id: u.email, name: u.name, suspended: !!u.suspended, twofa: !!u.twofa, google: !!u.google })),
          postOffices: Object.values(db.postoffices).map(p => ({ id: p.code, email: p.email || '', suspended: !!p.suspended, twofa: !!p.twofa, appKey: !!p.publicKey })) });
      if (url === '/api/admin/set-password' && req.method === 'POST') {   // type a new password, or leave it empty to generate one. Old logins end.
        const role = b.role === 'po' ? 'po' : 'sender', acct = getAcct(role, b.id), given = String(b.password || '');
        if (!acct) return send(res, 404, { error: 'No such account.' });
        if (given && given.length < 8) return send(res, 400, { error: 'A password must be at least 8 characters.' });
        const pw = given || genPw(12); Object.assign(acct, makeUser(pw)); acct.pwAt = Date.now();
        audit('admin-set-password', role === 'po' ? acct.code : mask(acct.email)); save();
        return send(res, 200, { ok: true, password: given ? undefined : pw });
      }
      if (url === '/api/admin/suspend' && req.method === 'POST') {
        const role = b.role === 'po' ? 'po' : 'sender', acct = getAcct(role, b.id); if (!acct) return send(res, 404, { error: 'No such account.' });
        acct.suspended = !!b.suspended; audit('admin-' + (acct.suspended ? 'suspend' : 'enable'), role === 'po' ? acct.code : mask(acct.email)); save(); return send(res, 200, { ok: true });
      }
      if (url === '/api/admin/delete' && req.method === 'POST') {          // removes the account and its messages
        const role = b.role === 'po' ? 'po' : 'sender', acct = getAcct(role, b.id); if (!acct) return send(res, 404, { error: 'No such account.' });
        if (role === 'po') { delete db.postoffices[acct.code]; db.messages = db.messages.filter(m => m.code !== acct.code); audit('admin-delete', 'po ' + acct.code); }
        else { delete db.senders[acct.email]; db.messages = db.messages.filter(m => m.email !== acct.email); audit('admin-delete', mask(acct.email)); }
        save(); return send(res, 200, { ok: true });
      }
      if (url === '/api/admin/help' && req.method === 'GET') return send(res, 200, (db.help || []).slice().reverse());
      if (url === '/api/admin/help-resolve' && req.method === 'POST') { const h = (db.help || []).find(x => x.id === b.id); if (!h) return send(res, 404, { error: 'Not found.' }); h.open = false; save(); return send(res, 200, { ok: true }); }
      if (url === '/api/admin/site' && req.method === 'GET') return send(res, 200, { banner: (db.site || {}).banner || '', maintenance: !!(db.site || {}).maintenance, ...Object.fromEntries(Object.keys(SITE_KEYS).map(k => [k, siteVal(k)])) });
      if (url === '/api/admin/site' && req.method === 'POST') {
        db.site = db.site || {};
        if ('banner' in b) db.site.banner = String(b.banner || '').slice(0, 300);
        if ('maintenance' in b) db.site.maintenance = !!b.maintenance;
        for (const k of Object.keys(SITE_KEYS)) if (k in b) db.site[k] = String(b[k] || '').slice(0, k === 'about' ? 600 : 160);
        audit('admin-site-changed', ''); save(); return send(res, 200, { ok: true });
      }
      if (url === '/api/admin/mail-test' && req.method === 'POST') {       // sends a test email and says exactly why it failed, if it did
        const to = String(b.to || (db.admin && db.admin.email) || '').trim().toLowerCase();
        if (!emailOk(to)) return send(res, 400, { error: 'Enter an email address to send the test to.' });
        if (limited('mailtest', 10, 3600e3)) return send(res, 429, { error: 'Too many test emails. Please wait a while.' });
        const ok = await sendMail(to, 'SFAX test email', 'This is a test email from your SFAX website. If you can read it, codes and notifications will reach people.');
        audit('mail-test', ok ? 'sent' : 'failed'); return send(res, 200, { ok, to, error: ok ? '' : mailState.error });
      }
      if (url === '/api/admin/account' && req.method === 'POST') {          // change your own email or password (needs the current password)
        if (!adminSess(req) || !db.admin) return send(res, 403, { error: 'Login with the admin account to change it.' });
        if (!checkPw(db.admin, String(b.current || ''))) return send(res, 403, { error: 'Your current password is not correct.' });
        const em = String(b.email || '').trim().toLowerCase(), np = String(b.newPassword || '');
        if (np && np.length < 10) return send(res, 400, { error: 'The new password must be at least 10 characters.' });
        if (em && !emailOk(em)) return send(res, 400, { error: 'Enter a valid email address.' });
        if (em) db.admin.email = em; if (np) { Object.assign(db.admin, makeUser(np)); db.admin.pwAt = Date.now(); }
        audit('admin-account-changed', ''); save(); return send(res, 200, { ok: true, relogin: !!np });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // ---- Sender ----
    if (url === '/api/sender/register' && req.method === 'POST') {
      const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (limited('reg-ip:' + ipOf(req), 20, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      if (!name || !emailOk(email) || pw.length < 8) return send(res, 400, { error: 'Enter your name, a valid email and a password of at least 8 characters.' });
      if (db.senders[email]) return send(res, 409, { error: 'This email is already registered. Please login.' });
      db.senders[email] = { name, email, ...makeUser(pw) }; save();
      return send(res, 200, { token: newSession('sender', email), name });
    }
    if (url === '/api/sender/login' && req.method === 'POST') {
      const email = String(b.email || '').trim().toLowerCase(), u = db.senders[email];
      if (limited('li-ip:' + ipOf(req), 30, 600e3) || limited('li-id:' + email, 10, 900e3)) return send(res, 429, { error: 'Too many login attempts. Please wait a few minutes and try again.' });
      if (!u || !checkPw(u, String(b.password || ''))) { audit('login-failed', mask(email)); return send(res, 401, { error: 'Wrong email or password. If you forgot it, use "Forgot password".' }); }
      return userLogin(req, res, 'sender', email, u);
    }
    if (url === '/api/messages' && req.method === 'POST') {
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      // The server never sees the message, addresses or emails: they arrive already encrypted (b.enc).
      const t = (k, n) => String(b[k] || '').trim().slice(0, n);
      if ((db.site || {}).maintenance) return send(res, 503, { error: 'SFAX is paused for maintenance. Please try again later.' });
      if (limited('send:' + s.id, 30, 600e3)) return send(res, 429, { error: 'You are sending too fast. Please wait a minute and try again.' });
      const u = db.senders[s.id], pinOk = (p) => /^[1-9][0-9]{5}$/.test(p);
      const to = t('to', 60), code = t('code', 10), enc = b.enc;
      if (!to || !pinOk(code) || !msgEncOk(enc))
        return send(res, 400, { error: 'Enter who it is for, the destination post office PIN (6 digits) and an encrypted message.' });
      const po = db.postoffices[code];
      if (!po) return send(res, 404, { error: 'No post office is registered with PIN ' + code + '.' });
      const rid = String(b.rid || '').slice(0, 64);           // same request sent twice (double click, retry): only one message is kept
      if (rid && db.messages.some(x => x.email === u.email && x.rid === rid)) return send(res, 200, { ok: true, duplicate: true });
      let stored;
      if (enc.wk) {                                          // post office key exists: sealed straight to it
        if (!po.publicKey) return send(res, 409, { error: 'That post office key is not ready yet. Please try again.' });
        stored = { v: 1, iv: enc.iv, ct: enc.ct, wk: enc.wk };
      } else {                                               // app not installed yet: the message waits for it
        if (!RELAY) return send(res, 503, { error: 'Sending before the post office installs the app is not available right now.' });
        stored = { v: 1, iv: enc.iv, ct: enc.ct, rk: { epk: enc.rk.epk, iv: enc.rk.iv, ct: enc.rk.ct } };
      }
      const rec = { id: crypto.randomUUID(), name: u.name, email: u.email, mode: 'po', code, to, enc: stored, rid: rid || undefined, at: Date.now(), printed: false };
      audit('message-sent', mask(u.email) + ' to ' + code);
      if (stored.rk && po.publicKey) rewrap(po, rec);
      db.messages.push(rec);
      save(); return send(res, 200, { ok: true });
    }
    if (url === '/api/messages/mine' && req.method === 'GET') {
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      return send(res, 200, db.messages.filter(m => m.email === s.id).sort((a, c) => c.at - a.at)
        .map(m => ({ id: m.id, mode: m.mode || 'po', code: m.code, to: m.to, printed: m.printed, at: m.at, printedAt: m.printedAt || null, waiting: !!(m.enc && m.enc.rk && !m.enc.wk) })));
    }

    // ---- Post office ----
    if (url === '/api/po/register' && req.method === 'POST') {
      const code = String(b.code || '').trim(), pw = String(b.password || '');
      if (limited('reg-ip:' + ipOf(req), 20, 3600e3)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      if (!codeOk(code) || pw.length < 8) return send(res, 400, { error: 'Enter a valid post office code and a password of at least 8 characters.' });
      if (db.postoffices[code]) return send(res, 409, { error: 'This post office code is already registered. Please login.' });
      db.postoffices[code] = { code, ...makeUser(pw), email: emailOk(String(b.email || '').trim().toLowerCase()) ? String(b.email).trim().toLowerCase() : '' }; audit('po-registered', code); save();
      return send(res, 200, { token: newSession('po', code), code });
    }
    if (url === '/api/po/login' && req.method === 'POST') {
      const code = String(b.code || '').trim(), u = db.postoffices[code];
      if (limited('li-ip:' + ipOf(req), 30, 600e3) || limited('li-id:po' + code, 10, 900e3)) return send(res, 429, { error: 'Too many login attempts. Please wait a few minutes and try again.' });
      if (!u || !checkPw(u, String(b.password || ''))) { audit('login-failed', 'po ' + code); return send(res, 401, { error: 'Wrong code or password. If you forgot it, use "Forgot password".' }); }
      return userLogin(req, res, 'po', code, u);
    }
    if (url === '/api/app-info' && req.method === 'GET') return send(res, 200, { url: APP_URL, version: MIN_APP });   // for the download popup
    if (url === '/api/escrow-key' && req.method === 'GET')   // public half of the owner's backup key
      return send(res, 200, { publicKey: ESCROW_PUB, fingerprint: ESCROW_PUB ? fpOf(ESCROW_PUB) : '' });
    if (url === '/api/po/key' && req.method === 'POST') {    // the SFAX Print app registers its public key + encrypted backup (set once)
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      const po = db.postoffices[s.id];
      if (!ESCROW_PUB) return send(res, 503, { error: 'The backup key is not configured on the server (ESCROW_PUBLIC_KEY).' });
      if (po.publicKey) return send(res, 409, { error: 'A key is already registered for this post office. Contact the SFAX owner for recovery.' });
      if (!b64ok(b.publicKey, 1000) || !encOk(b.escrow)) return send(res, 400, { error: 'Invalid key data.' });
      po.publicKey = b.publicKey; po.keyFp = fpOf(b.publicKey); po.escrow = { v: 1, iv: b.escrow.iv, ct: b.escrow.ct, wk: b.escrow.wk };
      for (const m of db.messages) if (m.code === s.id) rewrap(po, m);   // messages that were waiting for this app
      save();
      return send(res, 200, { ok: true, fingerprint: po.keyFp });
    }
    const km = url.match(/^\/api\/po\/key\/([A-Za-z0-9]{3,10})$/);
    if (km && req.method === 'GET') {                        // senders fetch the post office's public key to encrypt to it
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      const po = db.postoffices[km[1]];
      if (!po) return send(res, 404, { error: 'No post office is registered with PIN ' + km[1] + '.' });
      if (!po.publicKey) {                                   // app not installed yet: sender seals to the relay key, message waits
        if (!RELAY) return send(res, 409, { error: 'This post office has not set up the SFAX Print app yet.' });
        return send(res, 200, { pending: true, relayKey: RELAY.pub });
      }
      return send(res, 200, { publicKey: po.publicKey, fingerprint: po.keyFp });
    }
    if (url === '/api/inbox' && req.method === 'GET') {   // only sender NAME is revealed here
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      return send(res, 200, db.messages.filter(m => m.code === s.id).sort((a, c) => c.at - a.at)
        .map(m => ({ id: m.id, name: m.name, printed: m.printed, at: m.at, printedAt: m.printedAt || null, code: m.code })));
    }
    const xm = url.match(/^\/api\/messages\/([\w-]+)\/cancel$/);
    if (xm && req.method === 'POST') {                       // a sender can cancel a message until it has been printed
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      const i = db.messages.findIndex(x => x.id === xm[1] && x.email === s.id);
      if (i < 0) return send(res, 404, { error: 'Message not found.' });
      if (db.messages[i].printed) return send(res, 409, { error: 'This message has already been printed, so it can no longer be cancelled.' });
      db.messages.splice(i, 1); audit('message-cancelled', mask(s.id)); save();
      return send(res, 200, { ok: true });
    }
    const cm = url.match(/^\/api\/inbox\/([\w-]+)\/cipher$/);
    if (cm && req.method === 'GET') {                        // still encrypted: only the SFAX Print app holds the key to open it
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      if (!appOk(req)) return needApp(res);
      const m = db.messages.find(x => x.id === cm[1] && x.code === s.id);
      if (!m) return send(res, 404, { error: 'Message not found.' });
      const po = db.postoffices[s.id];
      if (m.enc.rk && !m.enc.wk && rewrap(po, m)) save();
      if (!m.enc.wk) return send(res, 409, { error: 'This message is not ready yet. Set up the app key first.' });
      return send(res, 200, { id: m.id, name: m.name, code: m.code, at: m.at, enc: m.enc });
    }
    const pm = url.match(/^\/api\/inbox\/([\w-]+)\/printed$/);
    if (pm && req.method === 'POST') {                       // the app reports a successful print
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      if (!appOk(req)) return needApp(res);
      const m = db.messages.find(x => x.id === pm[1] && x.code === s.id);
      if (!m) return send(res, 404, { error: 'Message not found.' });
      m.printed = true; m.printedAt = Date.now(); audit('printed', 'po ' + s.id + ' ' + m.id.slice(0, 8)); save();
      const snd = db.senders[m.email];
      if (snd && mailOn() && snd.notify !== false) sendMail(snd.email, 'Your SFAX message was printed', 'Your message for ' + m.to + ' was printed at post office ' + m.code + '.\n\nSign in to SFAX to see its status.').catch(() => {});
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 400, { error: e.message || 'Bad request' }); }
});
loadDb()
  .then(() => { purge(); setInterval(purge, 3600e3).unref(); })
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log('SFAX running on http://localhost:' + PORT + (REMOTE ? ' (online database)' : ' (local file)'))))
  .catch(e => { console.error('Could not load database:', e.message); process.exit(1); });
