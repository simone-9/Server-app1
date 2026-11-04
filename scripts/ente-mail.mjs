// Richieste agli enti: bozza della lettera scritta da un'AI (Groq) e invio dalla casella email di servizio del gruppo (Gmail di default, altro provider con SMTP_HOST/SMTP_PORT).
//
//   node scripts/ente-mail.mjs bozza <id>    legge la richiesta dalla raccolta Firestore «richieste_ente», genera oggetto e testo
//   node scripts/ente-mail.mjs invia <id>    invia la mail (solo se l'amministratore ha premuto «Invia» nell'app)
//   node scripts/ente-mail.mjs prova         controlla chiave Firestore, chiave Groq e accesso alla casella email (invia una mail di prova a se stessa)
//
// Segreti richiesti: FIREBASE_SERVICE_ACCOUNT, GROQ_API_KEY, SMTP_USER, SMTP_PASSWORD (password per app di Gmail, o password SMTP del provider). Altro provider: variabili SMTP_HOST e SMTP_PORT (465 SSL o 587 STARTTLS).
// Facoltativi (variabili del repository): GROQ_MODEL, NOME_MITTENTE, MAX_INVII_24H.
//
// PRIVACY: i log di GitHub non contengono mai testi, indirizzi o nomi: solo l'ID della richiesta e l'esito.
// All'AI arrivano solo ente, tipo, luogo e descrizione; la «Firma» e i «Dati riservati» inseriti nell'app
// vengono aggiunti dopo e non passano mai da Groq. Nella descrizione email, telefoni, codici fiscali e IBAN
// vengono comunque oscurati prima dell'invio.
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

// Più gruppi sullo stesso Firebase: con GRUPPO_ID i dati stanno sotto «gruppi/<codice>/» (altrimenti percorso storico).
const GRUPPO = (process.env.GRUPPO_ID || '').trim().toLowerCase();
export const COLLEZIONE = 'richieste_ente';
const PREF = GRUPPO ? `gruppi/${GRUPPO}/` : '';
let NOME_ORG = (process.env.NOME_GRUPPO || 'Gruppo comunale di Protezione Civile di Curtarolo').trim();
let NOME_BREVE = (process.env.NOME_MITTENTE || 'Protezione Civile Curtarolo').trim();
const MODELLI_PREDEFINITI = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
const RE_EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;

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
// Nomi del gruppo dalle impostazioni scritte nell'app (gruppi/<codice>/impostazioni/gruppo); se mancano restano le variabili del repository.
export function nomiDaConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const comune = String(c.comune || '').trim(), nome = String(c.nome || '').trim();
  if (!comune && !nome) return null;
  return {
    org: nome ? (comune && !nome.toLowerCase().includes(comune.toLowerCase()) ? `${nome} di ${comune}` : nome) : `Gruppo comunale di Protezione Civile di ${comune}`,
    breve: comune ? `Protezione Civile ${comune}` : nome,
  };
}
async function leggiImpostazioniGruppo(ctx) {
  try {
    const r = await ctx.f(`${ctx.base}/${PREF}impostazioni/gruppo`, { headers: { authorization: 'Bearer ' + ctx.tok } });
    if (!r.ok) return null;
    const j = await r.json();
    return daFs({ mapValue: { fields: j.fields || {} } });
  } catch (e) { return null; }
}
function fsBase(k, env) { return (env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1') + `/projects/${k.project_id}/databases/(default)/documents`; }

async function leggiRichiesta(ctx, id) {
  const r = await ctx.f(`${ctx.base}/${PREF}${COLLEZIONE}/${encodeURIComponent(id)}`, { headers: { authorization: 'Bearer ' + ctx.tok } });
  if (r.status === 404) throw new Error('Richiesta non trovata');
  if (!r.ok) throw new Error('Lettura della richiesta non riuscita (' + r.status + ')');
  const j = await r.json();
  return { dati: Object.fromEntries(Object.entries(j.fields || {}).map(([k, x]) => [k, daFs(x)])), updateTime: j.updateTime };
}
// Scrive solo i campi indicati. Con «updateTime» la scrittura riesce solo se nessun altro ha toccato il documento nel frattempo:
// serve a «prenotare» la richiesta e a non spedire mai due volte la stessa mail.
async function scriviRichiesta(ctx, id, campi, updateTime) {
  const maschera = Object.keys(campi).map(c => 'updateMask.fieldPaths=' + encodeURIComponent(c)).join('&');
  const cond = updateTime ? 'currentDocument.updateTime=' + encodeURIComponent(updateTime) : 'currentDocument.exists=true';
  const r = await ctx.f(`${ctx.base}/${PREF}${COLLEZIONE}/${encodeURIComponent(id)}?${maschera}&${cond}`, { method: 'PATCH', headers: { authorization: 'Bearer ' + ctx.tok, 'content-type': 'application/json' }, body: JSON.stringify({ fields: aFs(campi).mapValue.fields }) });
  if (!r.ok) { const e = new Error('Scrittura non riuscita (' + r.status + ')'); e.status = r.status; throw e; }
  return true;
}
async function inviatiUltime24Ore(ctx) {
  const da = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r = await ctx.f(`${ctx.base}${GRUPPO ? '/gruppi/' + GRUPPO : ''}:runQuery`, { method: 'POST', headers: { authorization: 'Bearer ' + ctx.tok, 'content-type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: COLLEZIONE }], where: { fieldFilter: { field: { fieldPath: 'inviataIl' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: da } } }, select: { fields: [{ fieldPath: 'stato' }] }, limit: 500 } }) });
  if (!r.ok) throw new Error('Conteggio degli invii non riuscito (' + r.status + ')');
  const j = await r.json();
  return (Array.isArray(j) ? j : []).filter(x => x.document).length;
}

// ---------- privacy: oscura dati personali nel testo prima di inviarlo all'AI ----------
export function oscura(testo) {
  let n = 0;
  const sost = (re, fn) => { testo = testo.replace(re, (...a) => { const o = fn ? fn(a[0]) : true; if (o) { n++; return '[DATO OMESSO]'; } return a[0]; }); };
  sost(/[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}/gi);
  sost(/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi);
  sost(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g);
  sost(/(?<![\d/])\+?\d[\d\s().\-]{7,}\d(?![\d/])/g, s => s.replace(/\D/g, '').length >= 9);
  return { testo, n };
}

// ---------- Groq ----------
export function promptBozza(r, nFoto) {
  const sist = [
    'Sei un assistente che scrive email formali in italiano per conto del ' + NOME_ORG + '.',
    'Scrivi una email formale, cortese e concisa indirizzata a un ente o a un ufficio pubblico, usando SOLO le informazioni fornite.',
    'Regole:',
    '- Non inventare fatti, date, numeri di protocollo, nomi di persone, leggi o articoli. Se un\'informazione manca, non menzionarla.',
    '- Inizia con «Spett.le » seguito dal nome dell\'ente, poi una virgola.',
    '- Il «Titolo» indica l\'argomento della lettera. Se il tipo è «Problema», descrivi il problema e il luogo e chiedi chiaramente l\'intervento o la verifica che spetta all\'ente. Se il tipo è «Generico» o «Altro», esponi la richiesta o la comunicazione descritta, senza parlare di problemi, pericoli o interventi che non sono indicati.',
    '- Se il luogo non è indicato non parlare di luoghi.',
    '- Chiedi sempre un cenno di riscontro.',
    '- Se l\'urgenza è «Urgente» spiega con garbo che serve una risposta o un intervento tempestivo, senza esagerare né minacciare.',
    '- Se sono indicate foto allegate, scrivi che sono allegate alla mail.',
    '- Chiudi con «Distinti saluti.» e NON aggiungere firma, nomi, ruoli o recapiti: li aggiunge il sistema.',
    '- Lunghezza: tra 90 e 180 parole. Niente elenchi puntati, niente formattazione.',
    'Rispondi esattamente in questo formato, senza altro testo:',
    'OGGETTO: <una sola riga, specifica e breve>',
    'TESTO:',
    '<corpo della email>'
  ].join('\n');
  const tipo = r.titolo ? (r.tipo || 'Problema') : 'Problema';   // richieste salvate prima dell'introduzione del titolo: «tipo» era il problema
  const titolo = r.titolo || r.tipo || '';
  const righe = [`Ente destinatario: ${r.ente || ''}`, `Tipo di richiesta: ${tipo}`, `Titolo: ${titolo}`];
  if (String(r.luogo || '').trim()) righe.push(`Luogo: ${r.luogo}`);
  righe.push(`Urgenza: ${r.urgenza || 'Ordinaria'}`, `Descrizione: ${r.descrizione || ''}`);
  if (r.precedente) righe.push(`Riferimento a una comunicazione precedente: ${r.precedente}`);
  righe.push(`Foto allegate: ${nFoto}`);
  return [{ role: 'system', content: sist }, { role: 'user', content: righe.join('\n') }];
}
export function leggiRisposta(testo, r) {
  let t = String(testo || '').replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  const m = t.match(/OGGETTO:\s*(.+?)\s*\n+\s*TESTO:\s*([\s\S]+)/i);
  let oggetto, corpo;
  if (m) { oggetto = m[1].trim(); corpo = m[2].trim(); }
  else { oggetto = [r.titolo || r.tipo, r.luogo].filter(Boolean).join(' - ') || 'Richiesta'; corpo = t.replace(/^\s*OGGETTO:.*\n?/i, '').replace(/^\s*TESTO:\s*/i, '').trim(); }
  oggetto = oggetto.replace(/^["«]|["»]$/g, '').slice(0, 150);
  return { oggetto, corpo };
}
async function chiamaGroq(ctx, messaggi) {
  const chiave = ctx.env.GROQ_API_KEY;
  if (!chiave) throw new Error('Segreto GROQ_API_KEY mancante');
  const base = ctx.env.GROQ_BASE || 'https://api.groq.com/openai/v1';
  const modelli = [...new Set([(ctx.env.GROQ_MODEL || '').trim(), ...MODELLI_PREDEFINITI].filter(Boolean))];
  let ultimo = 'nessun modello disponibile';
  for (const modello of modelli) {
    for (let tentativo = 0; tentativo < 3; tentativo++) {
      const r = await ctx.f(base + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + chiave, 'content-type': 'application/json' }, body: JSON.stringify({ model: modello, messages: messaggi, temperature: 0.3, max_completion_tokens: 1500 }) });
      if (r.status === 401 || r.status === 403) throw new Error('Chiave Groq non valida o senza permessi');
      if (r.status === 429) { ultimo = 'limite di richieste Groq raggiunto'; const s = Math.min(Number(r.headers?.get?.('retry-after')) || 5, 20); if (tentativo < 2) { await pausa((ctx.attesa ?? 1) * s * 1000); continue; } break; }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const cod = String(j?.error?.code || '') + ' ' + String(j?.error?.message || '');
        ultimo = 'Groq ha risposto ' + r.status;
        if (/model_not_found|decommission|does not exist|not supported|no longer/i.test(cod) || r.status === 404) break;   // prova il modello successivo
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

// ---------- posta ----------
export function fotoAllegate(foto) {
  const out = [];
  (Array.isArray(foto) ? foto : []).slice(0, 5).forEach((u, i) => {
    const m = String(u || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (m) out.push({ filename: `foto-${i + 1}.${m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg'}`, content: Buffer.from(m[2], 'base64'), contentType: m[1] });
  });
  return out;
}
export function logoGruppo() {   // logo del gruppo in fondo alla mail: assets/logo.png oppure logo.png nella radice del repository (se manca, la mail parte senza)
  for (const percorso of ['../assets/logo.png', '../logo.png']) { try { return readFileSync(new URL(percorso, import.meta.url)); } catch (e) {} }
  return null;
}
export function corpoHtml(testo, conLogo) {
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">' + esc(testo).replace(/\r?\n/g, '<br>')
    + (conLogo ? '<br><br><img src="cid:logo-gruppo" width="110" alt="' + NOME_BREVE.replace(/[<>"&]/g, '') + '" style="display:block;border:0">' : '') + '</div>';
}
export function indirizziValidi(testo) {
  return String(testo || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}
async function creaTrasporto(env) {
  if (!env.SMTP_USER || !env.SMTP_PASSWORD) throw new Error('Segreti SMTP_USER e SMTP_PASSWORD mancanti');
  const nm = await import('nodemailer');
  const porta = Number(env.SMTP_PORT) || 465;
  return (nm.default || nm).createTransport({ host: env.SMTP_HOST || 'smtp.gmail.com', port: porta, secure: porta === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }, connectionTimeout: 20000, socketTimeout: 30000 });
}
export function spiegaErroreMail(e) {
  const c = String(e?.code || ''), rc = Number(e?.responseCode) || 0;
  if (c === 'EAUTH' || rc === 535) return 'Il server di posta ha rifiutato l\'accesso: controlla utente e password (SMTP_USER, SMTP_PASSWORD; per Gmail serve la password per app), host e porta (SMTP_HOST, SMTP_PORT) e gli avvisi di sicurezza dell\'account';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EDNS'].includes(c)) return 'Collegamento al server di posta non riuscito: controlla SMTP_HOST e SMTP_PORT o riprova tra poco';
  if (rc >= 550 && rc < 560) return 'Destinatario rifiutato dal server di posta (' + rc + ')';
  if (rc === 421 || rc === 450 || rc === 452) return 'Il server di posta ha rimandato l\'invio (limite temporaneo): riprova più tardi';
  return 'Invio non riuscito' + (c ? ' (' + c.slice(0, 30) + ')' : '');
}

// ---------- azioni ----------
export async function esegui(azione, id, deps = {}) {
  const env = deps.env || process.env, f = deps.fetch || fetch;
  const log = deps.log || console.log;
  const k = chiaveServizio(env);
  const ctx = { f, env, base: fsBase(k, env), tok: await accessToken(k, f), attesa: deps.attesa };
  const mittente = env.SMTP_USER;
  const nomi = nomiDaConfig(await leggiImpostazioniGruppo(ctx));
  if (nomi) { NOME_ORG = nomi.org; NOME_BREVE = nomi.breve; }

  if (azione === 'prova') {
    let ok = true;
    log('Firestore: accesso riuscito');
    try { const r = await chiamaGroq(ctx, [{ role: 'user', content: 'Rispondi solo con la parola OK.' }]); log('Groq: risposta ricevuta dal modello ' + r.modello); } catch (e) { ok = false; log('Groq: ERRORE - ' + e.message); }
    try { const t = deps.trasporto || await creaTrasporto(env); if (t.verify) await t.verify(); await t.sendMail({ from: mittente, to: mittente, subject: 'Prova invio richieste agli enti', text: 'Questa è una mail di prova: l\'invio dalla casella del gruppo funziona.' }); log('Posta: mail di prova inviata alla casella del gruppo'); } catch (e) { ok = false; log('Posta: ERRORE - ' + spiegaErroreMail(e)); }
    return ok;
  }

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('ID richiesta non valido');
  const { dati: r, updateTime } = await leggiRichiesta(ctx, id);

  if (azione === 'bozza') {
    if (r.stato !== 'Bozza richiesta') { log(`[bozza] ${id}: stato «${r.stato}», niente da fare`); return false; }
    try { await scriviRichiesta(ctx, id, { stato: 'Generazione in corso', errore: '' }, updateTime); } catch (e) { log(`[bozza] ${id}: richiesta già presa in carico`); return false; }
    try {
      const ripulita = oscura([r.descrizione, r.precedente, r.luogo, r.titolo].map(x => String(x || '')).join('\u0001'));
      const [descr, prec, luogo, titolo] = ripulita.testo.split('\u0001');
      const { testo, modello } = await chiamaGroq(ctx, promptBozza({ ...r, descrizione: descr, precedente: prec, luogo, titolo: r.titolo ? titolo : '' }, fotoAllegate(r.foto).length));
      const { oggetto, corpo } = leggiRisposta(testo, r);
      if (corpo.length < 40) throw new Error('Il modello ha restituito un testo troppo corto');
      let finale = corpo;
      if (String(r.riservati || '').trim()) finale += '\n\n' + String(r.riservati).trim();
      if (String(r.firma || '').trim()) finale += '\n\n' + String(r.firma).trim();
      await scriviRichiesta(ctx, id, { oggetto, corpo: finale, stato: 'Bozza pronta', bozzaIl: new Date().toISOString(), modello, errore: '', datiOscurati: ripulita.n });
      log(`[bozza] ${id}: bozza pronta (modello ${modello}${ripulita.n ? ', dati oscurati: ' + ripulita.n : ''})`);
      return true;
    } catch (e) {
      await scriviRichiesta(ctx, id, { stato: 'Errore bozza', errore: String(e.message || e).slice(0, 300) }).catch(() => {});
      log(`[bozza] ${id}: errore - ${String(e.message || e).slice(0, 120)}`);
      return false;
    }
  }

  if (azione === 'invia') {
    if (r.stato !== 'Invio richiesto') { log(`[invia] ${id}: stato «${r.stato}», niente da fare`); return false; }
    const a = indirizziValidi(r.destinatario), cc = indirizziValidi(r.cc);
    const errore = !a.length || a.length > 3 || !a.every(x => RE_EMAIL.test(x)) ? 'Indirizzo del destinatario non valido'
      : cc.length > 3 || !cc.every(x => RE_EMAIL.test(x)) ? 'Indirizzo in copia non valido'
      : !String(r.oggetto || '').trim() ? 'Oggetto mancante'
      : String(r.corpo || '').trim().length < 20 ? 'Testo della mail mancante o troppo corto' : '';
    if (errore) { await scriviRichiesta(ctx, id, { stato: 'Errore invio', errore }, updateTime).catch(() => {}); log(`[invia] ${id}: non inviata (dati non validi)`); return false; }
    const limite = Number(env.MAX_INVII_24H) || 20;
    if (await inviatiUltime24Ore(ctx) >= limite) { await scriviRichiesta(ctx, id, { stato: 'Errore invio', errore: `Limite di ${limite} invii nelle ultime 24 ore raggiunto` }, updateTime).catch(() => {}); log(`[invia] ${id}: limite giornaliero raggiunto`); return false; }
    try { await scriviRichiesta(ctx, id, { stato: 'Invio in corso', errore: '' }, updateTime); } catch (e) { log(`[invia] ${id}: richiesta già presa in carico`); return false; }
    try {
      const t = deps.trasporto || await creaTrasporto(env);
      const nome = NOME_BREVE.replace(/["<>\r\n]/g, '');
      const logo = deps.logo === undefined ? logoGruppo() : deps.logo;
      const allegati = (logo ? [{ filename: 'logo.png', content: logo, cid: 'logo-gruppo', contentDisposition: 'inline' }] : []).concat(fotoAllegate(r.foto));
      const info = await t.sendMail({ from: `"${nome}" <${mittente}>`, to: a.join(', '), cc: cc.length ? cc.join(', ') : undefined, replyTo: mittente, subject: String(r.oggetto).replace(/[\r\n]+/g, ' ').trim(), text: String(r.corpo), html: corpoHtml(r.corpo, !!logo), attachments: allegati });
      await scriviRichiesta(ctx, id, { stato: 'Inviata', inviataIl: new Date().toISOString(), messageId: String(info?.messageId || '').slice(0, 200), errore: '' });
      log(`[invia] ${id}: inviata`);
      return true;
    } catch (e) {
      await scriviRichiesta(ctx, id, { stato: 'Errore invio', errore: spiegaErroreMail(e) }).catch(() => {});
      log(`[invia] ${id}: errore - ${spiegaErroreMail(e)}`);
      return false;
    }
  }
  throw new Error('Azione sconosciuta: ' + azione);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const azione = process.argv[2] || process.env.AZIONE || '', id = process.argv[3] || process.env.ID_RICHIESTA || '';
  esegui(azione, id).then(ok => { process.exit(ok === false ? 1 : 0); }).catch(e => { console.error('Errore: ' + (e.message || e)); process.exit(1); });
}
