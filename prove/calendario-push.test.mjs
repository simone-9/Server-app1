import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
const { daNotificare, destinatari, messaggio, main } = await import('../scripts/calendario-push.mjs');
const { pushAmmesso } = await import('../scripts/push.mjs');
const ora = Date.parse('2026-11-06T12:00:00Z'), m = (min) => new Date(ora - min * 60000).toISOString();   // 13:00 a Roma
const E = (id, c) => ({ id, campi: Object.assign({ tipo: 'Esercitazione', titolo: 'Ev ' + id, data: '2026-11-20', dataFine: '2026-11-20', ora: '09:00', luogo: 'Magazzino', creato: m(60 * 24 * 5) }, c) });
const vuoto = { nuovi: [], promemoria: [] };
// --- pure
let r = daNotificare([E('a', { creato: m(5) })], null, ora); assert.equal(r.eventi.length, 0); assert.ok(r.primo); assert.deepEqual(r.stato.nuovi, ['a']);
r = daNotificare([E('a', { creato: m(5) })], r.stato, ora); assert.equal(r.eventi.length, 0, 'gia annunciato');
r = daNotificare([E('c', { creato: m(10) }), E('e'), E('p', { creato: m(60 * 30) }), E('s', { creato: m(5), data: '2026-11-01', dataFine: '2026-11-02' })], vuoto, ora);
assert.deepEqual(r.eventi.map(e => e.id + ':' + e.tipo), ['c:nuovo'], 'solo il nuovo, non quelli vecchi o gia passati');
r = daNotificare([E('a', { data: '2026-11-09' }), E('b', { data: '2026-11-07' }), E('x', { data: '2026-11-08' }), E('d', { data: '2026-11-09', creato: m(120) }), E('f', { data: '2026-11-09', creato: undefined })], vuoto, ora);
assert.deepEqual(r.eventi.map(e => e.id + ':' + e.tipo + (e.giorni || '')).sort(), ['a:promemoria3', 'b:promemoria1', 'd:nuovo', 'f:promemoria3'], 'd e nuovo: niente promemoria in piu');
r = daNotificare([E('a', { data: '2026-11-09' })], { nuovi: [], promemoria: ['a|3'] }, ora); assert.equal(r.eventi.length, 0, 'promemoria gia mandato');
r = daNotificare([E('a', { data: '2026-11-09' })], vuoto, Date.parse('2026-11-06T05:00:00Z')); assert.equal(r.eventi.length, 0, 'di notte (6:00 a Roma) niente promemoria');
r = daNotificare([E('a', { data: '2026-11-09' })], vuoto, Date.parse('2026-11-06T19:30:00Z')); assert.equal(r.eventi.length, 0, 'dopo le 20 niente promemoria');
r = daNotificare([E('z', { titolo: '' }), E('y', { data: '' })], vuoto, ora); assert.equal(r.eventi.length, 0);
// --- destinatari
const ruoli = [{ id: 'admin@x.it', campi: { role: 'Admin' } }, { id: 'v1@x.it', campi: { role: 'Operatore' } }, { id: 'v2@x.it', campi: { role: 'Operatore' } }, { id: 'v3@x.it', campi: { role: 'Operatore' } }, { id: 'v4@x.it', campi: { role: 'Operatore' } }, { id: 'mon@x.it', campi: { role: 'Monitor' } }];
const ades = [{ campi: { eventoId: 'a', utente: 'v1@x.it', stato: 'si' } }, { campi: { eventoId: 'a', utente: 'v2@x.it', stato: 'forse' } }, { campi: { eventoId: 'b', utente: 'v3@x.it', stato: 'no' } }];
const prop = [{ campi: { eventoId: 'a', utente: 'v4@x.it', stato: 'proposto' } }];
assert.deepEqual(destinatari({ tipo: 'nuovo', id: 'a', c: {} }, ruoli, ades, prop).sort(), ['admin@x.it', 'v1@x.it', 'v2@x.it', 'v3@x.it', 'v4@x.it']);
assert.deepEqual(destinatari({ tipo: 'promemoria', id: 'a', giorni: 3, c: {} }, ruoli, ades, prop).sort(), ['admin@x.it', 'v3@x.it'], '3 giorni: chi non ha risposto e non si e proposto');
assert.deepEqual(destinatari({ tipo: 'promemoria', id: 'a', giorni: 1, c: {} }, ruoli, ades, prop).sort(), ['admin@x.it', 'v2@x.it', 'v3@x.it'], '1 giorno: anche chi ha detto Forse');
assert.deepEqual(destinatari({ tipo: 'promemoria', id: 'b', giorni: 1, c: {} }, ruoli, ades, []).sort(), ['admin@x.it', 'v1@x.it', 'v2@x.it', 'v4@x.it']);
// --- messaggio + preferenze
const mm = messaggio({ tipo: 'nuovo', id: 'a', c: { tipo: 'Esercitazione', titolo: 'Campo estivo', data: '2026-11-20', ora: '09:00', luogo: 'Magazzino' } });
assert.match(mm.titolo, /Nuovo evento · Esercitazione/); assert.match(mm.testo, /20\/11 ore 09:00/); assert.equal(mm.tag, 'calendario-new-a');
const mr = messaggio({ tipo: 'promemoria', id: 'a', giorni: 1, c: { tipo: 'Manifestazione', titolo: 'Sagra', data: '2026-11-07', tuttoGiorno: true } }); assert.match(mr.titolo, /^Domani/); assert.doesNotMatch(mr.testo, /ore/); assert.equal(mr.tag, 'calendario-ric-a-1');
assert.equal(pushAmmesso({ calendario: false }, 'calendario-new-a'), false); assert.equal(pushAmmesso({}, 'calendario-new-a'), true); assert.equal(pushAmmesso({ tutte: false }, 'calendario-ric-a-3'), false); assert.equal(pushAmmesso({ calendario: false }, 'bacheca-x'), true); assert.equal(pushAmmesso({ calendario: false, richieste: true }, 'richiesta-urg-1'), true);
// --- main con rete finta
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@p.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'proj' }) };
const S = v => ({ stringValue: v }), B = v => ({ booleanValue: v });
const fsDoc = (id, o) => ({ name: 'projects/proj/databases/(default)/documents/x/' + id, fields: Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? S(v) : typeof v === 'boolean' ? B(v) : v])) });
const ev = (id, c) => fsDoc(id, Object.assign({ tipo: 'Esercitazione', titolo: 'Ev ' + id, data: '2026-11-20', dataFine: '2026-11-20', ora: '09:00', creato: m(60 * 24 * 5) }, c));
const eventi = [ev('n1', { creato: m(5), titolo: 'Nuova serata' }), ev('p3', { data: '2026-11-09', titolo: 'Corso BLSD' }), ev('lontano', { data: '2027-01-10' })];
const sent = [], scritti = []; let stato = null;
const fetchF = async (url, init = {}) => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.includes('oauth2')) return ok({ access_token: 't' });
  if (url.includes(':runQuery')) { const q = JSON.parse(init.body).structuredQuery, f = q.where.fieldFilter.field.fieldPath, v = q.where.fieldFilter.value.stringValue; return ok(eventi.filter(d => (d.fields[f] || {}).stringValue >= v).map(d => ({ document: d }))); }
  if (url.includes('fcm.googleapis')) { sent.push(JSON.parse(init.body).message); return ok({}); }
  if (init.method === 'PATCH') { scritti.push(url); return ok({}); }
  if (url.includes('/impostazioni')) return ok({ documents: stato ? [{ name: '.../impostazioni/calendario_push', fields: stato }] : [] });
  if (url.includes('/ruoli')) return ok({ documents: [['admin@x.it', 'Admin'], ['v1@x.it', 'Operatore'], ['v2@x.it', 'Operatore'], ['mon@x.it', 'Monitor']].map(([id, role]) => ({ name: '.../ruoli/' + id, fields: { role: S(role) } })) });
  if (url.includes('/calendario_adesioni')) return ok({ documents: [{ name: '.../calendario_adesioni/p3__v1@x.it', fields: { eventoId: S('p3'), utente: S('v1@x.it'), stato: S('si') } }] });
  if (url.includes('/calendario_proposte')) return ok({});
  if (url.includes('/push_dispositivi')) return ok({ documents: ['admin@x.it', 'v1@x.it', 'v2@x.it', 'mon@x.it'].map(e => ({ name: '.../push_dispositivi/' + e, fields: { token: S('tok-' + e), email: S(e) } })) });
  throw new Error('url non previsto ' + url);
};
let out = await main({ env, fetch: fetchF, ora }); assert.ok(out.primo); assert.equal(sent.length, 0, 'primo avvio: nessuna notifica'); assert.equal(scritti.length, 1);
stato = { nuovi: { arrayValue: { values: [] } }, promemoria: { arrayValue: { values: [] } } };
out = await main({ env, fetch: fetchF, ora });
const mappa = {}; sent.forEach(s => (mappa[s.data.tag] = mappa[s.data.tag] || []).push(s.token)); console.log(sent.map(s => s.token + ' <- ' + s.data.titolo));
assert.deepEqual(mappa['calendario-new-n1'].sort(), ['tok-admin@x.it', 'tok-v1@x.it', 'tok-v2@x.it']);
assert.deepEqual(mappa['calendario-ric-p3-3'].sort(), ['tok-admin@x.it', 'tok-v2@x.it'], 'v1 ha gia risposto, il monitor non e avvisato');
assert.equal(out.inviate, 2); assert.equal(Object.keys(mappa).length, 2);
console.log('TUTTI I TEST OK');
