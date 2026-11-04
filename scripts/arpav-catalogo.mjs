// Catalogo delle stazioni ARPAV Veneto (livelli dei fiumi e pluviometri) con la provincia,
// per la scelta delle stazioni in Impostazioni gruppo dell'app. Scrive config/arpav-stazioni.json.
// Legge lo stesso file XML dei livelli (Ultime48ore.xml): ogni <STAZIONE> ha nome, provincia (sigla), comune, coordinate e i suoi <SENSORE>.
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
  if (process.env.ARPAV_FILE) return new TextDecoder('iso-8859-1').decode(readFileSync(process.env.ARPAV_FILE));
  let errore;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(SORGENTE, { headers: { 'User-Agent': 'idrometria-protezione-civile-curtarolo' }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('risposta ' + r.status);
      const t = new TextDecoder('iso-8859-1').decode(await r.arrayBuffer());
      if (!/<SENSORE>/.test(t)) throw new Error('risposta non valida');
      return t;
    } catch (e) { errore = e; await dorme(4000); }
  }
  try {
    const t = new TextDecoder('iso-8859-1').decode(execFileSync('curl', ['-sS', '-L', '--fail', '--connect-timeout', '40', '--max-time', '120', '--retry', '3', '--retry-delay', '5', '--retry-all-errors', '-A', 'idrometria-protezione-civile-curtarolo', SORGENTE], { maxBuffer: 200e6 }));
    if (!/<SENSORE>/.test(t)) throw new Error('risposta non valida');
    return t;
  } catch (e) { throw errore || e; }
}

const xml = await scarica();
const campo = (s, n) => { const m = s.match(new RegExp('<' + n + '>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)\\s*(?:\\]\\]>)?\\s*</' + n + '>')); return m ? m[1].trim() : ''; };
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const SIGLE = { BL: 'Belluno', PD: 'Padova', RO: 'Rovigo', TV: 'Treviso', VE: 'Venezia', VR: 'Verona', VI: 'Vicenza', TN: 'Trento', BZ: 'Bolzano', UD: 'Udine', PN: 'Pordenone', GO: 'Gorizia', TS: 'Trieste', MN: 'Mantova', FE: 'Ferrara', PC: 'Piacenza', RE: 'Reggio Emilia', BO: 'Bologna', MO: 'Modena', PR: 'Parma', RA: 'Ravenna' };
const pulisciProv = t => String(t || '').replace(/^(Citt[àa] metropolitana|Provincia|Libero consorzio comunale)\s+(di|del|della|dell')\s*/i, '').trim();
const provDaTag = v => { const t = String(v || '').trim(); return SIGLE[t.toUpperCase()] || pulisciProv(t); };
const titolo = s => s.replace(/\s+/g, ' ').trim();

const stazioniXml = [...xml.matchAll(/<STAZIONE>([\s\S]*?)<\/STAZIONE>/g)].map(m => m[1]);
console.log(`Stazioni nel file: ${stazioniXml.length}`);
const tipi = {}; 
const per = new Map();
for (const sx of stazioniXml) {
  const senzaSens = sx.replace(/<SENSORE>[\s\S]*?<\/SENSORE>/g, '');
  const st = { nome: titolo(campo(senzaSens, 'NOME')), comune: titolo(campo(senzaSens, 'COMUNE')), prov: provDaTag(campo(senzaSens, 'PROVINCIA')), lon: num(campo(senzaSens, 'X')), lat: num(campo(senzaSens, 'Y')) };
  const sensori = [...sx.matchAll(/<SENSORE>([\s\S]*?)<\/SENSORE>/g)].map(m => m[1].replace(/<DATI\b[\s\S]*?<\/DATI>/g, ''));
  const utili = [];
  for (const s of sensori) {
    const id = campo(s, 'ID'), tipo = campo(s, 'TYPE').toUpperCase(), unita = campo(s, 'UNITNM').toLowerCase(), par = campo(s, 'PARAMNM');
    tipi[tipo + ' (' + unita + ')'] = (tipi[tipo + ' (' + unita + ')'] || 0) + 1;
    if (!/^\d{5,12}$/.test(id) || per.has(id)) continue;
    const liv = tipo === 'LIVIDRO' || unita === 'm' && /livell/i.test(par), pio = !liv && (unita === 'mm' || /pioggi|precip/i.test(par + ' ' + tipo));
    if (liv || pio) utili.push({ id, par, liv, pio });
  }
  for (const u of utili) {
    const doppio = utili.filter(x => x.liv === u.liv).length > 1;
    per.set(u.id, { id: u.id, nome: st.nome + (doppio && u.par ? ' - ' + u.par : ''), comune: st.comune, prov: st.prov, lat: st.lat, lon: st.lon, tipo: u.liv ? 'liv' : 'pio' });
  }
}
console.log('Tipi di sensore trovati: ' + JSON.stringify(tipi));
console.log(`Sensori di livello o pioggia: ${per.size}`);
if (!per.size) { console.error('Nessun sensore di livello o pioggia: catalogo non aggiornato.'); process.exit(1); }

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
