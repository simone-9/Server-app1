import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { daTomtom, daWaze, unisci, riquadro, main } = await import('../scripts/viabilita-fonti.mjs');
const { costruisciFeed, coppie, fusoIso, main: mainFeed } = await import('../scripts/viabilita-waze-feed.mjs');
const conf = { lat: 45.515, lon: 11.865, raggioKm: 8, scadenzaOre: 6 }, ora = Date.parse('2026-11-14T12:00:00Z'), m = (min) => new Date(ora - min * 60000).toISOString();
// riquadro: minLon,minLat,maxLon,maxLat e area sotto il limite di TomTom
const bb = riquadro(45.515, 11.865, 8); assert.ok(bb[0] < 11.865 && bb[2] > 11.865 && bb[1] < 45.515 && bb[3] > 45.515);
// ---- TomTom
const tt = { incidents: [
  { geometry: { type: 'LineString', coordinates: [[11.86, 45.51], [11.861, 45.511]] }, properties: { id: 'a1', iconCategory: 8, magnitudeOfDelay: 4, events: [{ description: 'Chiusa', code: 401, iconCategory: 8 }], startTime: m(30), from: 'Via Roma', to: 'Via Po', roadNumbers: ['SP13'] } },
  { geometry: { type: 'Point', coordinates: [11.87, 45.52] }, properties: { id: 'a2', iconCategory: 11, magnitudeOfDelay: 2, events: [{ description: 'Allagamento' }] } },
  { geometry: { type: 'Point', coordinates: [11.87, 45.52] }, properties: { id: 'a3', iconCategory: 6 } },
  { geometry: { type: 'Point', coordinates: [12.5, 45.52] }, properties: { id: 'a4', iconCategory: 8 } },
  { geometry: { type: 'Point', coordinates: [11.87, 45.52] }, properties: { id: 'a5', iconCategory: 9 } }] };
let v = daTomtom(tt, conf); assert.deepEqual(v.map(x => x.id + ':' + x.tipo), ['tomtom_a1:chiusa', 'tomtom_a2:acqua'], 'traffico, lavori e fuori raggio ignorati');
assert.equal(v[0].polilinea, '45.510000 11.860000 45.511000 11.861000'); assert.equal(v[0].lat, 45.51); assert.equal(v[0].strada, 'Via Roma → Via Po'); assert.match(v[0].titolo, /Strada chiusa SP13/);
// ---- Waze
const wz = { alerts: [{ uuid: 'u1', type: 'ROAD_CLOSED', street: 'Via Dante', location: { x: 11.86, y: 45.51 }, pubMillis: ora - 600000 }, { uuid: 'u2', type: 'HAZARD', subtype: 'HAZARD_WEATHER_FLOOD', location: { x: 11.87, y: 45.52 } }, { uuid: 'u3', type: 'JAM', location: { x: 11.87, y: 45.52 } }, { uuid: 'u4', type: 'ACCIDENT', location: { x: 12.9, y: 45.5 } }, { type: 'HAZARD', location: { x: 11.87, y: 45.52 } }] };
let w = daWaze(wz, conf); assert.deepEqual(w.map(x => x.id + ':' + x.tipo), ['waze_u1:chiusa', 'waze_u2:acqua']); assert.equal(w[0].strada, 'Via Dante');
// ---- unisci: nuove, gia' presenti (stato intatto), scadenza
const es = [{ id: 'tomtom_a1', campi: { stato: 'confermata', fonte: 'tomtom', visto: m(100) } }, { id: 'tomtom_old', campi: { stato: 'proposta', fonte: 'tomtom', visto: m(400) } }, { id: 'tomtom_rec', campi: { stato: 'proposta', fonte: 'tomtom', visto: m(60) } }, { id: 'waze_x', campi: { stato: 'proposta', fonte: 'waze', visto: m(400) } }, { id: 'sq1', campi: { stato: 'proposta', fonte: 'squadra', ts: m(900) } }];
let sc = unisci(es, v, new Set(['tomtom']), ora, 6);
const per = Object.fromEntries(sc.map(s => [s.id, s.campi]));
assert.equal(per.tomtom_a1.stato, undefined, 'una segnalazione gia confermata non cambia stato'); assert.equal(per.tomtom_a1.visto, new Date(ora).toISOString());
assert.equal(per.tomtom_a2.stato, 'proposta'); assert.equal(per.tomtom_a2.inviaWaze, false); assert.equal(per.tomtom_a2.creatoDa, 'Fonte TomTom');
assert.equal(per.tomtom_old.stato, 'scaduta', 'proposta vecchia non piu vista: scade'); assert.equal(per.tomtom_rec, undefined, 'proposta recente non piu vista: resta');
assert.equal(per.waze_x, undefined, 'fonte non letta: non si scade'); assert.equal(per.sq1, undefined, 'segnalazioni della squadra non scadono da sole');
// ---- feed CIFS
const S = (id, c) => ({ id, campi: Object.assign({ stato: 'confermata', tipo: 'chiusa', inviaWaze: true, fonte: 'manuale', strada: 'Via Roma', titolo: 'Sottopasso chiuso', polilinea: '45.510000 11.860000 45.511000 11.861000', confermataIl: m(20), ts: m(25) }, c) });
const f = costruisciFeed([S('ok1', {}), S('no-flag', { inviaWaze: false }), S('no-tratto', { polilinea: '' }), S('no-via', { strada: '' }), S('corto', { polilinea: '45.5100 11.8600 45.5100 11.8601' }), S('waze', { fonte: 'waze' }), S('proposta', { stato: 'proposta' }), S('acqua', { tipo: 'acqua' })], ora);
assert.deepEqual(f.feed.incidents.map(x => x.id), ['ok1']); assert.deepEqual(f.scartate.map(x => x[0]).sort(), ['corto', 'no-tratto', 'no-via']);
const i0 = f.feed.incidents[0]; assert.equal(i0.type, 'ROAD_CLOSED'); assert.equal(i0.polyline, '45.510000 11.860000 45.511000 11.861000'); assert.match(i0.starttime, /^2026-11-14T11:40:00\+00:00$/); assert.equal(i0.direction, 'BOTH_DIRECTIONS'); assert.ok(i0.description.length <= 40);
assert.equal(coppie('1 2 3'), null); assert.equal(fusoIso('x'), '');
// ---- rete finta: lettura, scrittura parziale (updateMask) e stato del modulo
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }); const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'proj', client_email: 'a@b.c', private_key: pem }), TOMTOM_API_KEY: 'SEGRETISSIMA', WAZE_FEED_URL: 'https://waze.example/feed' };
const S_ = (x) => ({ stringValue: x }), B_ = (x) => ({ booleanValue: x }), N_ = (x) => ({ doubleValue: x });
const rete = (attivo, cfg) => { const log = { patch: [], get: [] };
  const fetchF = async (url, init = {}) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (url.includes('oauth2')) return ok({ access_token: 't' });
    if (url.startsWith('https://api.tomtom.com')) { log.get.push(url); return ok(tt); }
    if (url.startsWith('https://waze.example')) { log.get.push(url); return ok(wz); }
    if (init.method === 'PATCH') { log.patch.push({ url, body: JSON.parse(init.body) }); return ok({}); }
    if (url.includes('/documents/impostazioni')) return ok({ documents: attivo === null ? [] : [{ name: '.../impostazioni/moduli', fields: { attivi: { mapValue: { fields: { viabilita: B_(attivo) } } } } }] });
    if (url.includes('/moduli_dati/viabilita/config')) return ok({ documents: [{ name: '.../config/impostazioni', fields: Object.fromEntries(Object.entries(cfg).map(([k, x]) => [k, typeof x === 'boolean' ? B_(x) : typeof x === 'number' ? N_(x) : S_(x)])) }] });
    if (url.includes('/moduli_dati/viabilita/segnalazioni')) return ok({ documents: [{ name: '.../segnalazioni/tomtom_a1', fields: { stato: S_('confermata'), fonte: S_('tomtom'), visto: S_(m(100)) } }, { name: '.../segnalazioni/ok1', fields: { stato: S_('confermata'), tipo: S_('chiusa'), inviaWaze: B_(true), fonte: S_('manuale'), strada: S_('Via Roma'), titolo: S_('Sottopasso chiuso'), polilinea: S_('45.510000 11.860000 45.511000 11.861000'), confermataIl: S_(m(20)), ts: S_(m(25)) } }] });
    throw new Error('url non previsto ' + url); };
  return { fetchF, log }; };
let r = rete(false, { tomtom: true }); let out = await main({ env, fetch: r.fetchF, ora }); assert.ok(out.spento); assert.equal(r.log.patch.length, 0, 'modulo spento: non scrive');
r = rete(null, {}); out = await main({ env, fetch: r.fetchF, ora }); assert.ok(out.spento);
r = rete(true, { tomtom: true, wazeIn: true, lat: 45.515, lon: 11.865, raggioKm: 8, scadenzaOre: 6 }); out = await main({ env, fetch: r.fetchF, ora });
assert.equal(out.viste, 4); assert.equal(r.log.get.length, 2); assert.ok(r.log.get[0].includes('bbox=') && r.log.get[0].includes('incidentDetails'));
const ids = r.log.patch.map(p => decodeURIComponent(p.url.split('?')[0].split('/').pop())).sort(); assert.deepEqual(ids, ['tomtom_a1', 'tomtom_a2', 'waze_u1', 'waze_u2']);
const pa1 = r.log.patch.find(p => p.url.includes('tomtom_a1')); assert.equal(pa1.url.split('?')[1], 'updateMask.fieldPaths=visto', 'sulle esistenti si scrive solo «visto»'); assert.deepEqual(Object.keys(pa1.body.fields), ['visto']);
const pa2 = r.log.patch.find(p => p.url.includes('tomtom_a2')); assert.equal(pa2.body.fields.stato.stringValue, 'proposta'); assert.ok(!('id' in pa2.body.fields));
r = rete(true, { tomtom: true }); const logSalvi = []; const orig = console.log; console.log = (x) => logSalvi.push(String(x)); out = await main({ env: Object.assign({}, env, { TOMTOM_API_KEY: '' }), fetch: r.fetchF, ora }); console.log = orig; assert.equal(r.log.patch.length, 0); assert.ok(logSalvi.some(x => /manca il segreto TOMTOM_API_KEY/.test(x)));
// la chiave non compare nei messaggi di errore
const rotta = rete(true, { tomtom: true }); const f2 = async (u, i) => u.startsWith('https://api.tomtom.com') ? { ok: false, status: 500 } : rotta.fetchF(u, i); const salvi = []; console.log = (x) => salvi.push(String(x)); await main({ env, fetch: f2, ora }); console.log = orig; process.exitCode = 0; assert.ok(!salvi.join('\n').includes('SEGRETISSIMA'));
// feed completo
const dir = mkdtempSync(tmpdir() + '/feed-'); r = rete(true, { wazeOut: true }); out = await mainFeed({ env: Object.assign({}, env, { FEED_OUT: dir + '/cifs.json' }), fetch: r.fetchF, ora }); assert.equal(out.chiusure, 1); assert.equal(JSON.parse(readFileSync(dir + '/cifs.json', 'utf8')).incidents[0].id, 'ok1');
r = rete(true, { wazeOut: false }); out = await mainFeed({ env: Object.assign({}, env, { FEED_OUT: dir + '/x.json' }), fetch: r.fetchF, ora }); assert.ok(out.spento, 'invio a Waze spento: nessun feed');
console.log('VIABILITA OK');
