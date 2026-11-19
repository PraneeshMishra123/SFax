// Shared crypto for SFAX tools. Same format the sender's browser uses.
// Messages: AES-256-GCM encrypts the data, the AES key is wrapped with the post office's RSA-OAEP public key.
const nc = require('crypto'), subtle = nc.webcrypto.subtle, readline = require('readline/promises');
const te = new TextEncoder();
const b64 = (u) => Buffer.from(u).toString('base64'), ub = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };

async function genKeys() {
  const kp = await subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
  return { publicKey: b64(await subtle.exportKey('spki', kp.publicKey)), privateKey: b64(await subtle.exportKey('pkcs8', kp.privateKey)) };
}
async function fingerprint(spkiB64) {
  const h = Buffer.from(await subtle.digest('SHA-256', ub(spkiB64))).toString('hex');
  return h.slice(0, 32).replace(/(.{4})/g, '$1 ').trim();
}
async function seal(pubB64, bytes, aad) {
  const k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']), iv = nc.webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad || '') }, k, bytes);
  const pub = await subtle.importKey('spki', ub(pubB64), RSA, false, ['encrypt']);
  const wk = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, await subtle.exportKey('raw', k));
  return { v: 1, iv: b64(iv), ct: b64(ct), wk: b64(wk) };
}
async function open(privB64, o, aad) {
  const priv = await subtle.importKey('pkcs8', ub(privB64), RSA, false, ['decrypt']);
  const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, priv, ub(o.wk));
  const k = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: ub(o.iv), additionalData: te.encode(aad || '') }, k, ub(o.ct)));
}
// Lock a private key with a passphrase (scrypt + AES-256-GCM) for saving to a file.
const SC = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
function lock(text, pass, extra) {
  const salt = nc.randomBytes(16), iv = nc.randomBytes(12), c = nc.createCipheriv('aes-256-gcm', nc.scryptSync(pass, salt, 32, SC), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { v: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64'), ...extra };
}
function unlock(o, pass) {
  const d = nc.createDecipheriv('aes-256-gcm', nc.scryptSync(pass, Buffer.from(o.salt, 'base64'), 32, SC), Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8');
}
// Ask a question in the terminal (or read it from an environment variable, for scripts).
async function ask(q, envName) {
  if (envName && process.env[envName]) return process.env[envName];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q); rl.close(); return a.trim();
}
function die(m) { console.error('\n' + m + '\n'); process.exit(1); }
module.exports = { genKeys, fingerprint, seal, open, lock, unlock, ask, die, b64, ub };
