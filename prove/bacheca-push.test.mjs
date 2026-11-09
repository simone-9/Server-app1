import assert from 'node:assert/strict';
const { daNotificare, daSollecitare, hannoRisposto, SOLLECITO_DOPO_MS } = await import('../scripts/bacheca-push.mjs');
const ora = Date.parse('2026-11-09T18:00:00Z'), m = (min) => new Date(ora - min * 60000).toISOString(), oggi = '2026-11-09';
const A = (id, c) => ({ id, campi: Object.assign({ titolo: 'Avviso ' + id, testo: 't', creato: m(1) }, c) });
// notifiche nuove: invariato
let r = daNotificare([A('x')], { notificati: [] }, ora, oggi); assert.deepEqual(r.invia.map(a => a.id), ['x']);
// sollecito: solo chiamate già notificate, tra 30 e 120 minuti, una volta, non scadute
const avvisi = [A('c35', { chiamata: true, creato: m(35) }), A('c10', { chiamata: true, creato: m(10) }), A('c200', { chiamata: true, creato: m(200) }), A('n35', { creato: m(35) }), A('cs', { chiamata: true, creato: m(40), scade: '2026-11-08' }), A('cn', { chiamata: true, creato: m(50) })];
const notif = ['c35', 'c10', 'c200', 'n35', 'cs'];
assert.deepEqual(daSollecitare(avvisi, notif, { sollecitati: [] }, ora, oggi).map(a => a.id), ['c35'], 'solo c35 (cn non ancora notificata)');
assert.deepEqual(daSollecitare(avvisi, notif, { sollecitati: ['c35'] }, ora, oggi).map(a => a.id), [], 'gia sollecitata');
assert.equal(SOLLECITO_DOPO_MS, 30 * 60000);
// chi ha risposto
const risp = [{ id: 'c35__a@x.it', campi: { avvisoId: 'c35', utente: 'A@x.it', risposta: 'si' } }, { id: 'c35__b@x.it', campi: { avvisoId: 'c35', utente: 'b@x.it', risposta: 'no' } }, { id: 'c10__c@x.it', campi: { avvisoId: 'c10', utente: 'c@x.it', risposta: 'si' } }];
assert.deepEqual(hannoRisposto(risp, 'c35').sort(), ['a@x.it', 'b@x.it']);
// --- main con rete finta: la chiamata c35 è già notificata; risponde a@x.it, il creatore è cre@x.it
const { generateKeyPairSync } = await import('node:crypto');
const { main } = await import('../scripts/bacheca-push.mjs');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@p.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'proj' }) };
const S = v => ({ stringValue: v }), B = v => ({ booleanValue: v }), ARR = l => ({ arrayValue: { values: l.map(S) } });
const sent = [], scritti = [];
const fetchF = async (url, init = {}) => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.includes('oauth2')) return ok({ access_token: 't' });
  if (url.includes('fcm.googleapis')) { sent.push(JSON.parse(init.body).message); return ok({}); }
  if (init.method === 'PATCH') { scritti.push(JSON.parse(init.body)); return ok({}); }
  if (url.includes('/bacheca_avvisi')) return ok({ documents: [{ name: '.../bacheca_avvisi/c35', fields: { titolo: S('Allagamento'), testo: S('Ritrovo in sede'), chiamata: B(true), urgente: B(true), creato: S(m(35)), creatoEmail: S('cre@x.it') } }] });
  if (url.includes('/impostazioni')) return ok({ documents: [{ name: '.../impostazioni/bacheca_push', fields: { notificati: ARR(['c35']) } }] });
  if (url.includes('/bacheca_risposte')) return ok({ documents: [{ name: '.../bacheca_risposte/c35__a', fields: { avvisoId: S('c35'), utente: S('a@x.it'), risposta: S('si') } }] });
  if (url.includes('/push_dispositivi')) return ok({ documents: ['a@x.it', 'b@x.it', 'cre@x.it', 'd@x.it'].map(e => ({ name: '.../push_dispositivi/' + e, fields: Object.assign({ token: S('tok-' + e), email: S(e) }, e === 'd@x.it' ? { nativo: B(true) } : {}) })) });
  throw new Error('url non previsto ' + url);
};
let out = await main({ env, fetch: fetchF, ora, oggi });
assert.equal(out.solleciti, 1); assert.deepEqual(sent.map(x => x.token).sort(), ['tok-b@x.it', 'tok-d@x.it'], 'solo chi non ha risposto, escluso il creatore');
assert.match(sent[0].data.titolo, /NON HAI ANCORA RISPOSTO/); assert.equal(sent.find(x => x.token === 'tok-d@x.it').data.tipo, 'allarme', 'entro la prima ora suona la sveglia sull\'app Android');
assert.ok(JSON.stringify(scritti).includes('c35'), 'sollecito ricordato');
console.log('BACHECA PUSH OK');
