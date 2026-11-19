// Run: node tests/api-test.js   (starts its own server and a fake email service; nothing external is touched)
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..');
let fails = 0; const ok = (name, c) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + name); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mails = []; const mailSrv = http.createServer((q, r) => { let d = ''; q.on('data', c => d += c); q.on('end', () => { try { const j = JSON.parse(d); mails.push({ to: (j.to[0].email || j.to[0]), subject: j.subject, text: j.textContent || j.text }); } catch (e) {} r.end('{}'); }); });
function start(port, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfax-')); const file = path.join(dir, 'data.json');
  if (env.SEED) { fs.writeFileSync(file, JSON.stringify(env.SEED)); delete env.SEED; }
  const p = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: port, DATA_FILE: file, UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', ...env }, stdio: 'ignore' });
  return { p, file, base: 'http://localhost:' + port };
}
const call = async (base, method, p, body, token, extra) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(extra || {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})), h: r.headers }; };
const FAKE = { iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0g=', rk: { epk: 'QUJDREVGR0g=', iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJDREVGR0hJSktMTU5PUA==' } };
(async () => {
  await new Promise(r => mailSrv.listen(0, r)); const mport = mailSrv.address().port;
  const A = start(4811, { SESSION_SECRET: 'test-session-secret-0123456789', ADMIN_TOKEN: 'adm-token', MAIL_FROM: 'noreply@example.com', BREVO_API_KEY: 'k', MAIL_API_URL: 'http://localhost:' + mport, SUPPORT_EMAIL: 'help@example.com', ESCROW_PUBLIC_KEY: 'QUJD' });
  const B = start(4812, { SESSION_SECRET: 'x'.repeat(24) });   // no email configured
  const old = Date.now() - 200 * 864e5;
  const C = start(4813, { SESSION_SECRET: 'x'.repeat(24), SEED: { senders: {}, postoffices: {}, messages: [
    { id: 'old-printed', code: '500016', email: 'a@x.com', printed: true, printedAt: old, at: old },
    { id: 'old-unprinted', code: '500016', email: 'a@x.com', printed: false, at: old },
    { id: 'recent', code: '500016', email: 'a@x.com', printed: false, at: Date.now() - 1000 }] } });
  await sleep(1800); const a = A.base;
  try {
    // --- headers, compression, caching
    const home = await fetch(a + '/', { headers: { 'Accept-Encoding': 'gzip' } });
    ok('home page has CSP, nosniff and frame protection', /default-src/.test(home.headers.get('content-security-policy') || '') && home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('x-frame-options') === 'DENY');
    ok('home page is gzip compressed', home.headers.get('content-encoding') === 'gzip');
    ok('API answers are never cached', (await call(a, 'GET', '/api/site-info')).h.get('cache-control') === 'no-store');
    const si = (await call(a, 'GET', '/api/site-info')).j; ok('site-info shows support email from settings', si.email === 'help@example.com' && si.mail === true);
    // --- accounts and passwords
    ok('short password rejected at sign-up', (await call(a, 'POST', '/api/sender/register', { name: 'R', email: 'r@x.com', password: 'short' })).s === 400);
    const r1 = await call(a, 'POST', '/api/sender/register', { name: 'Rahul', email: 'r@x.com', password: 'password-one' }); const T = r1.j.token; ok('sender registers', r1.s === 200);
    const r2 = await call(a, 'POST', '/api/sender/register', { name: 'Other', email: 'o@x.com', password: 'password-two' }); const T2 = r2.j.token;
    const po = await call(a, 'POST', '/api/po/register', { code: '500016', password: 'po-password-1', email: 'po16@x.com' }); const PT = po.j.token; ok('post office registers with email', po.s === 200);
    const po2 = await call(a, 'POST', '/api/po/register', { code: '500081', password: 'po-password-2' }); const PT2 = po2.j.token;
    // --- authorization
    ok('no token is refused', (await call(a, 'GET', '/api/messages/mine')).s === 401);
    ok('sender token cannot use post office endpoints', (await call(a, 'GET', '/api/inbox', null, T)).s === 401);
    ok('post office token cannot use sender endpoints', (await call(a, 'GET', '/api/messages/mine', null, PT)).s === 401);
    ok('tampered token is refused', (await call(a, 'GET', '/api/messages/mine', null, T.slice(0, -3) + 'abc')).s === 401);
    // --- sending, duplicates, cancel
    const m1 = await call(a, 'POST', '/api/messages', { to: 'Priya', code: '500016', rid: 'req-1', enc: FAKE }, T); ok('message accepted (waiting for app)', m1.s === 200);
    const m1b = await call(a, 'POST', '/api/messages', { to: 'Priya', code: '500016', rid: 'req-1', enc: FAKE }, T); ok('same request sent twice is kept once', m1b.j.duplicate === true);
    let mine = (await call(a, 'GET', '/api/messages/mine', null, T)).j; ok('sender sees exactly 1 message', mine.length === 1 && mine[0].waiting === true);
    const id = mine[0].id;
    ok("another sender cannot cancel someone else's message", (await call(a, 'POST', '/api/messages/' + id + '/cancel', {}, T2)).s === 404);
    const other = (await call(a, 'POST', '/api/messages', { to: 'Zed', code: '500081', rid: 'req-2', enc: FAKE }, T)).s; ok('second message accepted', other === 200);
    ok("post office cannot read another post office's message cipher", (await call(a, 'GET', '/api/inbox/' + id + '/cipher', null, PT2)).s === 404);
    ok('sender cancels an unprinted message', (await call(a, 'POST', '/api/messages/' + id + '/cancel', {}, T)).s === 200);
    ok('cancelled message is gone from the post office inbox', (await call(a, 'GET', '/api/inbox', null, PT)).j.length === 0);
    // --- printed -> email notification, no cancel after printing
    const inb2 = (await call(a, 'GET', '/api/inbox', null, PT2)).j; mails.length = 0;
    ok('post office marks printed', (await call(a, 'POST', '/api/inbox/' + inb2[0].id + '/printed', {}, PT2)).s === 200); await sleep(300);
    ok('sender gets a "printed" email without the message', mails.some(m => m.to === 'r@x.com' && /printed/i.test(m.subject)));
    ok('printed message cannot be cancelled', (await call(a, 'POST', '/api/messages/' + inb2[0].id + '/cancel', {}, T)).s === 409);
    // --- forgot / reset password (sender)
    mails.length = 0; const f0 = await call(a, 'POST', '/api/forgot', { role: 'sender', id: 'nobody@x.com' }); await sleep(200);
    ok('unknown email gets the same answer and no email is sent', f0.s === 200 && mails.length === 0);
    await call(a, 'POST', '/api/forgot', { role: 'sender', id: 'r@x.com' }); await sleep(300);
    const code = (mails.find(m => m.to === 'r@x.com' && /code/i.test(m.subject)) || { text: '' }).text.match(/\b(\d{6})\b/); ok('a 6-digit code was emailed', !!code);
    ok('wrong code is refused', (await call(a, 'POST', '/api/reset', { role: 'sender', id: 'r@x.com', code: '000000' === code[1] ? '111111' : '000000', password: 'new-password-1' })).s === 400);
    ok('weak new password is refused', (await call(a, 'POST', '/api/reset', { role: 'sender', id: 'r@x.com', code: code[1], password: 'short' })).s === 400);
    ok('correct code changes the password', (await call(a, 'POST', '/api/reset', { role: 'sender', id: 'r@x.com', code: code[1], password: 'new-password-1' })).s === 200);
    ok('old password no longer works', (await call(a, 'POST', '/api/sender/login', { email: 'r@x.com', password: 'password-one' })).s === 401);
    ok('new password works', (await call(a, 'POST', '/api/sender/login', { email: 'r@x.com', password: 'new-password-1' })).s === 200);
    ok('old logged-in session is ended by the reset', (await call(a, 'GET', '/api/messages/mine', null, T)).s === 401);
    ok('code cannot be used twice', (await call(a, 'POST', '/api/reset', { role: 'sender', id: 'r@x.com', code: code[1], password: 'another-pass-1' })).s === 400);
    // five wrong guesses lock the code
    mails.length = 0; await call(a, 'POST', '/api/forgot', { role: 'sender', id: 'o@x.com' }); await sleep(300);
    const c2 = (mails.find(m => m.to === 'o@x.com') || { text: '' }).text.match(/\b(\d{6})\b/)[1]; const wrong = c2 === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await call(a, 'POST', '/api/reset', { role: 'sender', id: 'o@x.com', code: wrong, password: 'new-password-2' });
    ok('after 5 wrong tries even the right code is refused', (await call(a, 'POST', '/api/reset', { role: 'sender', id: 'o@x.com', code: c2, password: 'new-password-2' })).s === 400);
    // post office reset
    mails.length = 0; await call(a, 'POST', '/api/forgot', { role: 'po', id: '500016' }); await sleep(300);
    const pc = (mails.find(m => m.to === 'po16@x.com') || { text: '' }).text.match(/\b(\d{6})\b/); ok('post office with an email gets a code', !!pc);
    ok('post office password reset works', pc && (await call(a, 'POST', '/api/reset', { role: 'po', id: '500016', code: pc[1], password: 'po-new-pass-1' })).s === 200 && (await call(a, 'POST', '/api/po/login', { code: '500016', password: 'po-new-pass-1' })).s === 200);
    // post office WITHOUT email: support code issued by the owner
    ok('post office with no email: forgot sends nothing and looks the same', (mails.length = 0, (await call(a, 'POST', '/api/forgot', { role: 'po', id: '500081' })).s === 200) && (await sleep(200), mails.length === 0));
    ok('reset code endpoint needs the admin token', (await call(a, 'POST', '/api/admin/po-reset-code', { code: '500081' })).s === 403);
    ok('reset code for an unknown post office is refused', (await call(a, 'POST', '/api/admin/po-reset-code', { code: '999999' }, null, { 'x-admin-token': 'adm-token' })).s === 404);
    const sc = (await call(a, 'POST', '/api/admin/po-reset-code', { code: '500081' }, null, { 'x-admin-token': 'adm-token' })).j; ok('owner gets an 8-digit one-time code', /^[0-9]{8}$/.test(sc.code || ''));
    ok('a wrong 8-digit code is refused', (await call(a, 'POST', '/api/reset', { role: 'po', id: '500081', code: sc.code === '00000000' ? '11111111' : '00000000', password: 'po-new-pass-2' })).s === 400);
    ok('the support code resets the password of a post office with no email', (await call(a, 'POST', '/api/reset', { role: 'po', id: '500081', code: sc.code, password: 'po-new-pass-2' })).s === 200 && (await call(a, 'POST', '/api/po/login', { code: '500081', password: 'po-new-pass-2' })).s === 200);
    ok('the support code works only once', (await call(a, 'POST', '/api/reset', { role: 'po', id: '500081', code: sc.code, password: 'po-new-pass-3' })).s === 400);
    ok('old post office session ended by the reset', (await call(a, 'GET', '/api/inbox', null, PT2)).s === 401);
    // post office adds its own recovery email
    const PT3 = (await call(a, 'POST', '/api/po/login', { code: '500081', password: 'po-new-pass-2' })).j.token;
    ok('post office with no email is told so', (await call(a, 'GET', '/api/po/me', null, PT3)).j.hasEmail === false);
    ok('adding an email needs the current password', (await call(a, 'POST', '/api/po/email', { email: 'po81@x.com', password: 'wrong-password' }, PT3)).s === 403);
    ok('post office saves a recovery email', (await call(a, 'POST', '/api/po/email', { email: 'po81@x.com', password: 'po-new-pass-2' }, PT3)).s === 200);
    const me = (await call(a, 'GET', '/api/po/me', null, PT3)).j; ok('the email is shown only masked', me.hasEmail && me.email === 'p***@x.com');
    mails.length = 0; await call(a, 'POST', '/api/forgot', { role: 'po', id: '500081' }); await sleep(300); ok('after that, forgot password emails a code to the post office', mails.some(m => m.to === 'po81@x.com'));
    // forgot is rate limited
    const lim = []; for (let i = 0; i < 4; i++) lim.push((await call(a, 'POST', '/api/forgot', { role: 'sender', id: 'rate@x.com' })).s); ok('too many code requests are limited (429)', lim.includes(429));
    ok('without email settings the server says so (503)', (await call(B.base, 'POST', '/api/forgot', { role: 'sender', id: 'r@x.com' })).s === 503);
    // --- login brute force limit
    const tries = []; for (let i = 0; i < 12; i++) tries.push((await call(a, 'POST', '/api/sender/login', { email: 'victim@x.com', password: 'guess' + i })).s); ok('repeated wrong logins are blocked (429)', tries.includes(429));
    // --- admin
    ok('admin needs the token', (await call(a, 'GET', '/api/admin/stats')).s === 403 && (await call(a, 'GET', '/api/admin/stats', null, null, { 'x-admin-token': 'wrong' })).s === 403);
    const st = await call(a, 'GET', '/api/admin/stats', null, null, { 'x-admin-token': 'adm-token' }); ok('admin stats show post offices and totals', st.s === 200 && st.j.postOffices.length === 2 && st.j.totals.messages >= 1);
    ok('audit log never shows full emails or message text', !JSON.stringify(st.j.audit).includes('r@x.com') && !JSON.stringify(st.j.audit).includes('Priya'));
    ok('admin can add a recovery email', (await call(a, 'POST', '/api/admin/po-email', { code: '500081', email: 'po81@x.com' }, null, { 'x-admin-token': 'adm-token' })).s === 200);
    const bkp = await call(a, 'GET', '/api/admin/backup', null, null, { 'x-admin-token': 'adm-token' }); ok('admin can download a backup (and others cannot)', bkp.s === 200 && !!bkp.j.senders && (await call(a, 'GET', '/api/admin/backup')).s === 403);
    const ap = await fetch(a + '/admin'); ok('admin page is served', ap.status === 200 && (await ap.text()).includes('SFAX ADMIN'));
    // --- retention clean-up
    const raw = JSON.parse(fs.readFileSync(C.file, 'utf8')); ok('old printed (200 days) and old unprinted messages were deleted, recent one kept', raw.messages.length === 1 && raw.messages[0].id === 'recent');
  } catch (e) { console.log('ERROR', e); fails++; }
  [A, B, C].forEach(x => x.p.kill()); mailSrv.close();
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nAll checks passed'); process.exit(fails ? 1 : 0);
})();
