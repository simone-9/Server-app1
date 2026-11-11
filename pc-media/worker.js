// Worker "pc-media" — archivio foto e video degli interventi e libretti dei mezzi (Cloudflare R2, giurisdizione UE)
// Binding richiesto:   MEDIA  -> bucket R2 "pc-curtarolo-media"
// Variabile richiesta: FIREBASE_PROJECT_ID  (es. gestione-cantieri-temporanei)
// Variabili facoltative:
//   ALLOWED_ORIGINS  elenco di indirizzi dell'app separati da virgola (default: l'app su workers.dev)
//   ADMIN_EMAILS     email degli amministratori iniziali separate da virgola
//
// Percorsi:
//   POST   /media?ambito=interventi   corpo = file (foto <= 3 MB, video <= 50 MB)  -> { k, tipo, size }
//   POST   /media?ambito=veicoli      libretto di circolazione del mezzo: foto oppure PDF <= 10 MB (il PDF è ammesso solo in questo ambito)
//   GET    /media/<chiave>            restituisce il file (solo utenti con un ruolo)
//   DELETE /media/<chiave>            solo Admin, Operatore SOC o chi l'ha caricato
//   GET    /uso                       solo Admin: spazio occupato nel bucket

const ORIGINI_DEFAULT = ['https://pccurtarolo.gestionemergenzecurtarolo.workers.dev', 'https://gestione-cantieri-temporanei.web.app', 'https://gestione-cantieri-temporanei.firebaseapp.com'];
const ADMIN_DEFAULT = ['simokikko@gmail.com', 'servicesimoapp@protonmail.com'];
const TIPI = {
  'image/jpeg': { ext: 'jpg', max: 3 * 1024 * 1024 },
  'image/png': { ext: 'png', max: 3 * 1024 * 1024 },
  'image/webp': { ext: 'webp', max: 3 * 1024 * 1024 },
  'video/mp4': { ext: 'mp4', max: 50 * 1024 * 1024 },
  'video/webm': { ext: 'webm', max: 50 * 1024 * 1024 },
  'video/quicktime': { ext: 'mov', max: 50 * 1024 * 1024 },
  'application/pdf': { ext: 'pdf', max: 10 * 1024 * 1024, ambiti: ['veicoli'] }   // scansione del libretto di circolazione
};
const AMBITI = ['interventi', 'segnalazioni', 'richieste', 'rapporti', 'materiali', 'veicoli'];
const RUOLI_OK = ['Admin', 'Operatore SOC', 'Caposquadra', 'Operatore', 'Ente'];
// 'Ente': caposquadra di un ente accreditato entrato con il link temporaneo dell'app. Può solo caricare foto dal campo (ambito richieste)
// e leggere o eliminare i file che ha caricato lui; l'accesso vale finché non scade il campo «scade» del suo documento in «ruoli».
const RE_CHIAVE = /^[a-z]+\/\d{4}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm|mov|pdf)$/;

function lista(v, def) { const s = String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean); return s.length ? s : def; }
function cors(req, env) {
  const o = req.headers.get('Origin') || '', ok = lista(env.ALLOWED_ORIGINS, ORIGINI_DEFAULT).includes(o.toLowerCase());
  return ok ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400' } : null;
}
function risp(corpo, stato, h) { return new Response(corpo, { status: stato, headers: h }); }
function json(o, stato, h) { return risp(JSON.stringify(o), stato, { ...h, 'Content-Type': 'application/json' }); }

// ---- verifica dell'accesso Firebase (token ID, firma RS256 con le chiavi pubbliche di Google) ----
function b64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
async function verificaToken(token, env) {
  const p = String(token || '').split('.'); if (p.length !== 3) throw new Error('token');
  const head = JSON.parse(new TextDecoder().decode(b64u(p[0]))), cl = JSON.parse(new TextDecoder().decode(b64u(p[1])));
  if (head.alg !== 'RS256') throw new Error('alg');
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com', { cf: { cacheTtl: 3600, cacheEverything: true } });
  const jwk = ((await r.json()).keys || []).find(k => k.kid === head.kid); if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(p[2]), new TextEncoder().encode(p[0] + '.' + p[1]));
  const pid = env.FIREBASE_PROJECT_ID, now = Math.floor(Date.now() / 1000);
  if (!ok || cl.aud !== pid || cl.iss !== 'https://securetoken.google.com/' + pid || !cl.sub || cl.exp < now || cl.iat > now + 300 || !cl.email) throw new Error('claims');
  return { email: String(cl.email).toLowerCase() };
}
const cacheRuoli = new Map();
async function ruoloDi(email, token, env) {
  if (lista(env.ADMIN_EMAILS, ADMIN_DEFAULT).includes(email)) return 'Admin';
  const c = cacheRuoli.get(email); if (c && c.t > Date.now()) return c.r;
  const u = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ruoli/${encodeURIComponent(email)}`;
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
  let ruolo = '';
  if (r.ok) {
    const d = await r.json(), f = d.fields || {};
    ruolo = (f.role && f.role.stringValue) || '';
    if (ruolo === 'Ente' && !(Number((f.scade && (f.scade.integerValue || f.scade.doubleValue)) || 0) > Date.now())) ruolo = '';   // link scaduto
  }
  cacheRuoli.set(email, { r: ruolo, t: Date.now() + 60000 });
  return ruolo;
}

export default {
  async fetch(req, env) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === 'OPTIONS') return risp(null, h ? 204 : 403, h || {});
    if (!h) return risp('Origine non consentita', 403, {});
    if (!env.MEDIA || !env.FIREBASE_PROJECT_ID) return json({ errore: 'configurazione incompleta' }, 500, h);
    let utente, ruolo;
    try {
      const tk = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      utente = await verificaToken(tk, env); ruolo = await ruoloDi(utente.email, tk, env);
    } catch (e) { return json({ errore: 'accesso non valido' }, 401, h); }
    if (!RUOLI_OK.includes(ruolo)) return json({ errore: 'ruolo non autorizzato' }, 403, h);

    // ---- caricamento ----
    if (req.method === 'POST' && url.pathname === '/media') {
      const tipo = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase(), t = TIPI[tipo];
      if (!t) return json({ errore: 'tipo di file non consentito' }, 415, h);
      const ambito = AMBITI.includes(url.searchParams.get('ambito')) ? url.searchParams.get('ambito') : 'interventi';
      if (ruolo === 'Ente' && ambito !== 'richieste') return json({ errore: 'ruolo non autorizzato' }, 403, h);
      if (t.ambiti && !t.ambiti.includes(ambito)) return json({ errore: 'tipo di file non consentito' }, 415, h);
      const dichiarata = Number(req.headers.get('Content-Length') || 0);
      if (dichiarata > t.max) return json({ errore: 'file troppo grande', max: t.max }, 413, h);
      const dati = await req.arrayBuffer();
      if (!dati.byteLength || dati.byteLength > t.max) return json({ errore: 'file troppo grande', max: t.max }, 413, h);
      if (t.ext === 'pdf' && new TextDecoder('latin1').decode(dati.slice(0, 5)) !== '%PDF-') return json({ errore: 'il file non è un PDF valido' }, 415, h);
      const k = `${ambito}/${new Date().getUTCFullYear()}/${crypto.randomUUID()}.${t.ext}`;
      await env.MEDIA.put(k, dati, { httpMetadata: { contentType: tipo }, customMetadata: { caricato_da: utente.email, ambito } });
      return json({ k, tipo, size: dati.byteLength }, 201, h);
    }
    // ---- lettura / cancellazione ----
    if (url.pathname.startsWith('/media/') && (req.method === 'GET' || req.method === 'DELETE')) {
      const k = decodeURIComponent(url.pathname.slice(7));
      if (!RE_CHIAVE.test(k)) return json({ errore: 'chiave non valida' }, 400, h);
      if (req.method === 'GET') {
        if (ruolo === 'Ente') { const m = await env.MEDIA.head(k); if (!m || !m.customMetadata || m.customMetadata.caricato_da !== utente.email) return json({ errore: 'non trovato' }, 404, h); }
        const o = await env.MEDIA.get(k); if (!o) return json({ errore: 'non trovato' }, 404, h);
        return risp(o.body, 200, { ...h, 'Content-Type': (o.httpMetadata && o.httpMetadata.contentType) || 'application/octet-stream', 'Content-Length': String(o.size), 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      }
      const o = await env.MEDIA.head(k); if (!o) return json({ ok: true, gia_assente: true }, 200, h);
      const proprio = o.customMetadata && o.customMetadata.caricato_da === utente.email;
      if (!(ruolo === 'Admin' || ruolo === 'Operatore SOC' || proprio)) return json({ errore: 'non puoi eliminare questo file' }, 403, h);
      await env.MEDIA.delete(k); return json({ ok: true }, 200, h);
    }
    // ---- spazio occupato (solo Admin) ----
    if (req.method === 'GET' && url.pathname === '/uso') {
      if (ruolo !== 'Admin') return json({ errore: 'solo amministratori' }, 403, h);
      let tot = 0, n = 0, cur;
      do { const l = await env.MEDIA.list({ cursor: cur, limit: 1000 }); l.objects.forEach(x => { tot += x.size; n++; }); cur = l.truncated ? l.cursor : undefined; } while (cur);
      return json({ byte: tot, file: n, gb: Math.round(tot / 1e7) / 100, soglia_gratuita_gb: 10 }, 200, h);
    }
    return json({ errore: 'percorso non valido' }, 404, h);
  }
};
