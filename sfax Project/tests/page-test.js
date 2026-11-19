// Run: node tests/page-test.js
// Runs the website's real JavaScript against the real server, with stand-ins for the page elements.
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'); let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mails = []; const mailSrv = http.createServer((q, r) => { let d = ''; q.on('data', c => d += c); q.on('end', () => { try { const j = JSON.parse(d); mails.push({ to: j.to[0].email, subject: j.subject, text: j.textContent }); } catch (e) {} r.end('{}'); }); });
(async () => {
  await new Promise(r => mailSrv.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfax-')), PORT = 4821, BASE = 'http://localhost:' + PORT;
  const srv = spawn('node', ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT, DATA_FILE: path.join(dir, 'd.json'), UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', SESSION_SECRET: 'page-test-secret-0123456789', MAIL_FROM: 'n@example.com', BREVO_API_KEY: 'k', MAIL_API_URL: 'http://localhost:' + mailSrv.address().port } });
  await sleep(1500);
  // ---- stand-ins for the browser
  const els = {}; const initialHidden = ['fgBox', 'fName', 'fPin', 'fPoMail', 'contact', 'ftContact', 'toast', 'dlLink', 'appPop', 'tfBox', 'hpBox', 'gBtn', 'siteBanner', 'secPop'];
  const mk = (id) => { const cl = new Set(initialHidden.includes(id) ? ['hide'] : []); const attrs = {}; return { id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, autocomplete: '', classList: { add: (x) => cl.add(x), remove: (x) => cl.delete(x), contains: (x) => cl.has(x), toggle: (x, f) => (f === undefined ? !cl.has(x) : f) ? cl.add(x) : cl.delete(x) }, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, getAttribute: (k) => attrs[k], focus() { this.focused = true; }, append() {}, appendChild() {}, addEventListener() {}, insertAdjacentHTML() {} }; };
  const store = {}; const ss = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  Object.assign(globalThis, { location: { hash: '', pathname: '/' }, document: { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], createElement: () => mk('x'), addEventListener() {}, body: mk('body') }, IntersectionObserver: class { observe() {} unobserve() {} }, sessionStorage: ss, history: { state: null, pushState(s) { this.state = s; }, replaceState(s) { this.state = s; } }, scrollTo() {}, addEventListener() {}, confirm: () => true, scrollY: 0 });
  globalThis.window = globalThis;
  const realFetch = fetch; globalThis.fetch = (p, o) => realFetch(String(p).startsWith('/') ? BASE + p : p, o);
  const src = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8'); const js = src.slice(src.indexOf('<script>') + 8, src.indexOf('</script>', src.indexOf('<script>')));
  (0, eval)(js + `;globalThis.__t={st:()=>({token,role,user,tab,sendRid,msgs,poMe}),set:(k,v)=>{if(k==='role')role=v;if(k==='reg')reg=v;if(k==='sendRid')sendRid=v},go:()=>doLogin()};`);
  const $ = (id) => document.getElementById(id), T = globalThis.__t;
  const val = (o) => Object.entries(o).forEach(([k, v]) => { $(k).value = v; });
  try {
    // ---- a post office registers on the website (no app yet)
    T.set('role', 'p'); T.set('reg', true); setMode();
    val({ lp: '500016', lpe: 'po16@x.com', lw: 'short' }); await doLogin(); ok('post office sign-up: short password is explained', /at least 8/.test($('lerr').textContent));
    val({ lw: 'po-password-1' }); await doLogin(); ok('post office registers with a recovery email and enters the app', !!T.st().token && !document.getElementById('app').classList.contains('hide'));
    logout(); ok('logout clears the saved session', sessionStorage.getItem('sfax-s') === null && T.st().token === null);
    // ---- a sender signs up
    T.set('role', 's'); T.set('reg', true); setMode();
    val({ ln: 'Rahul', le: 'r@x.com', lw: 'password-one' }); await doLogin(); ok('sender signs up and the session is saved for refresh', !!T.st().token && !!sessionStorage.getItem('sfax-s'));
    renderMain();
    // ---- validation
    await sendMsg(); ok('empty form is stopped with a clear message', /who the message is for/i.test($('serr').textContent) && $('to').getAttribute('aria-invalid') === 'true' && $('to').focused === true);
    val({ to: 'Priya', dse: 'bad', dsa: 'A', dre: 'p@x.com', dra: 'B', c: '500016', m: 'Hello' }); await sendMsg(); ok('bad sender email is pointed out', /sender email/i.test($('serr').textContent) && $('dse').getAttribute('aria-invalid') === 'true');
    val({ dse: 'r@x.com', c: '12' }); await sendMsg(); ok('bad PIN is explained with a hint', /6 digits/.test($('serr').textContent));
    val({ c: '500016', m: 'x'.repeat(10001) }); await sendMsg(); ok('over-long message (10,000 limit) is refused', /10,000/.test($('serr').textContent));
    val({ m: 'y'.repeat(9000) }); countM(); ok('a 9,000-character message is accepted by the counter', /9000 \/ 10000/.test($('mc').textContent));
    // ---- draft + counter + language warning
    val({ m: 'Telugu: \u0c24\u0c46' }); saveDraft(); ok('draft is kept in the tab', /Telugu/.test(JSON.parse(sessionStorage.getItem('sfax-d')).m)); ok('non-English letters trigger the print warning', /print as \?/.test($('mw').textContent));
    // ---- send (post office has no app yet -> waiting)
    val({ m: 'Hello Priya, thank you for everything.' }); await sendMsg();
    ok('success message is shown and says the message is waiting', /Sent for Priya/.test($('sok').textContent) && /waiting/.test($('sok').textContent));
    ok('form and draft are cleared after sending', $('m').value === '' && sessionStorage.getItem('sfax-d') === null && $('sendBtn').disabled === false);
    await refresh(); ok('message appears in the sender list as waiting', T.st().msgs.length === 1 && T.st().msgs[0].waiting === true);
    // ---- duplicate protection: same request id sent twice
    val({ to: 'Priya', dse: 'r@x.com', dsa: 'A', dre: 'p@x.com', dra: 'B', c: '500016', m: 'Second' }); T.set('sendRid', 'fixed-id'); await sendMsg(); T.set('sendRid', 'fixed-id'); val({ to: 'Priya', dse: 'r@x.com', dsa: 'A', dre: 'p@x.com', dra: 'B', c: '500016', m: 'Second' }); await sendMsg();
    await refresh(); ok('the same request sent twice creates one message', T.st().msgs.length === 2);
    // ---- cancel
    await cancelMsg(T.st().msgs[0].id); await refresh(); ok('cancelling removes the message', T.st().msgs.length === 1);
    // ---- forgot / reset password through the page
    logout(); T.set('role', 's'); T.set('reg', false); setMode(); val({ le: 'r@x.com', lw: '' }); mails.length = 0;
    await showForgot(); await sleep(300); const code = (mails.find(m => m.to === 'r@x.com') || { text: '' }).text.match(/\b(\d{6})\b/);
    ok('forgot password shows the code screen and emails a code', !$('fgBox').classList.contains('hide') && $('lmain').classList.contains('hide') && !!code);
    val({ fcode: '12', fpw: 'new-password-1' }); await doReset(); ok('a short code is explained', /6 digits/.test($('ferr').textContent) && /8 digits/.test($('ferr').textContent));
    val({ fcode: code[1], fpw: 'abc' }); await doReset(); ok('a weak new password is explained', /at least 8/.test($('ferr').textContent));
    val({ fcode: code[1], fpw: 'new-password-1' }); await doReset(); ok('password changed and the login form returns', !$('lmain').classList.contains('hide') && /Password changed/.test($('toast').textContent));
    val({ lw: 'password-one' }); await doLogin(); ok('old password is refused with a hint', /Wrong email or password/.test($('lerr').textContent) && /Forgot password/.test($('lerr').textContent));
    val({ lw: 'new-password-1' }); await doLogin(); ok('new password logs in', !!T.st().token);
    // ---- session restore after a page refresh
    const saved = sessionStorage.getItem('sfax-s'); ok('session survives a refresh (saved in the tab)', !!saved && JSON.parse(saved).token === T.st().token);
    // ---- post office: no email on file -> support code, and adding an email
    logout(); T.set('role', 'p'); T.set('reg', false); setMode(); ok('post office login explains the support code', !$('fgHelp').classList.contains('hide'));
    val({ lp: '500016', lw: 'po-password-1' }); await doLogin(); await loadMe(); ok('post office sees the (masked) recovery email it registered with', !!T.st().poMe && T.st().poMe.hasEmail === true && /^p\*\*\*@x\.com$/.test(T.st().poMe.email));
    val({ pe: 'new@x.com', ppw: 'wrong-pass-123' }); await saveEmail(); ok('changing the email needs the right password', /not correct/.test($('perr').textContent));
    val({ pe: 'new@x.com', ppw: 'po-password-1' }); await saveEmail(); ok('recovery email saved', T.st().poMe.hasEmail === true && /n\*\*\*@x\.com/.test(T.st().poMe.email));
    logout(); T.set('role', 'p'); setMode(); val({ lp: '500016' }); await showForgot(); ok('post office forgot screen mentions the support code', /8-digit/.test($('fgInfo').textContent));
    // ---- site info fills the contact section
    loadSite({ org: 'SFAX Team', email: 'help@x.com', phone: '+91 99999 99999', mail: true }); ok('contact section appears when support details are set', !$('contact').classList.contains('hide') && $('ftOrg').textContent === 'SFAX Team');
    // ---- unreachable server gives a clear message
    const sf = globalThis.fetch; globalThis.fetch = () => Promise.reject(new TypeError('failed')); let msg = ''; try { await api('/api/site-info'); } catch (e) { msg = e.message; } globalThis.fetch = sf; ok('server down: friendly message with wake-up hint', /Cannot reach SFAX/.test(msg) && /wake up/.test(msg));
  } catch (e) { console.log('ERROR', e); fails++; }
  logout(); srv.kill(); mailSrv.close(); console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nAll checks passed'); process.exit(fails ? 1 : 0);
})();
