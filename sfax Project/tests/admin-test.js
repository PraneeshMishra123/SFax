// Run: node tests/admin-test.js
// Single admin account, emailed codes, login codes for users, help requests, site controls, Google sign-in, logos.
// Uses the real server with a fake email service and a fake Google.
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'); let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mails = []; let mailFail = false;
const mailSrv = http.createServer((q, r) => { let d = ''; q.on('data', c => d += c); q.on('end', () => {
  if (mailFail) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end('{"message":"Key not found"}'); }
  try { const j = JSON.parse(d); mails.push({ to: j.to[0].email, subject: j.subject, text: j.textContent }); } catch (e) {}
  r.writeHead(201, { 'Content-Type': 'application/json' }); r.end('{}'); }); });
let gNonce = '', gEmail = 'gina@gmail.com', gAud = 'cid-123', gVerified = true;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const gSrv = http.createServer((q, r) => { let d = ''; q.on('data', c => d += c); q.on('end', () => {
  const idt = 'h.' + b64({ iss: 'https://accounts.google.com', aud: gAud, exp: Math.floor(Date.now() / 1000) + 600, nonce: gNonce, email: gEmail, email_verified: gVerified, name: 'Gina Google' }) + '.s';
  r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ id_token: idt })); }); });
(async () => {
  await new Promise(r => mailSrv.listen(0, r)); await new Promise(r => gSrv.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfax-adm-')), PORT = 4833, BASE = 'http://localhost:' + PORT;
  const srv = spawn('node', ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT, DATA_FILE: path.join(dir, 'd.json'), UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', SESSION_SECRET: 'adm-test-secret-0123456789abcdef', ADMIN_TOKEN: 'owner-token-xyz', MAIL_FROM: 'noreply@x.com', BREVO_API_KEY: 'k', MAIL_API_URL: 'http://localhost:' + mailSrv.address().port, GOOGLE_CLIENT_ID: 'cid-123', GOOGLE_CLIENT_SECRET: 'sec', SITE_URL: BASE, GOOGLE_TOKEN_URL: 'http://localhost:' + gSrv.address().port } });
  await sleep(1500);
  const call = async (m, p, body, tok, extra) => { const r = await fetch(BASE + p, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(extra || {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.clone().json(); } catch (e) {} return { s: r.status, j, r }; };
  const lastCode = (to) => { const m = [...mails].reverse().find(x => x.to === to); const c = m && m.text.match(/\b(\d{6})\b/); return c ? c[1] : ''; };
  const TOK = { 'x-admin-token': 'owner-token-xyz' };
  try {
    // ---- setup: one admin account only
    ok('before setup there is no admin', (await call('GET', '/api/admin/status')).j.setup === false);
    ok('setup needs the real ADMIN_TOKEN', (await call('POST', '/api/admin/setup', { token: 'wrong', email: 'boss@x.com', password: 'boss-password-1' })).s === 403);
    ok('setup refuses a short password', (await call('POST', '/api/admin/setup', { token: 'owner-token-xyz', email: 'boss@x.com', password: 'short' })).s === 400);
    const su = await call('POST', '/api/admin/setup', { token: 'owner-token-xyz', email: 'boss@x.com', password: 'boss-password-1' });
    ok('the admin account is created and logs in', su.s === 200 && !!su.j.token);
    ok('a second admin cannot be created', (await call('POST', '/api/admin/setup', { token: 'owner-token-xyz', email: 'two@x.com', password: 'two-password-12' })).s === 409);
    // ---- login with emailed code
    ok('wrong password is refused', (await call('POST', '/api/admin/login', { email: 'boss@x.com', password: 'nope-nope-nope' })).s === 401);
    mails.length = 0;
    const l1 = await call('POST', '/api/admin/login', { email: 'boss@x.com', password: 'boss-password-1' });
    ok('right password asks for an emailed code (no session yet)', l1.s === 200 && l1.j.need2fa === true && !l1.j.token && /b\*\*\*@x\.com/.test(l1.j.email));
    await sleep(100); const code = lastCode('boss@x.com'); ok('the 6-digit code arrives by email', /^\d{6}$/.test(code));
    ok('a wrong code is refused', (await call('POST', '/api/admin/verify', { code: code === '000000' ? '111111' : '000000' })).s === 401);
    const vf = await call('POST', '/api/admin/verify', { code }); ok('the right code gives a session', vf.s === 200 && !!vf.j.token);
    const AT = vf.j.token;
    ok('the code works only once', (await call('POST', '/api/admin/verify', { code })).s === 401);
    ok('admin session can open the dashboard data', (await call('GET', '/api/admin/stats', null, AT)).s === 200);
    ok('no login = no admin data', (await call('GET', '/api/admin/stats')).s === 403);
    ok('a normal user session cannot open admin data', (await (async () => { const r = await call('POST', '/api/sender/register', { name: 'Rahul', email: 'r@x.com', password: 'password-one' }); return call('GET', '/api/admin/stats', null, r.j.token); })()).s === 403);
    ok('the owner ADMIN_TOKEN still works as a backup', (await call('GET', '/api/admin/stats', null, null, TOK)).s === 200);
    ok('escrow route is reachable with the token (404 = no backup for that PIN)', (await call('GET', '/api/admin/escrow/999999', null, null, TOK)).s === 404 && (await call('GET', '/api/admin/escrow/999999', null, AT)).s === 403);
    // ---- forgot admin password
    mails.length = 0;
    ok('forgot password gives the same answer for a wrong email', (await call('POST', '/api/admin/forgot', { email: 'someone@else.com' })).s === 200);
    await sleep(100); ok('no email is sent for a wrong address', mails.length === 0);
    await call('POST', '/api/admin/forgot', { email: 'boss@x.com' }); await sleep(100);
    const rc = lastCode('boss@x.com'); ok('reset code is emailed to the admin', /^\d{6}$/.test(rc));
    ok('reset needs a long password', (await call('POST', '/api/admin/reset', { email: 'boss@x.com', code: rc, password: 'short' })).s === 400);
    ok('reset with the right code works', (await call('POST', '/api/admin/reset', { email: 'boss@x.com', code: rc, password: 'new-admin-pass-1' })).s === 200);
    ok('old admin session ends after a password change', (await call('GET', '/api/admin/stats', null, AT)).s === 403);
    ok('the old password no longer works', (await call('POST', '/api/admin/login', { email: 'boss@x.com', password: 'boss-password-1' })).s === 401);
    // ---- lost access
    ok('recover needs the ADMIN_TOKEN', (await call('POST', '/api/admin/recover', { token: 'bad', email: 'n@x.com', password: 'brand-new-pass-1' })).s === 403);
    const rec = await call('POST', '/api/admin/recover', { token: 'owner-token-xyz', email: 'boss2@x.com', password: 'brand-new-pass-1' });
    ok('ADMIN_TOKEN can replace the one admin account', rec.s === 200 && !!rec.j.token);
    const A2 = rec.j.token;
    ok('the new admin email is used (old email cannot login)', (await call('POST', '/api/admin/login', { email: 'boss@x.com', password: 'brand-new-pass-1' })).s === 401);
    // ---- email test
    mails.length = 0; const mt = await call('POST', '/api/admin/mail-test', {}, A2); await sleep(50);
    ok('test email is sent to the admin', mt.s === 200 && mt.j.ok === true && mails.some(m => m.to === 'boss2@x.com' && /test/i.test(m.subject)));
    mailFail = true; const mt2 = await call('POST', '/api/admin/mail-test', {}, A2); mailFail = false;
    ok('a failed test email says exactly why', mt2.j.ok === false && /401/.test(mt2.j.error) && /Key not found/.test(mt2.j.error));
    ok('the last email result is shown on the overview', (await call('GET', '/api/admin/stats', null, A2)).j.config.mailState.ok === false);
    // ---- change own account
    ok('changing the account needs the current password', (await call('POST', '/api/admin/account', { current: 'wrong', newPassword: 'another-pass-123' }, A2)).s === 403);
    // ---- users: login code by email
    await call('POST', '/api/sender/register', { name: 'Priya', email: 'p@x.com', password: 'priya-pass-1' });
    const pl = await call('POST', '/api/sender/login', { email: 'p@x.com', password: 'priya-pass-1' }); const PT = pl.j.token;
    ok('sender login code is off by default', !!PT && (await call('GET', '/api/account/twofa', null, PT)).j.twofa === false);
    ok('turning it on needs the password', (await call('POST', '/api/account/twofa', { enabled: true, password: 'bad' }, PT)).s === 403);
    ok('sender turns the login code on', (await call('POST', '/api/account/twofa', { enabled: true, password: 'priya-pass-1' }, PT)).j.twofa === true);
    mails.length = 0; const pl2 = await call('POST', '/api/sender/login', { email: 'p@x.com', password: 'priya-pass-1' }); await sleep(100);
    ok('with the code on, login waits for the emailed code', pl2.j.need2fa === true && !pl2.j.token);
    const pc = lastCode('p@x.com');
    ok('wrong login code refused', (await call('POST', '/api/login2fa', { role: 'sender', id: 'p@x.com', code: pc === '000000' ? '111111' : '000000' })).s === 401);
    const pl3 = await call('POST', '/api/login2fa', { role: 'sender', id: 'p@x.com', code: pc }); ok('right login code gives the session', pl3.s === 200 && !!pl3.j.token && pl3.j.name === 'Priya');
    // post office: website needs the code, the Print app does not
    const pr = await call('POST', '/api/po/register', { code: '500016', password: 'po-password-1', email: 'po16@x.com' }); const POT = pr.j.token;
    await call('POST', '/api/account/twofa', { enabled: true, password: 'po-password-1' }, POT);
    ok('post office login on the website asks for the code', (await call('POST', '/api/po/login', { code: '500016', password: 'po-password-1' })).j.need2fa === true);
    ok('the Print app can still login (its protection is the key on that computer)', !!(await call('POST', '/api/po/login', { code: '500016', password: 'po-password-1' }, null, { 'x-sfax-app': '1.0.3' })).j.token);
    // ---- help requests
    mails.length = 0;
    ok('help request needs who you are', (await call('POST', '/api/help', { role: 'po', id: '' })).s === 400);
    ok('a help request is accepted', (await call('POST', '/api/help', { role: 'po', id: '500016', contact: '98400 00000', note: 'lost my email' })).s === 200); await sleep(100);
    ok('the admin is emailed about it', mails.some(m => m.to === 'boss2@x.com' && /help/i.test(m.subject)));
    const hl = (await call('GET', '/api/admin/help', null, A2)).j; ok('help request shows in the admin list', hl.length === 1 && hl[0].who === '500016' && hl[0].open);
    ok('help request can be marked done', (await call('POST', '/api/admin/help-resolve', { id: hl[0].id }, A2)).s === 200 && (await call('GET', '/api/admin/help', null, A2)).j[0].open === false);
    // ---- admin powers
    const sp = await call('POST', '/api/admin/set-password', { role: 'po', id: '500016' }, A2); ok('admin can generate a new password', sp.s === 200 && /^[A-Za-z0-9]{12}$/.test(sp.j.password));
    ok('old logins end after the admin sets a password', (await call('GET', '/api/po/me', null, POT)).s === 401);
    ok('the generated password works', !!(await call('POST', '/api/po/login', { code: '500016', password: sp.j.password }, null, { 'x-sfax-app': '1.0.3' })).j.token);
    ok('admin can suspend an account', (await call('POST', '/api/admin/suspend', { role: 'sender', id: 'p@x.com', suspended: true }, A2)).s === 200);
    ok('a suspended account cannot login', (await call('POST', '/api/sender/login', { email: 'p@x.com', password: 'priya-pass-1' })).s === 403);
    ok('a suspended account session stops working', (await call('GET', '/api/messages/mine', null, pl3.j.token)).s === 401);
    ok('admin can enable it again', (await call('POST', '/api/admin/suspend', { role: 'sender', id: 'p@x.com', suspended: false }, A2)).s === 200 && (await call('POST', '/api/sender/login', { email: 'p@x.com', password: 'priya-pass-1' })).s === 200);
    ok('account list shows both kinds', (await call('GET', '/api/admin/accounts', null, A2)).j.senders.length === 2);
    ok('admin can delete an account', (await call('POST', '/api/admin/delete', { role: 'sender', id: 'r@x.com' }, A2)).s === 200 && (await call('GET', '/api/admin/accounts', null, A2)).j.senders.length === 1);
    // ---- website controls
    ok('admin sets a banner and maintenance', (await call('POST', '/api/admin/site', { banner: 'Holiday hours', maintenance: true, org: 'Trigun Robotics', phone: '123' }, A2)).s === 200);
    const si = (await call('GET', '/api/site-info')).j; ok('the public site shows the banner, maintenance and details', si.banner === 'Holiday hours' && si.maintenance === true && si.org === 'Trigun Robotics' && si.phone === '123' && si.google === true);
    const tok = pl3.j.token;
    ok('sending is refused while paused', (await call('POST', '/api/messages', { to: 'x', code: '500016', enc: {} }, tok)).s === 503);
    await call('POST', '/api/admin/site', { maintenance: false }, A2);
    // ---- Google sign-in (OpenID Connect)
    const gs = await call('GET', '/api/auth/google/start'); const loc = new URL(gs.r.headers.get('location'));
    ok('Google start redirects to Google with state and nonce', gs.s === 302 && loc.searchParams.get('client_id') === 'cid-123' && !!loc.searchParams.get('state') && !!loc.searchParams.get('nonce') && loc.searchParams.get('scope') === 'openid email profile');
    gNonce = loc.searchParams.get('nonce'); const state = loc.searchParams.get('state');
    const cb = await call('GET', '/api/auth/google/callback?code=abc&state=' + encodeURIComponent(state)); const cl = cb.r.headers.get('location') || '';
    const gt = new URLSearchParams(cl.split('#')[1] || ''); ok('good Google login returns a session in the page address', cb.s === 302 && !!gt.get('gs') && gt.get('gn') === 'Gina Google');
    ok('that session works for the sender', (await call('GET', '/api/sender/me', null, gt.get('gs'))).j.email === 'gina@gmail.com');
    const cb2 = await call('GET', '/api/auth/google/callback?code=abc&state=' + encodeURIComponent(state + 'x')); ok('a tampered state is refused', /ge=/.test(cb2.r.headers.get('location') || '') && !/gs=/.test(cb2.r.headers.get('location') || ''));
    gNonce = 'other'; const cb3 = await call('GET', '/api/auth/google/callback?code=abc&state=' + encodeURIComponent(state)); ok('a wrong nonce is refused', /ge=/.test(cb3.r.headers.get('location') || ''));
    gNonce = loc.searchParams.get('nonce'); gVerified = false; const cb4 = await call('GET', '/api/auth/google/callback?code=abc&state=' + encodeURIComponent(state)); ok('an unverified Google email is refused', /ge=/.test(cb4.r.headers.get('location') || '')); gVerified = true;
    gAud = 'someone-else'; const cb5 = await call('GET', '/api/auth/google/callback?code=abc&state=' + encodeURIComponent(state)); ok('a token for another app is refused', /ge=/.test(cb5.r.headers.get('location') || '')); gAud = 'cid-123';
    // ---- logos
    const lg = await fetch(BASE + '/assets/trigun-logo.png'); ok('Trigun logo is served', lg.status === 200 && lg.headers.get('content-type') === 'image/png');
    ok('IIITDM logo is not on the website', (await fetch(BASE + '/assets/iiitdmk-logo.png')).status === 404);
    ok('other paths in assets are refused', (await fetch(BASE + '/assets/..%2Fserver.js')).status === 404 && (await fetch(BASE + '/assets/nothere.png')).status === 404);
    const ap = await (await fetch(BASE + '/admin')).text(); ok('admin page is served', ap.includes('SFAX ADMIN'));
    const hp = await (await fetch(BASE + '/')).text(); ok('homepage shows Trigun Robotics at the top, no IIITDM logo', /TRIGUN ROBOTICS/.test(hp) && /assets\/trigun-logo\.png/.test(hp) && !/iiitdmk/.test(hp));
  } catch (e) { fails++; console.log('ERROR', e && e.stack || e); }
  srv.kill(); mailSrv.close(); gSrv.close();
  console.log(fails ? fails + ' check(s) FAILED' : 'All checks passed'); process.exit(fails ? 1 : 0);
})();
