#!/usr/bin/env node
// OWNER ONLY. Run this on your own computer, never on the server.
//   node tools/owner-tool.js keygen
//   node tools/owner-tool.js restore <server-url> <post-office-PIN>
const fs = require('fs'), C = require('./sfax-crypto');
const MASTER = 'escrow-master-PRIVATE.json';

(async () => {
  const [cmd, server, pin] = process.argv.slice(2);
  if (cmd === 'keygen') {
    if (fs.existsSync(MASTER)) C.die(MASTER + ' already exists. Not overwriting it.');
    const pass = await C.ask('Choose a strong passphrase for the master backup key: ', 'MASTER_PASS');
    if (pass.length < 12) C.die('Use at least 12 characters.');
    console.log('Creating key (takes a few seconds)...');
    const k = await C.genKeys();
    fs.writeFileSync(MASTER, JSON.stringify(C.lock(k.privateKey, pass, { publicKey: k.publicKey }), null, 2), { mode: 0o600 });
    console.log('\nSaved ' + MASTER + '  <-- keep this OFFLINE (USB stick in a safe, plus a second copy). Never upload it.');
    console.log('\nPut this in Render > Environment as ESCROW_PUBLIC_KEY:\n\n' + k.publicKey + '\n');
    console.log('Fingerprint (give this to every post office so they can check it): ' + await C.fingerprint(k.publicKey));
    return;
  }
  if (cmd === 'restore') {
    if (!server || !pin) C.die('Usage: node tools/owner-tool.js restore <server-url> <post-office-PIN>');
    const adminToken = await C.ask('Admin token (ADMIN_TOKEN set on Render): ', 'ADMIN_TOKEN');
    const r = await fetch(server.replace(/\/$/, '') + '/api/admin/escrow/' + pin, { headers: { 'x-admin-token': adminToken } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) C.die('Server said: ' + (j.error || r.status));
    if (!fs.existsSync(MASTER)) C.die('Cannot find ' + MASTER + ' in this folder.');
    const master = C.unlock(JSON.parse(fs.readFileSync(MASTER, 'utf8')), await C.ask('Master key passphrase: ', 'MASTER_PASS'));
    const poPriv = Buffer.from(await C.open(master, j.escrow, 'escrow|' + pin)).toString('utf8');
    const rp = await C.ask('Choose a one-time recovery passphrase for the post office: ', 'RECOVERY_PASS');
    if (rp.length < 8) C.die('Use at least 8 characters.');
    const out = 'recovery-' + pin + '.json';
    fs.writeFileSync(out, JSON.stringify(C.lock(poPriv, rp, { code: pin, publicKey: j.publicKey }), null, 2), { mode: 0o600 });
    console.log('\nCreated ' + out + ' (key for post office ' + pin + ', fingerprint ' + j.fingerprint + ').');
    console.log('Send the file to the verified post office. Tell them the recovery passphrase by PHONE on the official number,');
    console.log('never in the same email. Then delete ' + out + ' from your computer.');
    return;
  }
  C.die('Commands: keygen | restore <server-url> <post-office-PIN>');
})();
