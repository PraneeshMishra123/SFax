'use strict';
/* Post office directory (India Post "All India Pincode Directory").
   Put the file at data/pincodes.csv or data/pincodes.csv.gz (or set PINCODE_FILE). It is read once at start-up and kept in memory.
   Used to suggest the right post office / PIN while a sender types an address. Nothing here is stored or logged per request. */
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const ALIAS = {
  office: ['officename', 'office name', 'office_name', 'office', 'postoffice', 'post office', 'post office name'],
  pin: ['pincode', 'pin code', 'pin_code', 'pin', 'postal code', 'postalcode'],
  district: ['districtname', 'district name', 'district'],
  state: ['statename', 'state name', 'state_name', 'state'],
  type: ['officetype', 'office type', 'office_type'],
  delivery: ['delivery', 'delivery status', 'deliverystatus'],
};
const STOP = new Set(('no door flat house h plot street st road rd main cross lane floor near opp opposite behind beside next to the and of at in po post office dist district taluk taluka tq mandal village vill via state india ward block apartment apartments apt building bldg tower towers').split(' '));
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const cleanOffice = (s) => String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\b(?:G\.?\s?P\.?\s?O|H\.?\s?O|S\.?\s?O|B\.?\s?O|T\.?\s?O|C\.?\s?O)\.?\s*$/i, '').trim();
const toks = (s, dropStop) => norm(s).split(' ').filter((t) => t.length > 1 && !/^\d+$/.test(t) && !(dropStop && STOP.has(t)));

function parseLine(line) {                                   // small CSV reader: handles "quoted, fields"
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}

let O = [], BYPIN = new Map(), IDX = new Map(), SORTED = [], LOADED = null;
let PL = [];   // known places (colleges, hospitals, landmarks) the owner has listed with a confirmed PIN
const reset = () => { O = []; BYPIN = new Map(); IDX = new Map(); SORTED = []; LOADED = null; };

function load(file) {
  reset();
  const cands = file ? [file] : [process.env.PINCODE_FILE, path.join(__dirname, '..', 'data', 'pincodes.csv'), path.join(__dirname, '..', 'data', 'pincodes.csv.gz')].filter(Boolean);
  const f = cands.find((p) => fs.existsSync(p)); if (!f) return 0;
  let buf = fs.readFileSync(f); if (/\.gz$/i.test(f) || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = zlib.gunzipSync(buf);
  const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const head = parseLine(lines[0] || '').map((h) => h.trim().toLowerCase()), col = {};
  for (const k of Object.keys(ALIAS)) { col[k] = -1; for (const al of ALIAS[k]) { const ix = head.indexOf(al); if (ix >= 0) { col[k] = ix; break; } } }   // first alias that exists, in priority order
  if (col.office < 0 || col.pin < 0) return 0;               // not the file we expect
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = parseLine(lines[i]), pin = String(r[col.pin] || '').trim().replace(/\.0$/, '');
    if (!/^[1-9][0-9]{5}$/.test(pin)) continue;
    const raw = String(r[col.office] || '').trim(); if (!raw) continue;
    const name = raw.replace(/\s+/g, ' '), nt = toks(cleanOffice(raw), false);
    const dv = col.delivery >= 0 ? !/^\s*non/i.test(r[col.delivery] || '') : true;
    const o = { name, pin, district: col.district >= 0 ? String(r[col.district] || '').trim() : '', state: col.state >= 0 ? String(r[col.state] || '').trim() : '', type: col.type >= 0 ? String(r[col.type] || '').trim() : '', del: dv, nt, nn: nt.join(' ') };
    o.dt = toks(o.district, false); o.st = toks(o.state, false);
    O.push(o);
    let a = BYPIN.get(pin); if (!a) BYPIN.set(pin, a = []); a.push(o);
    for (const t of new Set(nt)) { let p = IDX.get(t); if (!p) IDX.set(t, p = []); p.push(o); }
  }
  SORTED = [...IDX.keys()].sort(); LOADED = f; return O.length;
}

const kind = (o) => /head|^h/i.test(o.type) || /\bH\.?O\b|G\.?P\.?O/i.test(o.name) ? 3 : /sub|^s/i.test(o.type) || /\bS\.?O\b/i.test(o.name) ? 2 : 1;
const info = (pin) => { const a = BYPIN.get(String(pin)); if (!a) return null; return group(a.map((o) => ({ o, s: kind(o) + (o.del ? 5 : 0) })), 1)[0] || null; };

function group(scored, limit) {                              // one suggestion per PIN: the strongest office, plus the other areas that share it
  const by = new Map();
  for (const x of scored) { let g = by.get(x.o.pin); if (!g) by.set(x.o.pin, g = { best: x, all: [] }); g.all.push(x); if (x.s > g.best.s) g.best = x; }
  return [...by.values()].sort((a, b) => b.best.s - a.best.s || kind(b.best.o) - kind(a.best.o) || (a.best.o.pin < b.best.o.pin ? -1 : 1)).slice(0, limit).map((g) => ({
    pin: g.best.o.pin, name: g.best.o.name, district: g.best.o.district, state: g.best.o.state, score: Math.round(g.best.s * 10) / 10,
    others: (BYPIN.get(g.best.o.pin) || []).filter((o) => o !== g.best.o && o.del).sort((a, b) => kind(b) - kind(a)).slice(0, 4).map((o) => o.name) }));
}

function prefixTokens(t) {                                   // the word being typed right now: find names that start with it
  let lo = 0, hi = SORTED.length; while (lo < hi) { const m = (lo + hi) >> 1; if (SORTED[m] < t) lo = m + 1; else hi = m; }
  const out = []; for (let i = lo; i < SORTED.length && SORTED[i].startsWith(t) && out.length < 25; i++) out.push(SORTED[i]); return out;
}

function loadPlaces(file) {   // data/places.csv: name,aliases,pincode,district,state  (aliases separated by |)
  PL = [];
  const cands = file ? [file] : [process.env.PLACES_FILE, path.join(__dirname, '..', 'data', 'places.csv'), path.join(__dirname, '..', 'data', 'places.csv.gz')].filter(Boolean);
  const f = cands.find((p) => fs.existsSync(p)); if (!f) return 0;
  let buf = fs.readFileSync(f); if (/\.gz$/i.test(f) || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = zlib.gunzipSync(buf);
  const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/), head = parseLine(lines[0] || '').map((h) => h.trim().toLowerCase());
  const ix = (...n) => { for (const a of n) { const i = head.indexOf(a); if (i >= 0) return i; } return -1; }, c = { name: ix('name', 'place', 'place name'), al: ix('aliases', 'alias', 'also known as'), pin: ix('pincode', 'pin', 'pin code'), dist: ix('district'), st: ix('state', 'statename') };
  if (c.name < 0 || c.pin < 0) return 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue; const r = parseLine(lines[i]), pin = String(r[c.pin] || '').trim(), name = String(r[c.name] || '').trim();
    if (!name || !/^[1-9][0-9]{5}$/.test(pin)) continue;
    const vars = [name].concat(c.al >= 0 ? String(r[c.al] || '').split(/[|;]/).map((x) => x.trim()).filter(Boolean) : []).map((v) => [...new Set(toks(v, true))]).filter((t) => t.length);
    if (vars.length) PL.push({ name, pin, district: c.dist >= 0 ? String(r[c.dist] || '').trim() : '', state: c.st >= 0 ? String(r[c.st] || '').trim() : '', vars });
  }
  return PL.length;
}

function placeMatches(Q) {   // a named place found in what was typed: most of its name (or an alias) must be there
  const out = [], last = Q[Q.length - 1], qs = new Set(Q);
  for (const pl of PL) {
    let best = 0, hit = 0;
    for (const v of pl.vars) {
      const inQ = v.filter((t) => qs.has(t) || (t.length > 3 && last.length >= 3 && t.startsWith(last))).length, cov = inQ / v.length;
      if (inQ >= Math.min(2, v.length) && (v.length > 1 || v[0].length >= 4) && cov >= 0.6 && cov + inQ * 0.01 > best) { best = cov + inQ * 0.01; hit = inQ; }
    }
    if (best) out.push({ pl, s: 40 + 10 * best + hit });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, 2).map((x) => { const i = info(x.pl.pin); return { pin: x.pl.pin, name: x.pl.name, district: x.pl.district || (i ? i.district : ''), state: x.pl.state || (i ? i.state : ''), score: Math.round(x.s * 10) / 10, place: true, po: i ? i.name : '', others: [] }; });
}

function search(text, opt) {
  opt = opt || {}; const limit = opt.limit || 6;
  if (!O.length && !PL.length) return { exact: false, results: [] };
  const txt = String(text || '').slice(0, 400), pm = txt.match(/(?:^|\D)([1-9][0-9]{5})(?!\d)/);
  if (pm) { const g = info(pm[1]); if (g) return { exact: true, results: [g] }; }          // a PIN typed in the address wins
  const Q = [...new Set(toks(txt, true))].slice(0, 12), qn = ' ' + norm(txt) + ' ';
  if (!Q.length) return { exact: false, results: [] };
  const pls = placeMatches(Q), withPlaces = (arr) => pls.concat(arr.filter((x) => !pls.some((p) => p.pin === x.pin))).slice(0, limit);   // a listed place goes first
  const ref = opt.nearPin && BYPIN.get(String(opt.nearPin)) ? BYPIN.get(String(opt.nearPin))[0] : null;
  if (!O.length) return { exact: false, results: withPlaces([]) };
  const cand = new Map();                                    // office -> number of query words found in its name
  Q.forEach((t, qi) => {
    let list = IDX.get(t);
    if (!list && qi === Q.length - 1 && t.length >= 3) { list = []; for (const p of prefixTokens(t)) list = list.concat(IDX.get(p) || []); }
    if (!list) return; if (list.length > 20000) list = list.slice(0, 20000);
    for (const o of list) cand.set(o, (cand.get(o) || 0) + 1);
  });
  const qset = new Set(Q), scored = [];
  for (const [o, hits] of cand) {
    const inQ = o.nt.filter((t) => qset.has(t) || Q.some((q) => q.length >= 3 && t.startsWith(q) && q === Q[Q.length - 1])).length;
    if (!inQ) continue;
    const cover = inQ / (o.nt.length || 1), phrase = o.nn && qn.includes(' ' + o.nn + ' ') ? 1 : 0;
    const dMatch = o.dt.length && o.dt.every((t) => qset.has(t)) ? 1 : 0, sMatch = o.st.length && o.st.every((t) => qset.has(t)) ? 1 : 0;
    const own = new Set(o.nt), extra = [...new Set([...o.dt, ...o.st])].filter((t) => qset.has(t) && !own.has(t)).length;   // address words explained by the district/state, not the office name
    let s = 4 * inQ + 6 * cover + 8 * phrase + 1.5 * dMatch + 1 * sMatch + 2.5 * extra + kind(o) * 0.3 + (o.del ? 1.5 : -2);
    if (ref) { if (o.state === ref.state) s += 1; if (o.district === ref.district) s += 1.5; if (o.pin.slice(0, 3) === ref.pin.slice(0, 3)) s += 1; }
    scored.push({ o, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return { exact: false, results: withPlaces(group(scored.slice(0, 80), limit)) };
}

function nearbyRegistered(pin, registeredPins, limit) {      // SFAX post offices close to an area that has none
  limit = limit || 3; pin = String(pin); const ref = (BYPIN.get(pin) || [])[0], rank = [];
  for (const p of registeredPins) {
    if (p === pin || !/^[1-9][0-9]{5}$/.test(p)) continue; const o = (BYPIN.get(p) || [])[0];
    const same = ref && o && o.district && o.district === ref.district && o.state === ref.state ? 3 : p.slice(0, 3) === pin.slice(0, 3) ? 2 : ref && o && o.state === ref.state ? 1 : 0;
    if (same) rank.push({ same, d: Math.abs(+p - +pin), p });
  }
  rank.sort((a, b) => b.same - a.same || a.d - b.d);
  return rank.slice(0, limit).map((x) => info(x.p) || { pin: x.p, name: '', district: '', state: '', score: 0, others: [] });
}

module.exports = { load, loadPlaces, placeCount: () => PL.length, search, info, nearbyRegistered, ready: () => O.length > 0 || PL.length > 0, count: () => O.length, pinCount: () => BYPIN.size, file: () => LOADED, _norm: norm };
