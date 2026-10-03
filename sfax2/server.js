// SFAX server - uses only built-in Node.js modules (no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

let db = { senders: {}, postoffices: {}, messages: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const sessions = new Map(); // token -> { role, id }

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const makeUser = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: hash(pw, salt) }; };
const checkPw = (u, pw) => u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(hash(pw, u.salt), 'hex'));
const newSession = (role, id) => { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, { role, id }); return t; };

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => {
  let d = ''; req.on('data', c => { d += c; if (d.length > 100000) { no(new Error('Too large')); req.destroy(); } });
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(new Error('Bad JSON')); } });
});
const auth = (req, role) => {
  const s = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  return s && s.role === role ? s : null;
};
const emailOk = (e) => /^\S+@\S+\.\S+$/.test(e);
const codeOk = (c) => /^[A-Za-z0-9]{3,10}$/.test(c);

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
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
      const code = String(b.code || '').trim(), message = String(b.message || '').trim(), to = String(b.to || '').trim().slice(0, 60);
      const occasions = ['Just because', 'Birthday', 'I love you', 'I miss you', 'Thank you', 'I am sorry', 'Congratulations'];
      const occasion = occasions.includes(b.occasion) ? b.occasion : 'Just because';
      if (!codeOk(code) || !message || !to) return send(res, 400, { error: 'Enter who it is for, a valid post office code and a message.' });
      if (!db.postoffices[code]) return send(res, 404, { error: 'No post office is registered with code ' + code + '.' });
      const u = db.senders[s.id];
      db.messages.push({ id: crypto.randomUUID(), name: u.name, email: u.email, code, to, occasion, message: message.slice(0, 2000), at: Date.now(), printed: false });
      save(); return send(res, 200, { ok: true });
    }
    if (url === '/api/messages/mine' && req.method === 'GET') {
      const s = auth(req, 'sender'); if (!s) return send(res, 401, { error: 'Please login again.' });
      return send(res, 200, db.messages.filter(m => m.email === s.id).sort((a, c) => c.at - a.at)
        .map(m => ({ id: m.id, code: m.code, to: m.to, occasion: m.occasion, printed: m.printed })));
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
    if (url === '/api/inbox' && req.method === 'GET') {   // only sender NAME is revealed here
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      return send(res, 200, db.messages.filter(m => m.code === s.id).sort((a, c) => c.at - a.at)
        .map(m => ({ id: m.id, name: m.name, printed: m.printed })));
    }
    const pm = url.match(/^\/api\/inbox\/([\w-]+)\/print$/);
    if (pm && req.method === 'POST') {                    // full message only released when printing
      const s = auth(req, 'po'); if (!s) return send(res, 401, { error: 'Please login again.' });
      const m = db.messages.find(x => x.id === pm[1] && x.code === s.id);
      if (!m) return send(res, 404, { error: 'Message not found.' });
      m.printed = true; m.printedAt = Date.now(); save();
      return send(res, 200, { name: m.name, to: m.to, occasion: m.occasion, code: m.code, message: m.message, at: m.at });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 400, { error: e.message || 'Bad request' }); }
}).listen(PORT, '0.0.0.0', () => console.log('SFAX running on http://localhost:' + PORT));
