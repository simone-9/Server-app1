// Pulizia delle esecuzioni di GitHub Actions: cancella le esecuzioni concluse da più di N ore (24 di default).
//
//   node scripts/pulizia-esecuzioni.mjs            usa GITHUB_REPOSITORY e GITHUB_TOKEN (forniti da GitHub Actions)
//   ORE=48 node scripts/pulizia-esecuzioni.mjs     altra soglia
//   SOLO_PROVA=1 node scripts/pulizia-esecuzioni.mjs   elenca soltanto, non cancella
//
// Non tocca le esecuzioni in corso o in coda. I log di un'esecuzione cancellata non si possono più consultare.
// Nel registro compaiono solo numeri (quante esecuzioni), mai testi.
import { pathToFileURL } from 'node:url';

const pausa = ms => new Promise(r => setTimeout(r, ms));
const MAX_PER_GIRO = 1500;

export function soglia(ore, ora = Date.now()) {
  const n = Number(ore); const h = Number.isFinite(n) && n >= 1 ? n : 24;
  return new Date(ora - h * 3600 * 1000).toISOString();
}

export async function pulisci({ repo, token, ore = 24, soloProva = false, ora = Date.now(), fetchF = fetch, log = console.log, attesa = 150 }) {
  if (!/^[A-Za-z0-9_-][\w.-]*\/[\w.-]+$/.test(String(repo || ''))) throw new Error('GITHUB_REPOSITORY non valido');
  if (!token) throw new Error('GITHUB_TOKEN mancante');
  const h = { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, 'x-github-api-version': '2022-11-28' };
  const prima = soglia(ore, ora);
  const ids = [];
  for (let pagina = 1; pagina <= 30 && ids.length < MAX_PER_GIRO; pagina++) {
    const r = await fetchF(`https://api.github.com/repos/${repo}/actions/runs?status=completed&created=%3C${encodeURIComponent(prima)}&per_page=100&page=${pagina}`, { headers: h });
    if (!r.ok) throw new Error('Elenco delle esecuzioni non riuscito (' + r.status + ')');
    const j = await r.json(); const l = (j.workflow_runs || []).filter(x => x.status === 'completed' && Date.parse(x.created_at) < Date.parse(prima));
    l.forEach(x => ids.push(x.id));
    if ((j.workflow_runs || []).length < 100) break;
  }
  const lista = ids.slice(0, MAX_PER_GIRO);
  log(`Esecuzioni concluse prima di ${prima}: ${lista.length}${ids.length > MAX_PER_GIRO ? ' (le altre al prossimo giro)' : ''}`);
  if (soloProva) { log('Prova: non cancello nulla'); return { trovate: lista.length, cancellate: 0, errori: 0 }; }
  let ok = 0, err = 0;
  for (const id of lista) {
    const r = await fetchF(`https://api.github.com/repos/${repo}/actions/runs/${id}`, { method: 'DELETE', headers: h });
    if (r.status === 204 || r.status === 404) ok++; else { err++; if (r.status === 403 || r.status === 401) { log('Permesso negato: serve «Actions: Read and write» per il token del flusso'); break; } }
    if (attesa) await pausa(attesa);
  }
  log(`Cancellate: ${ok}${err ? ', non riuscite: ' + err : ''}`);
  return { trovate: lista.length, cancellate: ok, errori: err };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  pulisci({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN, ore: process.env.ORE, soloProva: process.env.SOLO_PROVA === '1' })
    .then(r => process.exit(r.errori ? 1 : 0)).catch(e => { console.error('Errore: ' + (e.message || e)); process.exit(1); });
}
