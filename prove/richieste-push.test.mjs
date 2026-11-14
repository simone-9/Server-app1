import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
const { daNotificare, destinatari, messaggio, main } = await import('../scripts/richieste-push.mjs');
const { pushAmmesso } = await import('../scripts/push.mjs');
const ora = Date.parse('2026-11-06T12:00:00Z'), m = (min) => new Date(ora - min * 60000).toISOString();
const R = (id, c) => ({ id, campi: Object.assign({ id: 'REQ-' + id, tipo: 'Albero caduto', indirizzo: 'Via Roma 1', priorita: '2 - Media', stato: 'Nuova', squadra: '', creataIl: m(600) }, c) });
// --- pure
let r = daNotificare([R('a', { priorita: '1 - Alta', creataIl: m(5) })], null, ora); assert.equal(r.eventi.length, 0); assert.ok(r.primo); assert.deepEqual(r.stato.urgenti, ['a']);
r = daNotificare([R('a', { priorita: '1 - Alta', creataIl: m(5) })], r.stato, ora); assert.equal(r.eventi.length, 0, 'gia registrata');
r = daNotificare([R('b', { priorita: '1 - Alta', creataIl: m(5) }), R('c', { priorita: '2 - Media', creataIl: m(5) }), R('old', { priorita: '1 - Alta', creataIl: m(400) })], { urgenti: [], assegnate: [], rapporti: [] }, ora);
assert.deepEqual(r.eventi.map(e => e.id + ':' + e.tipo), ['b:urgente']);
r = daNotificare([R('d', { squadra: 'Alfa', assegnataIl: m(2), stato: 'Presa in carico' }), R('e', { squadra: 'Da Assegnare', assegnataIl: m(2) })], { urgenti: [], assegnate: [], rapporti: [] }, ora);
assert.deepEqual(r.eventi.map(e => e.id + ':' + e.tipo), ['d:assegnata']);
r = daNotificare([R('d', { squadra: 'Beta', assegnataIl: m(1) })], { urgenti: [], assegnate: ['d|Alfa'], rapporti: [] }, ora); assert.equal(r.eventi.length, 1, 'cambio squadra = nuova notifica');
r = daNotificare([R('f', { squadra: 'Alfa', stato: 'Completato', chiusura: m(10) }), R('g', { squadra: 'Alfa', stato: 'Completato', chiusura: m(10), rapporto: { compilatoIl: m(5) } }), R('h', { squadra: 'Alfa', stato: 'Completato', chiusura: m(3000) })], { urgenti: [], assegnate: [], rapporti: [] }, ora);
assert.deepEqual(r.eventi.map(e => e.id + ':' + e.tipo), ['f:rapporto']);
r = daNotificare([R('i', { priorita: '1 - Alta', creataIl: m(5), stato: 'Completato' })], { urgenti: [], assegnate: [], rapporti: [] }, ora); assert.equal(r.eventi.length, 0, 'urgente gia chiusa');
// la sala chiede notizie: una notifica per squadra e per domanda; non se la squadra ha già risposto o se è vecchia
const vuoto = () => ({ urgenti: [], assegnate: [], rapporti: [], notizie: [] });
r = daNotificare([R('n1', { squadra: 'Alfa', stato: 'In corso', notizieChieste: m(2) }), R('n2', { squadra: 'Alfa', stato: 'In corso', notizieChieste: m(2) }), R('n3', { squadra: 'Beta', stato: 'In corso', notizieChieste: m(2), ultimoContatto: m(1) }), R('n4', { squadra: 'Gamma', stato: 'In corso', notizieChieste: m(45) })], vuoto(), ora);
assert.deepEqual(r.eventi.map(e => e.id + ':' + e.tipo), ['n1:notizie']); assert.deepEqual(r.stato.notizie, ['Alfa|' + m(2)]);
r = daNotificare([R('n1', { squadra: 'Alfa', stato: 'In corso', notizieChieste: m(2) })], r.stato, ora); assert.equal(r.eventi.length, 0, 'domanda gia notificata');
r = daNotificare([R('n1', { squadra: 'Alfa', stato: 'In corso', notizieChieste: m(1) })], r.stato, ora); assert.equal(r.eventi.length, 1, 'nuova domanda = nuova notifica');
r = daNotificare([R('n1', { squadra: 'Alfa', stato: 'In corso', notizieChieste: m(2) })], { urgenti: [], assegnate: [], rapporti: [] }, ora); assert.equal(r.eventi.length, 1, 'stato vecchio senza notizie');
// problema segnalato dalla squadra: una notifica per segnalazione, solo se aperto, recente e la richiesta e' aperta
const vP = () => ({ urgenti: [], assegnate: [], rapporti: [], notizie: [], problemi: [] });
r = daNotificare([R('p1', { squadra: 'Alfa', stato: 'In corso', problemaAperto: true, problemaIl: m(2), problemaMotivo: 'Accesso impedito', problemaSquadra: 'Alfa' }), R('p2', { squadra: 'Alfa', stato: 'In corso', problemaAperto: false, problemaIl: m(2) }), R('p3', { squadra: 'Alfa', stato: 'In corso', problemaAperto: true, problemaIl: m(400) }), R('p4', { squadra: 'Alfa', stato: 'Completato', problemaAperto: true, problemaIl: m(2) })], vP(), ora);
assert.deepEqual(r.eventi.map(e => e.id + ':' + e.tipo), ['p1:problema']); assert.deepEqual(r.stato.problemi, ['p1|' + m(2)]);
r = daNotificare([R('p1', { squadra: 'Alfa', stato: 'In corso', problemaAperto: true, problemaIl: m(2) })], r.stato, ora); assert.equal(r.eventi.length, 0, 'problema gia notificato');
r = daNotificare([R('p1', { squadra: 'Alfa', stato: 'In corso', problemaAperto: true, problemaIl: m(1) })], r.stato, ora); assert.equal(r.eventi.length, 1, 'nuova segnalazione = nuova notifica');
r = daNotificare([R('p1', { squadra: 'Alfa', stato: 'In corso', problemaAperto: true, problemaIl: m(2) })], { urgenti: [], assegnate: [], rapporti: [] }, ora); assert.equal(r.eventi.length, 1, 'stato vecchio senza problemi');
const mpr = messaggio({ tipo: 'problema', id: 'p1', c: { id: 'REQ-9', tipo: 'Allagamento', indirizzo: 'Via Po 3', problemaMotivo: 'Pericolo sul posto', problemaNota: 'cavo a terra', problemaSquadra: 'Alfa' } }); assert.match(mpr.titolo, /PROBLEMA · Richiesta REQ-9 · Squadra Alfa/); assert.match(mpr.testo, /Pericolo sul posto: cavo a terra/); assert.equal(mpr.urgente, true); assert.match(mpr.tag, /^richiesta-prob-/);
const mn = messaggio({ tipo: 'notizie', id: 'n1', c: { squadra: 'Alfa', tipo: 'Frana', indirizzo: 'Via A' } }); assert.match(mn.titolo, /chiede notizie · Squadra Alfa/); assert.equal(mn.urgente, true); assert.match(mn.tag, /^richiesta-not-/);
// destinatari
const ruoli = [{ id: 'admin@x.it', campi: { role: 'Admin' } }, { id: 'soc@x.it', campi: { role: 'Operatore SOC' } }, { id: 'op@x.it', campi: { role: 'Operatore' } }, { id: 'cs@x.it', campi: { role: 'Caposquadra', volId: 'v1' } }, { id: 'v2@x.it', campi: { role: 'Operatore', volId: 'v2' } }, { id: 'v3@x.it', campi: { role: 'Operatore', volId: 'v3' } }];
const squadre = [{ id: 's1', campi: { nome: 'Alfa', membri: [{ volId: 'v1', capo: true }, { volId: 'v2' }] } }, { id: 's2', campi: { nome: 'Beta', membri: [{ volId: 'v3' }] } }];
assert.deepEqual(destinatari({ tipo: 'urgente', c: {} }, ruoli, squadre).sort(), ['admin@x.it', 'cs@x.it', 'soc@x.it']);
assert.deepEqual(destinatari({ tipo: 'problema', c: {} }, ruoli, squadre).sort(), ['admin@x.it', 'soc@x.it'], 'problema: solo Admin e SOC');
assert.deepEqual(destinatari({ tipo: 'assegnata', c: { squadra: 'Alfa' } }, ruoli, squadre).sort(), ['cs@x.it', 'v2@x.it']);
assert.deepEqual(destinatari({ tipo: 'assegnata', c: { squadra: 'x', squadraId: 's2' } }, ruoli, squadre), ['v3@x.it']);
assert.deepEqual(destinatari({ tipo: 'rapporto', c: { squadra: 'Alfa' } }, ruoli, squadre), ['cs@x.it']);
assert.deepEqual(destinatari({ tipo: 'rapporto', c: { squadra: 'Beta' } }, ruoli, squadre), ['v3@x.it']);
assert.deepEqual(destinatari({ tipo: 'assegnata', c: { squadra: 'Zeta' } }, ruoli, squadre), []);
assert.deepEqual(destinatari({ tipo: 'notizie', c: { squadra: 'Alfa' } }, ruoli, squadre), ['cs@x.it']); assert.deepEqual(destinatari({ tipo: 'notizie', c: { squadra: 'Beta' } }, ruoli, squadre), ['v3@x.it']);
// messaggio + preferenze
const mm = messaggio({ tipo: 'urgente', id: 'a', c: { id: 'REQ-007', tipo: 'Allagamento', indirizzo: 'Via Po 3', descrizione: 'acqua in casa' } }); assert.match(mm.titolo, /URGENTE · Richiesta REQ-007/); assert.equal(mm.tag, 'richiesta-urg-a');
assert.equal(pushAmmesso({ richieste: false }, 'richiesta-urg-a'), false); assert.equal(pushAmmesso({}, 'richiesta-urg-a'), true); assert.equal(pushAmmesso({ tutte: false }, 'richiesta-sq-1'), false); assert.equal(pushAmmesso({ bacheca: false }, 'richiesta-rap-1'), true);
// --- main con rete finta
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@p.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'proj' }) };
const S = v => ({ stringValue: v }), B = v => ({ booleanValue: v });
const fsDoc = (id, o) => ({ name: 'projects/proj/databases/(default)/documents/x/' + id, fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? S(v) : typeof v === 'boolean' ? B(v) : v])) });
const arr = (l) => ({ arrayValue: { values: l.map(x => ({ mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'boolean' ? B(v) : S(v)])) } })) } });
const reqs = { creataIl: [fsDoc('u1', { id: 'REQ-1', tipo: 'Frana', indirizzo: 'Via A', priorita: '1 - Alta', stato: 'Nuova', squadra: '', creataIl: m(5) })], assegnataIl: [fsDoc('u2', { id: 'REQ-2', tipo: 'Albero', indirizzo: 'Via B', priorita: '2 - Media', stato: 'Presa in carico', squadra: 'Alfa', creataIl: m(60), assegnataIl: m(1) })], chiusura: [fsDoc('u3', { id: 'REQ-3', tipo: 'Sabbia', indirizzo: 'Via C', priorita: '3 - Bassa', stato: 'Completato', squadra: 'Alfa', creataIl: m(300), chiusura: m(20) })] , problemaIl: [fsDoc('u5', { id: 'REQ-5', tipo: 'Allagamento', indirizzo: 'Via E', priorita: '2 - Media', stato: 'In corso', squadra: 'Alfa', creataIl: m(60), problemaAperto: true, problemaMotivo: 'Accesso impedito', problemaNota: 'cancello chiuso', problemaSquadra: 'Alfa', problemaIl: m(1) })], notizieChieste: [fsDoc('u4', { id: 'REQ-4', tipo: 'Allagamento', indirizzo: 'Via D', priorita: '2 - Media', stato: 'In corso', squadra: 'Alfa', creataIl: m(60), notizieChieste: m(3) })] };
const sent = [], scritti = []; let stato = null;
const fetchF = async (url, init = {}) => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.includes('oauth2')) return ok({ access_token: 't' });
  if (url.includes(':runQuery')) { const q = JSON.parse(init.body).structuredQuery, f = q.where.fieldFilter.field.fieldPath; return ok(reqs[f].filter(d => (d.fields[f] || {}).stringValue >= q.where.fieldFilter.value.stringValue).map(d => ({ document: d }))); }
  if (url.includes('fcm.googleapis')) { sent.push(JSON.parse(init.body).message); return ok({}); }
  if (init.method === 'PATCH') { scritti.push(url); return ok({}); }
  if (url.includes('/impostazioni')) return ok({ documents: stato ? [{ name: '.../impostazioni/richieste_push', fields: stato }] : [] });
  if (url.includes('/ruoli')) return ok({ documents: [['admin@x.it', { role: S('Admin') }], ['cs@x.it', { role: S('Caposquadra'), volId: S('v1') }], ['v2@x.it', { role: S('Operatore'), volId: S('v2') }], ['op@x.it', { role: S('Operatore') }]].map(([id, f]) => ({ name: '.../ruoli/' + id, fields: f })) });
  if (url.includes('/squadre_operative')) return ok({ documents: [{ name: '.../squadre_operative/s1', fields: { nome: S('Alfa'), membri: arr([{ volId: 'v1', capo: true }, { volId: 'v2' }]) } }] });
  if (url.includes('/push_dispositivi')) return ok({ documents: ['admin@x.it', 'cs@x.it', 'v2@x.it', 'op@x.it'].map(e => ({ name: '.../push_dispositivi/' + e, fields: { token: S('tok-' + e), email: S(e) } })) });
  throw new Error('url non previsto ' + url);
};
let out = await main({ env, fetch: fetchF, ora }); assert.ok(out.primo); assert.equal(sent.length, 0, 'primo avvio: nessuna notifica'); assert.equal(scritti.length, 1);
stato = { urgenti: { arrayValue: { values: [] } }, assegnate: { arrayValue: { values: [] } }, rapporti: { arrayValue: { values: [] } }, notizie: { arrayValue: { values: [] } } };
out = await main({ env, fetch: fetchF, ora });
const per = Object.fromEntries(sent.map(s => [s.token, (per0 => per0)(s.data.tag)])); console.log(sent.map(s => s.token + ' <- ' + s.data.titolo));
const mappa = {}; sent.forEach(s => (mappa[s.data.tag] = mappa[s.data.tag] || []).push(s.token));
assert.deepEqual(mappa['richiesta-urg-u1'].sort(), ['tok-admin@x.it', 'tok-cs@x.it']);
assert.deepEqual(mappa['richiesta-sq-u2'].sort(), ['tok-cs@x.it', 'tok-v2@x.it']);
assert.deepEqual(mappa['richiesta-rap-u3'], ['tok-cs@x.it']);
assert.deepEqual(mappa['richiesta-not-u4'], ['tok-cs@x.it']);
assert.deepEqual(mappa['richiesta-prob-u5'], ['tok-admin@x.it'], 'problema: solo Admin e SOC (qui solo l\'admin ha il ruolo)');
assert.equal(out.inviate, 5);
console.log('TUTTI I TEST OK');
