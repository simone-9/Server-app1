// Rapporto di intervento: l'AI (Groq) rivede la forma dei testi (lavoro svolto, materiali, criticità, da fare).
//
//   node scripts/rapporto-ai.mjs <id>    legge il documento «rapporti_ai/<id>» scritto dall'app, chiede a Groq la versione rivista e la riscrive nello stesso documento
//
// Segreti richiesti: FIREBASE_SERVICE_ACCOUNT, GROQ_API_KEY (gli stessi delle richieste agli enti). Facoltativi: GROQ_MODEL, GRUPPO_ID.
//
// PRIVACY: i log di GitHub contengono solo l'ID e l'esito, mai testi. All'AI arrivano soltanto i campi scelti dall'utente nell'app,
// senza nomi, indirizzo, squadra, firma e foto; telefoni, email, codici fiscali e IBAN sono sostituiti da segnaposto che l'AI non
// vede e che vengono rimessi al loro posto qui, dopo la risposta. I documenti di lavoro vengono cancellati dall'app a fine uso
// e comunque da questo script dopo 24 ore.
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const GRUPPO = (process.env.GRUPPO_ID || '').trim().toLowerCase();
export const COLLEZIONE = 'rapporti_ai';
const PREF = GRUPPO ? `gruppi/${GRUPPO}/` : '';
export const CAMPI = ['lavoro', 'materiali', 'criticita', 'segue'];
const MODELLI_PREDEFINITI = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const pausa = ms => new Promise(r => setTimeout(r, ms));

// ---------- Firestore (API REST con l'account di servizio) ----------
export function chiaveServizio(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw.trim()) throw new Error('Segreto FIREBASE_SERVICE_ACCOUNT mancante');
  let k; try { k = JSON.parse(raw); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT non è un JSON valido'); }
  if (!k.client_email || !k.private_key || !k.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT incompleto');
  return k;
}
async function accessToken(k, f) {
  const ora = Math.floor(Date.now() / 1000);
  const corpo = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: ora, exp: ora + 3000 }));
  const firma = b64u(createSign('RSA-SHA256').update(corpo).sign(k.private_key));
  const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + corpo + '.' + firma });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Accesso a Google non riuscito (' + r.status + ')');
  return j.access_token;
}
function aFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(aFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, aFs(x)])) } };
}
function daFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(daFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, daFs(x)]));
  return null;
}
const radice = env => env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1';
const fsBase = (k, env) => radice(env) + `/projects/${k.project_id}/databases/(default)/documents`;
async function leggi(ctx, id) {
  const r = await ctx.f(`${ctx.base}/${PREF}${COLLEZIONE}/${encodeURIComponent(id)}`, { headers: { authorization: 'Bearer ' + ctx.tok } });
  if (r.status === 404) throw new Error('Richiesta non trovata');
  if (!r.ok) throw new Error('Lettura non riuscita (' + r.status + ')');
  const j = await r.json();
  return { dati: Object.fromEntries(Object.entries(j.fields || {}).map(([k, x]) => [k, daFs(x)])), updateTime: j.updateTime };
}
async function scrivi(ctx, id, campi, updateTime) {
  const maschera = Object.keys(campi).map(c => 'updateMask.fieldPaths=' + encodeURIComponent(c)).join('&');
  const cond = updateTime ? 'currentDocument.updateTime=' + encodeURIComponent(updateTime) : 'currentDocument.exists=true';
  const r = await ctx.f(`${ctx.base}/${PREF}${COLLEZIONE}/${encodeURIComponent(id)}?${maschera}&${cond}`, { method: 'PATCH', headers: { authorization: 'Bearer ' + ctx.tok, 'content-type': 'application/json' }, body: JSON.stringify({ fields: aFs(campi).mapValue.fields }) });
  if (!r.ok) { const e = new Error('Scrittura non riuscita (' + r.status + ')'); e.status = r.status; throw e; }
}
// cancella i documenti di lavoro rimasti (più vecchi di 24 ore)
export async function pulisciVecchi(ctx, ora = Date.now()) {
  let n = 0;
  try {
    const r = await ctx.f(`${ctx.base}/${PREF}${COLLEZIONE}?pageSize=100`, { headers: { authorization: 'Bearer ' + ctx.tok } });
    if (!r.ok) return 0;
    const j = await r.json();
    for (const d of (j.documents || [])) {
      const c = daFs({ mapValue: { fields: d.fields || {} } }) || {};
      const t = Date.parse(c.creato || d.createTime || '');
      if (!isNaN(t) && ora - t > 24 * 3600 * 1000) {
        const x = await ctx.f(radice(ctx.env) + '/' + d.name, { method: 'DELETE', headers: { authorization: 'Bearer ' + ctx.tok } });
        if (x.ok) n++;
      }
    }
  } catch (e) {}
  return n;
}

// ---------- privacy: segnaposto per i dati personali (l'AI non li vede, tornano al loro posto dopo) ----------
export function proteggi(testo) {
  const mappa = [];
  const sost = (re, ok) => { testo = testo.replace(re, (m) => { if (ok && !ok(m)) return m; mappa.push(m); return `[DATO${mappa.length}]`; }); };
  sost(/[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}/gi);
  sost(/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi);
  sost(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g);
  sost(/(?<![\d/])\+?\d[\d\s().\-]{7,}\d(?![\d/])/g, s => s.replace(/\D/g, '').length >= 9);
  return { testo, mappa };
}
// rimette i dati al loro posto; se l'AI ne ha perso qualcuno restituisce null (il campo resta com'era)
export function ripristina(testo, mappa) {
  for (let i = 0; i < mappa.length; i++) if (!testo.includes(`[DATO${i + 1}]`)) return null;
  return testo.replace(/\[DATO(\d+)\]/g, (m, n) => mappa[Number(n) - 1] ?? m);
}

// ---------- Groq ----------
export function promptRapporto(dati, campi) {
  const sist = [
    'Sei un assistente che rivede i testi di un rapporto di fine intervento di un gruppo comunale di Protezione Civile.',
    'Riscrivi ciascun campo in italiano corretto, chiaro, sintetico e formale, in forma impersonale (esempio: «Rimosso l\'albero dalla carreggiata e ripristinata la viabilità.»).',
    'Regole:',
    '- Usa SOLO le informazioni presenti nel testo. Non inventare fatti, numeri, orari, luoghi, nomi, mezzi, materiali, cause o conseguenze, e non aggiungere valutazioni.',
    '- Mantieni invariati numeri, misure, sigle e i segnaposto tra parentesi quadre come [DATO1]: devono comparire identici nel testo riscritto.',
    '- Correggi errori di ortografia, punteggiatura e maiuscole; elimina ripetizioni; se il testo è tutto maiuscolo usa le maiuscole normali.',
    '- Non allungare: il testo riscritto deve essere lungo più o meno quanto l\'originale.',
    '- Un campo non fornito o vuoto resta una stringa vuota.',
    'Rispondi SOLO con un oggetto JSON con queste chiavi, senza altro testo: ' + JSON.stringify(Object.fromEntries(CAMPI.map(c => [c, '']))) + '.'
  ].join('\n');
  const righe = [`Tipo di intervento: ${dati.tipo || 'non indicato'}`, `Esito: ${dati.esito || 'non indicato'}`];
  const ETI = { lavoro: 'Lavoro svolto', materiali: 'Materiali e attrezzature usati', criticita: 'Criticità e danni', segue: 'Da fare / segue' };
  CAMPI.forEach(c => { if (campi[c]) righe.push(`${c} (${ETI[c]}):\n${campi[c]}`); });
  return [{ role: 'system', content: sist }, { role: 'user', content: righe.join('\n\n') }];
}
// Riepilogo di una riga per la bacheca (modo «riga»): una sola frase, senza nomi, indirizzi né telefoni
export function promptRiga(dati, testo) {
  const sist = [
    'Sei un assistente che scrive un breve riepilogo per i volontari di un gruppo comunale di Protezione Civile, alla fine di un intervento.',
    'Scrivi UNA SOLA frase in italiano, impersonale, chiara e neutra, di al massimo 140 caratteri, che dice che cosa è stato fatto.',
    'Regole:',
    '- Usa SOLO le informazioni fornite. Non inventare fatti, numeri, luoghi, cause o conseguenze, e non aggiungere valutazioni.',
    '- Non citare nomi di persone, indirizzi, numeri di telefono né segnaposto tra parentesi quadre.',
    '- Nessun elenco, nessuna formattazione, niente emoji.',
    'Rispondi SOLO con un oggetto JSON: {"riga": ""}.'
  ].join('\n');
  const righe = [`Tipo di intervento: ${dati.tipo || 'non indicato'}`, `Esito: ${dati.esito || 'non indicato'}`, `Lavoro svolto:\n${testo}`];
  return [{ role: 'system', content: sist }, { role: 'user', content: righe.join('\n\n') }];
}
async function rigaDaTesto(ctx, id, dati, log) {
  const t = String(dati.lavoro || '').trim().slice(0, 1500);
  if (!t) throw new Error('Nessun testo da riassumere');
  const p = proteggi(t);
  const { testo, modello } = await chiamaGroq(ctx, promptRiga({ tipo: String(dati.tipo || '').slice(0, 80), esito: String(dati.esito || '').slice(0, 60) }, p.testo));
  const out = leggiRisposta(testo);
  let riga = out && typeof out.riga === 'string' ? out.riga.replace(/\s*\[DATO\d+\]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!riga || riga.length > 220) throw new Error('Il modello non ha prodotto una riga utilizzabile');
  await scrivi(ctx, id, { ai_riga: riga, stato: 'Pronto', modello, pronto: new Date().toISOString(), errore: '' });
  log(`[rapporto-ai] ${id}: riga pronta (modello ${modello})`);
  return true;
}
export function leggiRisposta(testo) {
  const t = String(testo || '').replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(t.slice(a, b + 1)); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
}
async function chiamaGroq(ctx, messaggi) {
  const chiave = ctx.env.GROQ_API_KEY;
  if (!chiave) throw new Error('Segreto GROQ_API_KEY mancante');
  const base = ctx.env.GROQ_BASE || 'https://api.groq.com/openai/v1';
  const modelli = [...new Set([(ctx.env.GROQ_MODEL || '').trim(), ...MODELLI_PREDEFINITI].filter(Boolean))];
  let ultimo = 'nessun modello disponibile';
  for (const modello of modelli) {
    for (let tentativo = 0; tentativo < 3; tentativo++) {
      const r = await ctx.f(base + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + chiave, 'content-type': 'application/json' }, body: JSON.stringify({ model: modello, messages: messaggi, temperature: 0.2, max_completion_tokens: 2000 }) });
      if (r.status === 401 || r.status === 403) throw new Error('Chiave Groq non valida o senza permessi');
      if (r.status === 429) { ultimo = 'limite di richieste Groq raggiunto'; const s = Math.min(Number(r.headers?.get?.('retry-after')) || 5, 20); if (tentativo < 2) { await pausa((ctx.attesa ?? 1) * s * 1000); continue; } break; }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const cod = String(j?.error?.code || '') + ' ' + String(j?.error?.message || '');
        ultimo = 'Groq ha risposto ' + r.status;
        if (/model_not_found|decommission|does not exist|not supported|no longer/i.test(cod) || r.status === 404) break;
        throw new Error(ultimo + (j?.error?.code ? ' (' + String(j.error.code).slice(0, 60) + ')' : ''));
      }
      const j = await r.json();
      const testo = j?.choices?.[0]?.message?.content;
      if (!testo || !String(testo).trim()) { ultimo = 'risposta vuota da ' + modello; break; }
      return { testo: String(testo), modello };
    }
  }
  throw new Error('Nessun modello Groq ha risposto: ' + ultimo);
}

// ---------- azione ----------
export async function esegui(id, deps = {}) {
  const env = deps.env || process.env, f = deps.fetch || fetch, log = deps.log || console.log;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('ID non valido');
  const k = chiaveServizio(env);
  const ctx = { f, env, base: fsBase(k, env), tok: await accessToken(k, f), attesa: deps.attesa };
  const { dati, updateTime } = await leggi(ctx, id);
  if (dati.stato !== 'Richiesta') { log(`[rapporto-ai] ${id}: stato «${dati.stato}», niente da fare`); return false; }
  try { await scrivi(ctx, id, { stato: 'In corso', errore: '' }, updateTime); } catch (e) { log(`[rapporto-ai] ${id}: già preso in carico`); return false; }
  try {
    if (dati.modo === 'riga') { const ok = await rigaDaTesto(ctx, id, dati, log); const n = await pulisciVecchi(ctx); if (n) log(`[rapporto-ai] pulizia: ${n} documenti vecchi cancellati`); return ok; }
    const campi = {}, mappe = {};
    CAMPI.forEach(c => {
      const t = String(dati[c] || '').trim().slice(0, 2000);
      if (!t) return;
      const p = proteggi(t); campi[c] = p.testo; mappe[c] = p.mappa;
    });
    if (!Object.keys(campi).length) throw new Error('Nessun testo da rivedere');
    const { testo, modello } = await chiamaGroq(ctx, promptRapporto({ tipo: String(dati.tipo || '').slice(0, 80), esito: String(dati.esito || '').slice(0, 60) }, campi));
    const out = leggiRisposta(testo);
    if (!out) throw new Error('Risposta del modello non leggibile');
    const risultato = {}; let saltati = 0, fatti = 0;
    for (const c of Object.keys(campi)) {
      const t = typeof out[c] === 'string' ? out[c].trim() : '';
      if (!t || t.length > campi[c].length * 2 + 120) { saltati++; continue; }   // vuoto o gonfiato: si tiene l'originale
      const r = ripristina(t, mappe[c]);
      if (r === null) { saltati++; continue; }
      risultato['ai_' + c] = r; fatti++;
    }
    if (!fatti) throw new Error('Il modello non ha prodotto un testo utilizzabile');
    await scrivi(ctx, id, { ...risultato, stato: 'Pronto', modello, saltati, pronto: new Date().toISOString(), errore: '' });
    log(`[rapporto-ai] ${id}: pronto (modello ${modello}, campi ${fatti}${saltati ? ', non modificati ' + saltati : ''})`);
    const n = await pulisciVecchi(ctx); if (n) log(`[rapporto-ai] pulizia: ${n} documenti vecchi cancellati`);
    return true;
  } catch (e) {
    await scrivi(ctx, id, { stato: 'Errore', errore: String(e.message || e).slice(0, 300) }).catch(() => {});
    log(`[rapporto-ai] ${id}: errore - ${String(e.message || e).slice(0, 120)}`);
    return false;
  }
}

// giro programmato: chi non è amministratore (Operatore SOC, Caposquadra) non può avviare il servizio da solo, quindi qui si
// prendono in carico tutte le richieste rimaste in stato «Richiesta» (una per volta, il testo non compare mai nel log)
export async function eseguiPendenti(deps = {}) {
  const env = deps.env || process.env, f = deps.fetch || fetch, log = deps.log || console.log;
  const k = chiaveServizio(env), base = fsBase(k, env), tok = await accessToken(k, f);
  const r = await f(`${base}/${PREF}${COLLEZIONE}?pageSize=100`, { headers: { authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error('Elenco non riuscito (' + r.status + ')');
  const j = await r.json(), ids = [];
  for (const d of (j.documents || [])) {
    const c = daFs({ mapValue: { fields: d.fields || {} } }) || {};
    const id = String(d.name || '').split('/').pop();
    if (c.stato === 'Richiesta' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) ids.push(id);
  }
  log(`[rapporto-ai] richieste in attesa: ${ids.length}`);
  let fatte = 0;
  for (const id of ids) { try { if (await esegui(id, deps)) fatte++; } catch (e) { log(`[rapporto-ai] ${id}: errore - ${String(e.message || e).slice(0, 120)}`); } }
  return fatte;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.argv[2] || process.env.ID_RICHIESTA || '';
  if (!id) eseguiPendenti().then(() => process.exit(0)).catch(e => { console.error('Errore: ' + (e.message || e)); process.exit(1); });
  else esegui(id).then(ok => { process.exit(ok === false ? 1 : 0); }).catch(e => { console.error('Errore: ' + (e.message || e)); process.exit(1); });
}
