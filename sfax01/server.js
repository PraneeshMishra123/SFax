// SFAX server - uses only built-in Node.js modules (no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
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
const newSession = (role, id) => { const p = Buffer.from(JSON.stringify({ role, id, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return p + '.' + sign(p); };

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 100000) { no(new Error('Too large')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(new Error('Bad JSON')); } });
});
const auth = (req, role) => {
  const [p, sig] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (!p || !sig || sig.length !== sign(p).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(p)))) return null;
  try { const s = JSON.parse(Buffer.from(p, 'base64url').toString()); return s.role === role && s.exp > Date.now() ? s : null; } catch (e) { return null; }
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
const fpOf = (spki) => crypto.createHash('sha256').update(Buffer.from(spki, 'base64')).digest('hex').slice(0, 32).replace(/(.{4})/g, '$1 ').trim();

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (!url.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    const b = req.method === 'POST' ? await readBody(req) : {};

    // ---- Sender ----
    if (url === '/api/sender/register' && req.method === 'POST') {
      const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (!name || !emailOk(email) || pw.length < 4) return send(res, 400, { error: 'Enter name, a valid email and a password (min 4 characters).' });
      if (db.senders[email]) return send(res, 409, { error: 'This email is already registered. Please login.' });
      db.senders[email] = { name, email, ...makeUser(pw) }; save();
      return send(res, 200, { token: newSession('sender', email), name });
    }
    if (url === '/api/sender/login' && req.method === 'POST') {
      const email = String(b.email || '').trim().toLowerCase(), u = db.senders[email];
      if (!u || !checkPw(u, String(b.password || ''))) return send(res, 401, { error: 'Wrong email or password.' });
      return send(res, 200, { token: newSession('sender', email), name: u.name });
    }
    if (url === '/api/messages' && req.method === 'POST') {
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      // The server never sees the message, addresses or emails: they arrive already encrypted (b.enc).
      const t = (k, n) => String(b[k] || '').trim().slice(0, n);
      const u = db.senders[s.id], pinOk = (p) => /^[1-9][0-9]{5}$/.test(p);
      const to = t('to', 60), code = t('code', 10), enc = b.enc;
      if (!to || !pinOk(code) || !encOk(enc))
        return send(res, 400, { error: 'Enter who it is for, the destination post office PIN (6 digits) and an encrypted message.' });
      const po = db.postoffices[code];
      if (!po) return send(res, 404, { error: 'No post office is registered with PIN ' + code + '.' });
      if (!po.publicKey) return send(res, 409, { error: 'This post office has not set up the SFAX Print app yet, so it cannot receive messages.' });
      db.messages.push({ id: crypto.randomUUID(), name: u.name, email: u.email, mode: 'po', code, to, enc: { v: 1, iv: enc.iv, ct: enc.ct, wk: enc.wk }, at: Date.now(), printed: false });
      save(); return send(res, 200, { ok: true });
    }
    if (url === '/api/messages/mine' && req.method === 'GET') {
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      return send(res, 200, db.messages.filter(m => m.email === s.id).sort((a, c) => c.at - a.at)
        .map(m => ({ id: m.id, mode: m.mode || 'po', code: m.code, to: m.to, printed: m.printed, at: m.at, printedAt: m.printedAt || null })));
    }

    // ---- Post office ----
    if (url === '/api/po/register' && req.method === 'POST') {
      const code = String(b.code || '').trim(), pw = String(b.password || '');
      if (!codeOk(code) || pw.length < 4) return send(res, 400, { error: 'Enter a valid post office code and a password (min 4 characters).' });
      if (db.postoffices[code]) return send(res, 409, { error: 'This post office code is already registered. Please login.' });
      db.postoffices[code] = { code, ...makeUser(pw) }; save();
      return send(res, 200, { token: newSession('po', code), code });
    }
    if (url === '/api/po/login' && req.method === 'POST') {
      const code = String(b.code || '').trim(), u = db.postoffices[code];
      if (!u || !checkPw(u, String(b.password || ''))) return send(res, 401, { error: 'Wrong code or password.' });
      return send(res, 200, { token: newSession('po', code), code });
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
      po.publicKey = b.publicKey; po.keyFp = fpOf(b.publicKey); po.escrow = { v: 1, iv: b.escrow.iv, ct: b.escrow.ct, wk: b.escrow.wk }; save();
      return send(res, 200, { ok: true, fingerprint: po.keyFp });
    }
    const km = url.match(/^\/api\/po\/key\/([A-Za-z0-9]{3,10})$/);
    if (km && req.method === 'GET') {                        // senders fetch the post office's public key to encrypt to it
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      const po = db.postoffices[km[1]];
      if (!po) return send(res, 404, { error: 'No post office is registered with PIN ' + km[1] + '.' });
      if (!po.publicKey) return send(res, 409, { error: 'This post office has not set up the SFAX Print app yet, so it cannot receive messages.' });
      return send(res, 200, { publicKey: po.publicKey, fingerprint: po.keyFp });
    }
    const am = url.match(/^\/api\/admin\/escrow\/([A-Za-z0-9]{3,10})$/);
    if (am && req.method === 'GET') {                        // owner-only export of the encrypted backup (useless without the offline master key)
      const given = Buffer.from(String(req.headers['x-admin-token'] || '')), want = Buffer.from(ADMIN_TOKEN);
      if (!ADMIN_TOKEN || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 403, { error: 'Not allowed.' });
      const po = db.postoffices[am[1]];
      if (!po || !po.escrow) return send(res, 404, { error: 'No backup stored for this post office.' });
      return send(res, 200, { code: am[1], publicKey: po.publicKey, fingerprint: po.keyFp, escrow: po.escrow });
    }
    if (url === '/api/inbox' && req.method === 'GET') {   // only sender NAME is revealed here
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      return send(res, 200, db.messages.filter(m => m.code === s.id).sort((a, c) => c.at - a.at)
        .map(m => ({ id: m.id, name: m.name, printed: m.printed, at: m.at, printedAt: m.printedAt || null, code: m.code })));
    }
    const cm = url.match(/^\/api\/inbox\/([\w-]+)\/cipher$/);
    if (cm && req.method === 'GET') {                        // still encrypted: only the SFAX Print app holds the key to open it
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      if (!appOk(req)) return needApp(res);
      const m = db.messages.find(x => x.id === cm[1] && x.code === s.id);
      if (!m) return send(res, 404, { error: 'Message not found.' });
      return send(res, 200, { id: m.id, name: m.name, code: m.code, at: m.at, enc: m.enc });
    }
    const pm = url.match(/^\/api\/inbox\/([\w-]+)\/printed$/);
    if (pm && req.method === 'POST') {                       // the app reports a successful print
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      if (!appOk(req)) return needApp(res);
      const m = db.messages.find(x => x.id === pm[1] && x.code === s.id);
      if (!m) return send(res, 404, { error: 'Message not found.' });
      m.printed = true; m.printedAt = Date.now(); save();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 400, { error: e.message || 'Bad request' }); }
});
loadDb()
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log('SFAX running on http://localhost:' + PORT + (REMOTE ? ' (online database)' : ' (local file)'))))
  .catch(e => { console.error('Could not load database:', e.message); process.exit(1); });
