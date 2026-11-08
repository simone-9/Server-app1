import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
const { proteggi, ripristina, leggiRisposta, promptRapporto, esegui, eseguiPendenti } = await import('../scripts/rapporto-ai.mjs');
// privacy
let p = proteggi('Chiamato Rossi al 333 1234567, mail a.b@x.it, CF RSSMRA80A01H501U, via Roma 12.');
assert.ok(!/333|a\.b@|RSSMRA/.test(p.testo)); assert.equal(p.mappa.length, 3);
assert.equal(ripristina(p.testo, p.mappa), 'Chiamato Rossi al 333 1234567, mail a.b@x.it, CF RSSMRA80A01H501U, via Roma 12.');
assert.equal(ripristina('perso il [DATO1]', p.mappa), null, 'segnaposto mancanti: null');
assert.equal(proteggi('Alle 12/11/2026 percorsi 45 km').mappa.length, 0, 'date e km non sono telefoni');
// risposta
assert.deepEqual(leggiRisposta('```json\n{"lavoro":"ok"}\n```'), { lavoro: 'ok' }); assert.equal(leggiRisposta('boh'), null);
const pr = promptRapporto({ tipo: 'Albero caduto', esito: 'Risolto' }, { lavoro: 'tagliato albero' }); assert.match(pr[1].content, /tagliato albero/); assert.ok(!/materiali \(/.test(pr[1].content)); assert.match(pr[0].content, /Non inventare|non inventare/i);
// esecuzione con rete finta
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@p.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'proj' }), GROQ_API_KEY: 'k' };
const S = v => ({ stringValue: v });
function prova(doc, risposteGroq) {
  const scritti = [], gruppi = [], cancellati = []; let groqCalls = 0, corrente = { ...doc };
  const f = async (url, init = {}) => {
    const ok = (j, st = 200) => ({ ok: st < 300, status: st, json: async () => j, headers: { get: () => null } });
    if (url.includes('oauth2')) return ok({ access_token: 't' });
    if (url.includes('api.groq.com')) { gruppi.push(JSON.parse(init.body)); const r = risposteGroq[Math.min(groqCalls++, risposteGroq.length - 1)]; return typeof r === 'number' ? ok({ error: { code: 'x' } }, r) : ok({ choices: [{ message: { content: r } }] }); }
    if (init.method === 'PATCH') { const f2 = JSON.parse(init.body).fields; for (const [k, v] of Object.entries(f2)) corrente[k] = v.stringValue ?? v.integerValue; scritti.push(Object.keys(f2)); return ok({}); }
    if (init.method === 'DELETE') { cancellati.push(url); return ok({}); }
    if (url.includes('rapporti_ai?pageSize')) return ok({ documents: [{ name: 'projects/proj/databases/(default)/documents/rapporti_ai/vecchio', fields: { creato: S('2020-01-01T00:00:00Z') } }, { name: 'projects/proj/databases/(default)/documents/rapporti_ai/nuovo', fields: { creato: S(new Date().toISOString()) } }] });
    if (url.includes('/rapporti_ai/')) return ok({ updateTime: '2026-11-08T10:00:00Z', fields: Object.fromEntries(Object.entries(corrente).map(([k, v]) => [k, S(String(v))])) });
    throw new Error('url non previsto ' + url);
  };
  return { f, scritti, gruppi, cancellati, stato: () => corrente };
}
const log = []; const L = m => log.push(m);
let t = prova({ stato: 'Richiesta', tipo: 'Albero caduto', esito: 'Risolto', lavoro: 'tagliato albero caduto in via roma chiamato 333 1234567', segue: '', materiali: 'motosega' }, ['{"lavoro":"Tagliato l\'albero caduto in via Roma. Contatto: [DATO1].","materiali":"Motosega.","criticita":"","segue":""}']);
assert.equal(await esegui('abc123', { env, fetch: t.f, log: L }), true);
assert.equal(t.stato().stato, 'Pronto'); assert.equal(t.stato().ai_lavoro, "Tagliato l'albero caduto in via Roma. Contatto: 333 1234567."); assert.equal(t.stato().ai_materiali, 'Motosega.'); assert.equal(t.stato().ai_segue, undefined);
assert.ok(!JSON.stringify(t.gruppi).includes('333 1234567'), 'il telefono non arriva a Groq');
assert.equal(t.cancellati.length, 1); assert.match(t.cancellati[0], /rapporti_ai\/vecchio$/);
assert.ok(!log.join(' ').includes('albero'), 'nessun testo nei log');
// segnaposto perso -> campo non modificato; nessun campo utile -> errore
t = prova({ stato: 'Richiesta', lavoro: 'chiamata al 333 1234567 fatta' }, ['{"lavoro":"Chiamata effettuata."}']);
assert.equal(await esegui('x1', { env, fetch: t.f, log: L }), false); assert.equal(t.stato().stato, 'Errore');
// testo gonfiato scartato
t = prova({ stato: 'Richiesta', lavoro: 'tagliato albero' }, ['{"lavoro":"' + 'Tagliato un grosso albero. '.repeat(20) + '"}']);
assert.equal(await esegui('x2', { env, fetch: t.f, log: L }), false);
// già preso in carico / non in stato Richiesta
t = prova({ stato: 'Pronto', lavoro: 'x' }, ['{}']); assert.equal(await esegui('x3', { env, fetch: t.f, log: L }), false); assert.equal(t.gruppi.length, 0);
// errore chiave Groq
t = prova({ stato: 'Richiesta', lavoro: 'tagliato albero' }, [401]); assert.equal(await esegui('x4', { env, fetch: t.f, log: L }), false); assert.match(t.stato().errore, /Chiave Groq/);
// modello di riserva dopo 404
t = prova({ stato: 'Richiesta', lavoro: 'tagliato albero caduto' }, [404, '{"lavoro":"Tagliato l\'albero caduto."}']); assert.equal(await esegui('x5', { env, fetch: t.f, log: L, attesa: 0 }), true);
await assert.rejects(() => esegui('../x', { env, fetch: t.f }), /ID non valido/);
// modo «riga»: una frase per la bacheca, senza segnaposto né a capo
t = prova({ stato: 'Richiesta', modo: 'riga', tipo: 'Albero caduto', esito: 'Risolto', lavoro: 'Tagliato albero caduto, chiamato 333 1234567' }, ['{"riga":"Rimosso un albero caduto sulla carreggiata [DATO1] e ripristinata la viabilità."}']);
assert.equal(await esegui('r1', { env, fetch: t.f, log: L }), true); assert.equal(t.stato().stato, 'Pronto'); assert.equal(t.stato().ai_riga, 'Rimosso un albero caduto sulla carreggiata e ripristinata la viabilità.');
assert.ok(!JSON.stringify(t.gruppi).includes('333 1234567'), 'telefono non inviato'); assert.match(JSON.stringify(t.gruppi[0].messages[0]), /UNA SOLA frase/);
t = prova({ stato: 'Richiesta', modo: 'riga', lavoro: 'x' }, ['{"riga":"' + 'a'.repeat(300) + '"}']); assert.equal(await esegui('r2', { env, fetch: t.f, log: L }), false); assert.equal(t.stato().stato, 'Errore');
t = prova({ stato: 'Richiesta', modo: 'riga', lavoro: '' }, ['{}']); assert.equal(await esegui('r3', { env, fetch: t.f, log: L }), false);
// giro programmato: prende in carico solo le richieste in stato «Richiesta» (Operatore SOC e Caposquadra non avviano il servizio da soli)
{
  const NOME = i => 'projects/proj/databases/(default)/documents/rapporti_ai/' + i, docs = { a1: { stato: 'Richiesta', lavoro: 'tagliato albero caduto' }, b2: { stato: 'Pronto', lavoro: 'x' }, c3: { stato: 'Richiesta', modo: 'riga', lavoro: 'rimosso albero' }, d4: { stato: 'In corso', lavoro: 'y' } };
  const chiamate = [], ok = (j, st = 200) => ({ ok: st < 300, status: st, json: async () => j, headers: { get: () => null } });
  const f = async (url, init = {}) => {
    if (url.includes('oauth2')) return ok({ access_token: 't' });
    if (url.includes('api.groq.com')) return ok({ choices: [{ message: { content: JSON.parse(init.body).messages[0].content.includes('UNA SOLA') ? '{"riga":"Albero rimosso."}' : '{"lavoro":"Tagliato l\'albero caduto."}' } }] });
    if (init.method === 'PATCH') { const id = url.split('/rapporti_ai/')[1].split('?')[0]; for (const [k, v] of Object.entries(JSON.parse(init.body).fields)) docs[id][k] = v.stringValue; chiamate.push(id); return ok({}); }
    if (url.includes('rapporti_ai?pageSize')) return ok({ documents: Object.entries(docs).map(([i, d]) => ({ name: NOME(i), fields: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, S(v)])) })) });
    const m = url.match(/\/rapporti_ai\/([^?]+)/); if (m) return ok({ updateTime: 't', fields: Object.fromEntries(Object.entries(docs[m[1]]).map(([k, v]) => [k, S(v)])) });
    throw new Error('url non previsto ' + url);
  };
  const log2 = []; const n = await eseguiPendenti({ env, fetch: f, log: m => log2.push(m) });
  assert.equal(n, 2); assert.equal(docs.a1.stato, 'Pronto'); assert.equal(docs.c3.stato, 'Pronto'); assert.equal(docs.b2.stato, 'Pronto'); assert.equal(docs.d4.stato, 'In corso');
  assert.ok(!log2.join(' ').includes('albero'), 'nessun testo nei log'); assert.match(log2[0], /in attesa: 2/);
}
console.log('RAPPORTO AI OK');
