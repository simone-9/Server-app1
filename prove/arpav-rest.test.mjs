import assert from 'node:assert/strict';
const { tempoRest, idstazDi, unisci, serieDa, integraDaRest } = await import('../scripts/arpav-rest.mjs');
// ora solare (UTC+1)
assert.equal(new Date(tempoRest('2026-11-10T15:20:00')).toISOString(), '2026-11-10T14:20:00.000Z');
assert.ok(isNaN(tempoRest('boh')));
// codice della stazione dal file XML
const xml = '<STAZIONE><IDSTAZ>283</IDSTAZ><NOME>Barzizza</NOME><SENSORE><ID>300005751</ID></SENSORE><SENSORE><ID>300005752</ID></SENSORE></STAZIONE><STAZIONE><IDSTAZ>302</IDSTAZ><SENSORE><ID>300005777</ID></SENSORE></STAZIONE>';
assert.equal(idstazDi(xml, '300005777'), 302); assert.equal(idstazDi(xml, '300005752'), 283); assert.equal(idstazDi(xml, '999'), null);
// unione: solo misure più recenti, niente doppioni, finestra di ~48 ore
const T = Date.parse('2026-11-10T12:10:00Z');
let u = unisci([[T - 600000, -0.29], [T, -0.29]], [[T - 600000, 9], [T, 9], [T + 600000, -0.30], [T + 1200000, -0.30], [T + 1200000, -0.31]]);
assert.equal(u.aggiunti, 2); assert.deepEqual(u.serie.slice(-2), [[T + 600000, -0.30], [T + 1200000, -0.30]]);
u = unisci([[T - 60 * 3600000, 1], [T, 2]], [[T + 600000, 3]]); assert.equal(u.serie.length, 2, 'misure oltre le 49 ore tolte');
// sensore scelto
const righe = [{ tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 2', dataora: '2026-11-10T15:20:00', valore: '9.9' }, { tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T15:20:00', valore: '-0.30' }, { tipo: 'PORT', nome_sensore: 'Portata', dataora: '2026-11-10T15:10:00', valore: '15.69' }];
assert.deepEqual(serieDa(righe, 'LIDRO'), [[Date.parse('2026-11-10T14:20:00Z'), -0.30]]);
assert.deepEqual(serieDa(righe, 'PORT'), [[Date.parse('2026-11-10T14:10:00Z'), 15.69]]);
// integrazione con rete finta
const risposte = {
  meteo_idroOggi: { success: true, data: [{ codice_stazione: 302, codseqst: 300001741 }, { codice_stazione: 283, codseqst: 300001722 }] },
  '300001741': { success: true, data: [{ tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T13:10:00', valore: '-0.29' }, { tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T15:20:00', valore: '-0.30' }] },
  '300001722': { success: true, data: [{ tipo: 'LIDRO', nome_sensore: 'Livello idrometrico 1', dataora: '2026-11-10T15:20:00', valore: '0.57' }, { tipo: 'PORT', nome_sensore: 'Portata', dataora: '2026-11-10T14:20:00', valore: '15.69' }] }
};
const fetchF = async (url) => { const k = url.includes('meteo_idroOggi') ? 'meteo_idroOggi' : (url.match(/codseqst=(\d+)/) || [])[1]; const j = risposte[k]; return j ? { ok: true, json: async () => j } : { ok: false, status: 404, json: async () => ({}) }; };
const st = {
  '300005777': { nome: 'Limena', ids: 302, dati: [[Date.parse('2026-11-10T12:10:00Z'), -0.29]], q: [], qu: '' },
  '300005751': { nome: 'Barzizza', ids: 283, dati: [[Date.parse('2026-11-10T12:20:00Z'), 0.58]], q: [[Date.parse('2026-11-10T12:20:00Z'), 15.7]], qu: 'm³/s' },
  '300011337': { nome: 'Levico (TN)', ids: 999, dati: [[1, 1]], q: [] },
  'senza': { nome: 'Senza codice', dati: [] }
};
const log = []; const r = await integraDaRest(st, { fetch: fetchF, log: x => log.push(x) });
assert.deepEqual(r, { stazioni: 2, misure: 3, errori: 0, lette: 2 });
assert.equal(new Date(st['300005777'].dati.at(-1)[0]).toISOString(), '2026-11-10T14:20:00.000Z'); assert.equal(st['300005777'].dati.length, 2);
assert.equal(st['300005751'].q.length, 2); assert.equal(st['300011337'].dati.length, 1);
// servizio giù: nessun errore, dati invariati
const st2 = { a: { nome: 'A', ids: 302, dati: [[1, 1]] } };
const r2 = await integraDaRest(st2, { fetch: async () => { throw new Error('rete'); }, log: () => {} });
assert.equal(r2.errori, 1); assert.deepEqual(st2.a.dati, [[1, 1]]);
const r3 = await integraDaRest(st2, { fetch: async () => ({ ok: true, json: async () => ({ success: false }) }), log: () => {} });
assert.equal(r3.errori, 1);
console.log('TUTTI I TEST OK');
