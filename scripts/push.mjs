// Notifiche push dell'app (Firebase Cloud Messaging) senza dipendenze: solo Node 20.
// Legge i dispositivi registrati dall'app nella raccolta Firestore «push_dispositivi» e invia un messaggio a ciascuno.
// Richiede il segreto FIREBASE_SERVICE_ACCOUNT (JSON della chiave dell'account di servizio). Se manca, non fa nulla.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Più gruppi sullo stesso Firebase: se è impostata GRUPPO_ID i dati stanno sotto «gruppi/<codice>/». Senza, percorsi storici (app 1).
export const PREFISSO = (process.env.GRUPPO_ID || '').trim() ? 'gruppi/' + process.env.GRUPPO_ID.trim().toLowerCase() + '/' : '';
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function chiaveServizio(env = process.env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw.trim()) return null;
  try { const k = JSON.parse(raw); if (k.client_email && k.private_key && k.project_id) return k; } catch (e) {}
  throw new Error('FIREBASE_SERVICE_ACCOUNT non è un JSON valido di account di servizio');
}

export async function accessToken(k, f) {
  const ora = Math.floor(Date.now() / 1000);
  const corpo = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: ora, exp: ora + 3000 }));
  const firma = b64u(createSign('RSA-SHA256').update(corpo).sign(k.private_key));
  const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + corpo + '.' + firma });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Accesso a Google non riuscito (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// Preferenze di notifica scelte dall'utente sul proprio dispositivo (mappa «pref» del documento): { tutte, idro, minG, prev, cfd, bacheca }.
// Dispositivi senza preferenze (registrati prima di questa funzione): ricevono tutto.
function prefDaFs(v) {
  const m = v && v.mapValue && v.mapValue.fields; if (!m) return null;
  const o = {}; for (const [k, x] of Object.entries(m)) { if ('booleanValue' in x) o[k] = x.booleanValue; else if ('integerValue' in x) o[k] = Number(x.integerValue); else if ('doubleValue' in x) o[k] = x.doubleValue; }
  return o;
}
// Il messaggio va al dispositivo? Si decide dal tag: idro-prova (sempre), idro-prev-N (previsione), idro-<stazione>-N (soglia N superata), cfd-… (allerta meteo), bacheca-… (avvisi), calendario-… (eventi e promemoria), richiesta-… (richieste di intervento)
export function pushAmmesso(pref, tag, allarme = false) {
  const t = String(tag || '');
  if (!pref || t === 'idro-prova') return true;
  if (pref.tutte === false) return false;
  if (allarme) return true;   // chiamata di attivazione: arriva anche a chi ha spento le notifiche della bacheca
  if (/^cfd-/.test(t)) return pref.cfd !== false;
  if (/^bacheca-/.test(t)) return pref.bacheca !== false;
  if (/^richiesta-/.test(t)) return pref.richieste !== false;
  if (/^calendario-/.test(t)) return pref.calendario !== false;
  if (/^idro-prev-/.test(t)) return pref.prev !== false;
  const m = /^idro-.+-(\d+)$/.exec(t);
  if (m) return pref.idro !== false && Number(m[1]) >= (pref.minG || 1);
  return true;
}

// La sveglia a schermo intero parte solo sull'app Android (dispositivo «nativo») e solo se l'utente non l'ha spenta nelle impostazioni; altrove è una notifica normale.
export function comeAllarme(msg, d) { return !!msg.allarme && !!d.nativo && !(d.pref && d.pref.sveglia === false); }

async function elencoDispositivi(k, tok, f) {
  const out = []; let pag = '';
  do {
    const r = await f(`https://firestore.googleapis.com/v1/projects/${k.project_id}/databases/(default)/documents/${PREFISSO}push_dispositivi?pageSize=300${pag}`, { headers: { authorization: 'Bearer ' + tok } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Lettura dei dispositivi non riuscita (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
    (j.documents || []).forEach(d => { const t = d.fields && d.fields.token && d.fields.token.stringValue, em = d.fields && d.fields.email && d.fields.email.stringValue; if (t) out.push({ nome: d.name, token: t, email: String(em || '').toLowerCase(), pref: prefDaFs(d.fields && d.fields.pref), nativo: !!(d.fields && d.fields.nativo && d.fields.nativo.booleanValue) }); });
    pag = j.nextPageToken ? '&pageToken=' + encodeURIComponent(j.nextPageToken) : '';
  } while (pag);
  return out;
}

// msg = { titolo, testo, tag }. opzioni.escludiEmail = email degli utenti a cui NON mandare la notifica (es. chi ha pubblicato l'avviso); opzioni.soloEmail = se presente, la notifica va solo a questi utenti. Ritorna { saltato } oppure { dispositivi, inviati, rimossi }
export async function inviaPush(msg, opzioni = {}) {
  const f = opzioni.fetch || fetch, k = chiaveServizio(opzioni.env || process.env);
  if (!k) return { saltato: true };
  const escl = new Set((opzioni.escludiEmail || []).map(x => String(x || '').toLowerCase()).filter(Boolean));
  const solo = Array.isArray(opzioni.soloEmail) ? new Set(opzioni.soloEmail.map(x => String(x || '').toLowerCase()).filter(Boolean)) : null;
  const tok = await accessToken(k, f), dispositivi = (await elencoDispositivi(k, tok, f)).filter(d => !(d.email && escl.has(d.email)) && (!solo || (d.email && solo.has(d.email))) && pushAmmesso(d.pref, msg.tag, !!msg.allarme));
  let inviati = 0, rimossi = 0;
  for (const d of dispositivi) {
    const r = await f(`https://fcm.googleapis.com/v1/projects/${k.project_id}/messages:send`, {
      method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: d.token, data: Object.assign({ titolo: String(msg.titolo), testo: String(msg.testo), tag: String(msg.tag || 'idro'), icona: String(msg.icona || ''), url: './' }, comeAllarme(msg, d) ? { tipo: 'allarme', avvisoId: String(msg.avvisoId || '') } : {}), webpush: { headers: { Urgency: 'high', TTL: '3600' } }, android: { priority: 'HIGH', ttl: comeAllarme(msg, d) ? '600s' : '3600s' } } })
    });
    if (r.ok) { inviati++; continue; }
    const t = await r.text().catch(() => '');
    if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(t)) {   // dispositivo non più valido: si toglie dall'elenco
      const x = await f(`https://firestore.googleapis.com/v1/${d.nome}`, { method: 'DELETE', headers: { authorization: 'Bearer ' + tok } });
      if (x.ok) rimossi++;
    } else console.log('::warning::Push non inviato (' + r.status + '): ' + t.slice(0, 160));
  }
  return { dispositivi: dispositivi.length, inviati, rimossi };
}

// Legge una raccolta di Firestore (con l'account di servizio) e ritorna [{ id, campi }] con i valori già convertiti.
function daFs(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, daFs(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(daFs);
  return null;
}
export async function leggiCollezione(coll, opzioni = {}) {
  const f = opzioni.fetch || fetch, k = chiaveServizio(opzioni.env || process.env);
  if (!k) return null;
  const tok = await accessToken(k, f), out = []; let pag = '';
  do {
    const r = await f(`https://firestore.googleapis.com/v1/projects/${k.project_id}/databases/(default)/documents/${PREFISSO}${coll}?pageSize=300${pag}`, { headers: { authorization: 'Bearer ' + tok } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Lettura di ${coll} non riuscita (${r.status}): ` + JSON.stringify(j).slice(0, 200));
    (j.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), campi: daFs({ mapValue: { fields: d.fields || {} } }) }));
    pag = j.nextPageToken ? '&pageToken=' + encodeURIComponent(j.nextPageToken) : '';
  } while (pag);
  return out;
}

// Legge solo i documenti di una raccolta il cui campo testuale (data ISO) e' >= daIso: una interrogazione, cosi' non si leggono ogni volta tutte le richieste storiche.
// Ritorna [{ id, campi }] (stesso formato di leggiCollezione). Il campo deve avere l'indice automatico di Firestore (campo singolo).
export async function interrogaDa(coll, campo, daIso, opzioni = {}) {
  const f = opzioni.fetch || fetch, k = chiaveServizio(opzioni.env || process.env);
  if (!k) return null;
  const tok = await accessToken(k, f), padre = PREFISSO ? PREFISSO.replace(/\/$/, '') : '';
  const r = await f(`https://firestore.googleapis.com/v1/projects/${k.project_id}/databases/(default)/documents${padre ? '/' + padre : ''}:runQuery`, {
    method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }], where: { fieldFilter: { field: { fieldPath: campo }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: daIso } } }, limit: 500 } }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error(`Interrogazione di ${coll} non riuscita (${r.status}): ` + JSON.stringify(j).slice(0, 200));
  return j.filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), campi: daFs({ mapValue: { fields: x.document.fields || {} } }) }));
}

// Scrive (sostituisce) un documento di Firestore con l'account di servizio. I valori sono convertiti dal formato JavaScript.
function aFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(aFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, aFs(x)])) } };
}
export async function scriviDocumento(coll, id, oggetto, opzioni = {}) {
  const f = opzioni.fetch || fetch, k = chiaveServizio(opzioni.env || process.env);
  if (!k) return false;
  const tok = await accessToken(k, f);
  const r = await f(`https://firestore.googleapis.com/v1/projects/${k.project_id}/databases/(default)/documents/${PREFISSO}${coll}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify({ fields: aFs(oggetto).mapValue.fields }) });
  if (!r.ok) throw new Error(`Scrittura di ${coll}/${id} non riuscita (${r.status}): ` + (await r.text().catch(() => '')).slice(0, 200));
  return true;
}

// Impostazioni del gruppo scritte dall'app (Firestore: gruppi/<codice>/impostazioni/gruppo): comune, zona CFD, fiume, Telegram sì/no...
// Ritorna l'oggetto, oppure null se non ci sono (o non si leggono): in quel caso gli script usano le variabili del repository.
// GRUPPO_CONFIG_FILE (solo prove): legge le impostazioni da un file JSON invece che da Firestore.
export async function leggiConfigGruppo(opzioni = {}) {
  const env = opzioni.env || process.env;
  if (env.GRUPPO_CONFIG_FILE) { try { return JSON.parse(readFileSync(env.GRUPPO_CONFIG_FILE, 'utf8')); } catch (e) { return null; } }
  try {
    const imp = await leggiCollezione('impostazioni', opzioni), d = imp && imp.find(x => x.id === 'gruppo');
    return d ? d.campi : null;
  } catch (e) { console.log('::warning::Impostazioni del gruppo non lette: ' + e.message); return null; }
}
