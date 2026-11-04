// Catalogo delle stazioni dell'Osservatorio delle Alpi Orientali (livelli e pluviometri) con la provincia,
// per la scelta delle stazioni in Impostazioni gruppo dell'app. Scrive config/osservatorio-stazioni.json.
// Credenziali: segreti OSSERVATORIO_USER e OSSERVATORIO_PASSWORD. La provincia si ricava dalle coordinate con
// Nominatim (OpenStreetMap, 1 richiesta al secondo); le stazioni già note non vengono richieste di nuovo.
// Variabili per le prove: OSSERVATORIO_BASE, NOMINATIM_BASE, CATALOGO_FILE, PAUSA_MS.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = (process.env.OSSERVATORIO_BASE || 'https://www.amicoalpiorientali.eu/CoDataService').replace(/\/$/, '');
const NOMI = (process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const USER = process.env.OSSERVATORIO_USER, PASS = process.env.OSSERVATORIO_PASSWORD;
const FILE = process.env.CATALOGO_FILE || 'config/osservatorio-stazioni.json';
const PAUSA = process.env.PAUSA_MS != null ? Number(process.env.PAUSA_MS) : 1100;
const dorme = ms => new Promise(r => setTimeout(r, ms));
if (!USER || !PASS) { console.error('Mancano i segreti OSSERVATORIO_USER / OSSERVATORIO_PASSWORD.'); process.exit(1); }

async function chiama(percorso, opz = {}) {
  let errore;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BASE + percorso, { ...opz, signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      if ([502, 503, 504].includes(r.status)) { errore = new Error(`${percorso}: risposta ${r.status}`); await dorme(2000 * (i + 1)); continue; }
      if (!r.ok) throw Object.assign(new Error(`${percorso}: risposta ${r.status}`), { definitivo: true });
      try { return JSON.parse(t); } catch { return t; }
    } catch (e) { if (e.definitivo) throw e; errore = e; await dorme(2000 * (i + 1)); }
  }
  throw errore;
}
const fd = new FormData(); fd.append('userName', USER); fd.append('password', PASS);
const r0 = await chiama('/api/Auth/login', { method: 'POST', body: fd });
const token = String(typeof r0 === 'string' ? r0 : (r0.token || '')).replace(/^"|"$/g, '').replace(/^Bearer\s+/i, '').trim();
if (!token) { console.error('Token non ottenuto.'); process.exit(1); }
const H = { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
console.log('Login eseguito.');

// 1) stazioni di tutte le reti
const reti = await chiama('/api/networks', H);
const per = new Map();
for (const rete of Array.isArray(reti) ? reti : []) {
  const rid = rete.id ?? rete.idrete ?? rete.networkId;
  let st = [];
  try { st = await chiama(`/api/networks/${rid}/stations`, H); } catch (e) { console.log(`::warning::Rete ${rid}: stazioni non lette: ${e.message}`); }
  for (const x of Array.isArray(st) ? st : []) { const s = x && x.station ? x.station : x; if (s && s.id != null) per.set(s.id, s); }
}
console.log(`Stazioni trovate: ${per.size}`);
if (!per.size) { console.error('Nessuna stazione letta: catalogo non aggiornato.'); process.exit(1); }

// 2) sensori: livello (tipo 6) e pioggia (tipo 2), 6 richieste alla volta
const ids = [...per.keys()], sens = new Map();
let prossimo = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (prossimo < ids.length) {
    const id = ids[prossimo++];
    try { const r = await chiama(`/api/stations/${id}/sensors`, H); sens.set(id, new Set((Array.isArray(r) ? r : []).map(z => z.idTipoDato))); }
    catch (e) { sens.set(id, null); }
  }
}));

// 3) catalogo precedente (per non rifare la provincia) e pulizia dei nomi
let vecchio = [];
try { if (existsSync(FILE)) vecchio = JSON.parse(readFileSync(FILE, 'utf8')).stazioni || []; } catch (e) {}
const noto = new Map(vecchio.map(x => [String(x.id), x]));
const RE_COD = /\s+([A-Z]{1,3}(?:\.[A-Z0-9]{1,4}){2,})\s*$/;
const pulisci = t => { let n = String(t || '').replace(/\s*-?\s*\(DAO\)\s*$/i, '').trim(); let cod = ''; const m = RE_COD.exec(n); if (m) { cod = m[1]; n = n.slice(0, m.index).trim(); } return { nome: n, cod }; };
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const pulisciProv = t => String(t || '').replace(/^(Citt[àa] metropolitana|Provincia|Libero consorzio comunale|Ente di decentramento regionale)\s+(di|del|della|dell')\s*/i, '').replace(/^(Provincia autonoma di)\s+/i, '').trim();
async function provincia(lat, lon) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`${NOMI}/reverse?format=jsonv2&zoom=8&addressdetails=1&accept-language=it&lat=${lat}&lon=${lon}`, { headers: { 'User-Agent': 'gestione-emergenze-catalogo-osservatorio' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { await dorme(5000); continue; }
      if (!r.ok) return '';
      const a = (await r.json()).address || {};
      return pulisciProv(a.county || a.state_district || a.province || a.city || '');
    } catch (e) { await dorme(3000); }
  }
  return '';
}

const out = [];
let nuove = 0;
for (const [id, s] of per) {
  const t = sens.get(id);
  const liv = !!(t && t.has(6)), pio = !!(t && t.has(2));
  if (!liv && !pio) continue;
  const lat = num(s.lat ?? s.latitude), lon = num(s.lon ?? s.longitude);
  const { nome, cod } = pulisci(s.descr || s.nome || s.codice);
  const prec = noto.get(String(id));
  let prov = prec && prec.prov && prec.lat === lat && prec.lon === lon ? prec.prov : '';
  if (!prov && lat != null && lon != null) { await dorme(PAUSA); prov = await provincia(lat, lon); nuove++; }
  out.push({ id, nome, cod, lat, lon, prov, liv, pio });
}
out.sort((a, b) => (a.prov || '~').localeCompare(b.prov || '~', 'it') || a.nome.localeCompare(b.nome, 'it'));
mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(FILE, JSON.stringify({ v: 1, aggiornato: new Date().toISOString(), fonte: "Osservatorio delle Alpi Orientali (elenco stazioni); province da OpenStreetMap/Nominatim", stazioni: out }));
const conteggio = {}; out.forEach(x => { conteggio[x.prov || '(senza provincia)'] = (conteggio[x.prov || '(senza provincia)'] || 0) + 1; });
console.log(`Catalogo scritto: ${out.length} stazioni (${out.filter(x => x.liv).length} con livello, ${out.filter(x => x.pio).length} con pioggia), province nuove richieste: ${nuove}`);
console.log('Per provincia: ' + JSON.stringify(conteggio));
