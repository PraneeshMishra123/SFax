#!/usr/bin/env node
// Post office tool. Stage 1 stand-in for the SFAX Print app (the app will reuse this same crypto).
//   node tools/po-tool.js setup <server-url> <PIN> <password>
//   node tools/po-tool.js read  <server-url> <PIN> <password> [key-file]
const fs = require('fs'), C = require('./sfax-crypto');
const [cmd, server, PIN, pw, keyArg] = process.argv.slice(2);
if (!cmd || !server || !PIN || !pw) C.die('Usage: node tools/po-tool.js setup|read <server-url> <PIN> <password> [key-file]');
const base = server.replace(/\/$/, ''), keyFile = keyArg || 'sfax-po-' + PIN + '.key.json';
let token = '';
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
};
async function login(create) {
  let r = create ? await call('POST', '/api/po/register', { code: PIN, password: pw }) : { status: 409 };
  if (r.status === 409) r = await call('POST', '/api/po/login', { code: PIN, password: pw });
  if (!r.ok) C.die('Login failed: ' + (r.json.error || r.status));
  token = r.json.token;
}
(async () => {
  if (cmd === 'setup') {
    if (fs.existsSync(keyFile)) C.die(keyFile + ' already exists. Not overwriting it.');
    await login(true);
    const esc = await call('GET', '/api/escrow-key');
    if (!esc.ok || !esc.json.publicKey) C.die('The server has no backup (escrow) key configured. Ask the SFAX owner.');
    console.log('\nBackup key fingerprint from the server: ' + esc.json.fingerprint);
    if ((await C.ask('Is this the same fingerprint the SFAX owner gave you? (yes/no): ', 'CONFIRM')) !== 'yes') C.die('Stopped. Do not continue if the fingerprint is different.');
    console.log('Creating keys (takes a few seconds)...');
    const keys = await C.genKeys();
    const escrow = await C.seal(esc.json.publicKey, Buffer.from(keys.privateKey), 'escrow|' + PIN);
    const k = await call('POST', '/api/po/key', { publicKey: keys.publicKey, escrow });
    if (!k.ok) C.die('Server said: ' + (k.json.error || k.status));
    const pass = await C.ask('Choose a passphrase to lock the key file on this computer: ', 'KEY_PASS');
    if (pass.length < 8) C.die('Use at least 8 characters. (The key was registered; run recovery with the owner.)');
    fs.writeFileSync(keyFile, JSON.stringify(C.lock(keys.privateKey, pass, { code: PIN, publicKey: keys.publicKey }), null, 2), { mode: 0o600 });
    console.log('\nDone. Key file saved: ' + keyFile + '\nYour key fingerprint: ' + await C.fingerprint(keys.publicKey));
    console.log('Back up this file and remember the passphrase. If both are lost, contact the SFAX owner for recovery.');
    return;
  }
  if (cmd === 'read') {
    if (!fs.existsSync(keyFile)) C.die('Cannot find ' + keyFile);
    let priv;
    try { priv = C.unlock(JSON.parse(fs.readFileSync(keyFile, 'utf8')), await C.ask('Key file passphrase: ', 'KEY_PASS')); } catch (e) { C.die('Wrong passphrase or damaged key file.'); }
    await login(false);
    const inbox = await call('GET', '/api/inbox');
    if (!inbox.ok) C.die('Server said: ' + (inbox.json.error || inbox.status));
    for (const m of inbox.json.filter(x => !x.printed)) {
      const c = await call('GET', '/api/inbox/' + m.id + '/cipher');
      try {
        const d = JSON.parse(Buffer.from(await C.open(priv, c.json.enc, c.json.code)).toString('utf8'));
        console.log('\n==== From ' + c.json.name + ' to ' + d.to + ' (PIN ' + c.json.code + ') ====');
        console.log('Sender : ' + d.senderEmail + '\n         ' + d.senderAddress + '\nReceiver: ' + d.receiverEmail + '\n         ' + d.toAddress + '\n\n' + d.message);
      } catch (e) { console.log('\n(Could not decrypt message ' + m.id + ': ' + e.message + ')'); }
    }
    console.log('\n(Test tool only: the SFAX Print app will print without showing messages on screen.)');
    return;
  }
  C.die('Commands: setup | read');
})();
