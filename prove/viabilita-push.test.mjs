import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
const { daNotificare, destinatari, messaggio, main } = await import('../scripts/viabilita-push.mjs');
const ora = Date.parse('2026-11-14T12:00:00Z'), m = (min) => new Date(ora - min * 60000).toISOString();
const S = (id, c) => ({ id, campi: Object.assign({ stato: 'proposta', tipo: 'chiusa', titolo: 'Sottopasso allagato', strada: 'Via Roma', ts: m(3) }, c) });
// solo proposte nuove, non notificate e recenti
let r = daNotificare([S('a'), S('b', { notificata: true }), S('c', { stato: 'confermata' }), S('d', { ts: m(60 * 30) }), S('e', { stato: 'scartata' })], ora);
assert.deepEqual(r.map(x => x.id), ['a']);
assert.equal(daNotificare([S('x', { ts: undefined })], ora).length, 1, 'senza data: si notifica');
assert.equal(daNotificare(null, ora).length, 0);
// destinatari: Admin sempre, poi livello scrivi per ruolo o per utente
const ruoli = [{ id: 'Admin@x.it', campi: { role: 'Admin' } }, { id: 'soc@x.it', campi: { role: 'Operatore SOC' } }, { id: 'capo@x.it', campi: { role: 'Caposquadra' } }, { id: 'vol@x.it', campi: { role: 'Volontario' } }];
assert.deepEqual(destinatari(ruoli, null), ['admin@x.it', 'soc@x.it'], 'senza permessi: Admin e Operatore SOC');
assert.deepEqual(destinatari(ruoli, { ruoli: { 'Operatore SOC': { mod_viabilita: 'leggi' }, Caposquadra: { mod_viabilita: 'scrivi' } } }), ['admin@x.it', 'capo@x.it']);
assert.deepEqual(destinatari(ruoli, { ruoli: { 'Operatore SOC': { mod_viabilita: 'limitato' } }, utenti: { 'vol@x.it': { mod_viabilita: 'scrivi' }, 'soc@x.it': { mod_viabilita: 'nessuno' } } }), ['admin@x.it', 'vol@x.it']);
// messaggio: una notifica sola, apre la sezione «Da verificare»
let n = messaggio([S('a')]); assert.equal(n.titolo, 'Viabilità · 1 segnalazione da verificare'); assert.match(n.testo, /Sottopasso allagato · Via Roma/); assert.equal(n.url, './?apri=mod_viabilita&sez=verifica'); assert.match(n.tag, /^viabilita-/);
n = messaggio([S('a'), S('b', { titolo: '' , tipo: 'acqua' }), S('c'), S('d')]); assert.equal(n.titolo, 'Viabilità · 4 segnalazioni da verificare'); assert.match(n.testo, /Allagamento · Via Roma/); assert.match(n.testo, /e altre 2$/);
// --- main con rete finta
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@p.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'proj' }) };
const Sv = v => ({ stringValue: v }), Bv = v => ({ booleanValue: v });
const fd = (nome, o) => ({ name: 'projects/proj/databases/(default)/documents/' + nome, fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? Bv(v) : typeof v === 'string' ? Sv(v) : v])) });
let attivo = true; const sent = [], patch = [];
const segn = [fd('moduli_dati/viabilita/segnalazioni/p1', { stato: 'proposta', tipo: 'chiusa', titolo: 'Strada chiusa', strada: 'Via Po', ts: m(2) }), fd('moduli_dati/viabilita/segnalazioni/p2', { stato: 'proposta', tipo: 'acqua', titolo: 'Allagamento', strada: 'Via A', ts: m(1), notificata: true }), fd('moduli_dati/viabilita/segnalazioni/c1', { stato: 'confermata', tipo: 'chiusa', ts: m(9) })];
const fetchF = async (url, init = {}) => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.includes('oauth2')) return ok({ access_token: 't' });
  if (url.includes('fcm.googleapis')) { sent.push(JSON.parse(init.body).message); return ok({}); }
  if (init.method === 'PATCH') { patch.push(url); return ok({}); }
  if (url.includes('/impostazioni?')) return ok({ documents: [fd('impostazioni/moduli', { attivi: { mapValue: { fields: { viabilita: Bv(attivo) } } } })] });
  if (url.includes('/segnalazioni')) return ok({ documents: segn });
  if (url.includes('/ruoli')) return ok({ documents: [fd('ruoli/admin@x.it', { role: 'Admin' }), fd('ruoli/op@x.it', { role: 'Operatore' })] });
  if (url.includes('/push_dispositivi')) return ok({ documents: ['admin@x.it', 'op@x.it'].map(e => fd('push_dispositivi/' + e, { token: 'tok-' + e, email: e })) });
  throw new Error('url non previsto ' + url);
};
let out = await main({ env, fetch: fetchF, ora }); assert.equal(out.segnalazioni, 1);
assert.equal(sent.length, 1, 'solo Admin (Operatore senza livello scrivi)'); assert.equal(sent[0].token, 'tok-admin@x.it'); assert.equal(sent[0].data.url, './?apri=mod_viabilita&sez=verifica'); assert.equal(sent[0].data.tag, 'viabilita-verifica');
assert.equal(patch.length, 1); assert.match(patch[0], /segnalazioni\/p1\?updateMask\.fieldPaths=notificata/);
attivo = false; sent.length = 0; out = await main({ env, fetch: fetchF, ora }); assert.ok(out.spento); assert.equal(sent.length, 0, 'modulo spento: niente');
out = await main({ env: {}, fetch: fetchF, ora }); assert.ok(out.saltato);
console.log('viabilita-push: ok');
