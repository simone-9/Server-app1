// Catalogo delle stazioni ARPAV Veneto (livelli dei fiumi e pluviometri) con la provincia,
// per la scelta delle stazioni in Impostazioni gruppo dell'app. Scrive config/arpav-stazioni.json.
// Legge lo stesso file XML dei livelli (Ultime48ore.xml). I campi di ogni sensore (nome, provincia, coordinate) si riconoscono
// dal nome del tag; il registro riporta i tag trovati e un esempio, per correggere il riconoscimento se serve.
// Se manca la provincia ma ci sono le coordinate, la provincia si ricava con Nominatim (OpenStreetMap, 1 richiesta al secondo).
// Variabili per le prove: IDRO_SOURCE_URL, NOMINATIM_BASE, CATALOGO_FILE, PAUSA_MS, ARPAV_FILE.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const SORGENTE = process.env.IDRO_SOURCE_URL || 'https://www.arpa.veneto.it/api/risorse/data-meteo/xml/Ultime48ore.xml';
const NOMI = (process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const FILE = process.env.CATALOGO_FILE || 'config/arpav-stazioni.json';
const PAUSA = process.env.PAUSA_MS != null ? Number(process.env.PAUSA_MS) : 1100;
const dorme = ms => new Promise(r => setTimeout(r, ms));

async function scarica() {
  if (process.env.ARPAV_FILE) return readFileSync(process.env.ARPAV_FILE, 'utf8');
  let errore;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(SORGENTE, { headers: { 'User-Agent': 'idrometria-protezione-civile-curtarolo' }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('risposta ' + r.status);
      const t = await r.text();
      if (!/<SENSORE>/.test(t)) throw new Error('risposta non valida');
      return t;
    } catch (e) { errore = e; await dorme(4000); }
  }
  try {
    const t = execFileSync('curl', ['-sS', '-L', '--fail', '--connect-timeout', '40', '--max-time', '120', '--retry', '3', '--retry-delay', '5', '--retry-all-errors', '-A', 'idrometria-protezione-civile-curtarolo', SORGENTE], { encoding: 'utf8', maxBuffer: 200e6 });
    if (!/<SENSORE>/.test(t)) throw new Error('risposta non valida');
    return t;
  } catch (e) { throw errore || e; }
}

const xml = await scarica();
const blocchi = [];
for (const m of xml.matchAll(/<SENSORE>([\s\S]*?)<\/SENSORE>/g)) {
  const senzaDati = m[1].replace(/<DATI\b[\s\S]*?<\/DATI>/g, '');
  const tag = {};
  for (const t of senzaDati.matchAll(/<([A-Za-z_][A-Za-z0-9_]*)>\s*(?:<!\[CDATA\[)?([^<\]]*?)\s*(?:\]\]>)?\s*<\/\1>/g)) if (!(t[1] in tag)) tag[t[1]] = t[2].trim();
  blocchi.push(tag);
}
console.log(`Sensori letti: ${blocchi.length}`);
const nomiTag = {}; blocchi.forEach(b => Object.keys(b).forEach(k => { nomiTag[k] = (nomiTag[k] || 0) + 1; }));
console.log('Tag trovati (con quante volte): ' + JSON.stringify(nomiTag));
console.log('Esempio 1: ' + JSON.stringify(blocchi[0] || {}));
console.log('Esempio 2: ' + JSON.stringify(blocchi[Math.min(1, blocchi.length - 1)] || {}));
if (!blocchi.length) { console.error('Nessun sensore letto: catalogo non aggiornato.'); process.exit(1); }

const primo = (b, nomi) => { for (const k of Object.keys(b)) if (nomi.includes(k.toUpperCase()) && b[k] !== '') return b[k]; return ''; };
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const pulisciProv = t => String(t || '').replace(/^(Citt[àa] metropolitana|Provincia|Libero consorzio comunale)\s+(di|del|della|dell')\s*/i, '').trim();
const SIGLE = { BL: 'Belluno', PD: 'Padova', RO: 'Rovigo', TV: 'Treviso', VE: 'Venezia', VR: 'Verona', VI: 'Vicenza' };
const provDaTag = v => { const t = String(v || '').trim(); return SIGLE[t.toUpperCase()] || pulisciProv(t); };
async function provincia(lat, lon) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`${NOMI}/reverse?format=jsonv2&zoom=8&addressdetails=1&accept-language=it&lat=${lat}&lon=${lon}`, { headers: { 'User-Agent': 'gestione-emergenze-catalogo-arpav' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { await dorme(5000); continue; }
      if (!r.ok) return '';
      const a = (await r.json()).address || {};
      return pulisciProv(a.county || a.state_district || a.province || a.city || '');
    } catch (e) { await dorme(3000); }
  }
  return '';
}

// stazioni note da catalogo precedente e da configurazione (nomi e province già trovati)
let vecchio = [];
try { if (existsSync(FILE)) vecchio = JSON.parse(readFileSync(FILE, 'utf8')).stazioni || []; } catch (e) {}
const noto = new Map(vecchio.map(x => [String(x.id), x]));
const nomiCfg = new Map();
try { const c = JSON.parse(readFileSync('config/stazioni.json', 'utf8')); [...(c.stazioni || []), ...(c.pluviometri || [])].forEach(x => nomiCfg.set(String(x.id), x.nome)); } catch (e) {}

const per = new Map();
for (const b of blocchi) {
  const id = String(b.ID || '').trim(); if (!/^\d{5,12}$/.test(id) || per.has(id)) continue;
  const unita = String(b.UNITNM || '').trim().toLowerCase();
  const tipoTesto = (primo(b, ['TIPO', 'TIPOLOGIA', 'PARAMETRO', 'GRANDEZZA', 'TIPOSENSORE', 'DESCRIZIONESENSORE', 'NOMESENSORE']) + ' ' + unita).toLowerCase();
  const liv = unita === 'm' || /livell|idromet/.test(tipoTesto), pio = unita === 'mm' || /pioggi|precip/.test(tipoTesto);
  if (!liv && !pio) continue;
  per.set(id, { id, nome: primo(b, ['NOME', 'NOMESTAZIONE', 'STAZIONE', 'DESCRIZIONE', 'DESCR', 'NOMESENS', 'NOMEPUNTO', 'LOCALITA']), comune: primo(b, ['COMUNE', 'NOMECOMUNE']), prov: provDaTag(primo(b, ['PROVINCIA', 'PROV', 'SIGLAPROV', 'SIGLA_PROVINCIA'])), lat: num(primo(b, ['LAT', 'LATITUDINE', 'LATITUDE'])), lon: num(primo(b, ['LON', 'LONG', 'LNG', 'LONGITUDINE', 'LONGITUDE'])), tipo: liv ? 'liv' : 'pio' });
}
console.log(`Stazioni con livello o pioggia: ${per.size}`);
const out = [];
let nuove = 0;
for (const s of per.values()) {
  const prec = noto.get(s.id);
  if (!s.nome) s.nome = (prec && prec.nome) || nomiCfg.get(s.id) || ('Stazione ' + s.id);
  if (!s.prov && prec && prec.prov) s.prov = prec.prov;
  if (!s.prov && s.lat != null && s.lon != null) { await dorme(PAUSA); s.prov = await provincia(s.lat, s.lon); nuove++; }
  out.push({ id: s.id, nome: s.nome, comune: s.comune || '', prov: s.prov || '', lat: s.lat, lon: s.lon, liv: s.tipo === 'liv', pio: s.tipo === 'pio' });
}
out.sort((a, b) => (a.prov || '~').localeCompare(b.prov || '~', 'it') || a.nome.localeCompare(b.nome, 'it'));
mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(FILE, JSON.stringify({ v: 1, aggiornato: new Date().toISOString(), fonte: 'ARPAV Veneto, rete idrografica e meteorologica (CC BY 4.0)', stazioni: out }));
const conteggio = {}; out.forEach(x => { const k = x.prov || '(senza provincia)'; conteggio[k] = (conteggio[k] || 0) + 1; });
console.log(`Catalogo scritto: ${out.length} stazioni (${out.filter(x => x.liv).length} livelli, ${out.filter(x => x.pio).length} pluviometri), province ricavate dalle coordinate: ${nuove}`);
console.log('Per provincia: ' + JSON.stringify(conteggio));
