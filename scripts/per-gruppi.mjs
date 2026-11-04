// Esegue uno script una volta per ogni gruppo attivo del progetto Firebase (repository unico per tutti i gruppi).
//   node scripts/per-gruppi.mjs node scripts/idro.mjs
//   node scripts/per-gruppi.mjs python monitor-allerte/monitor_allerte.py
// Per ogni gruppo lo script parte come processo a parte con GRUPPO_ID=<codice> e OUT_DIR=<OUT_DIR o out>/<codice>:
// un errore in un gruppo non ferma gli altri (alla fine il lavoro risulta in errore se almeno un gruppo è fallito).
// Se GRUPPO_ID è già impostato (repository di un solo gruppo, o avvio manuale per un gruppo) si esegue solo per quello e le variabili restano com'erano.
// Con più gruppi le variabili «uniche» (TELEGRAM_CHAT_ID, COMUNE, CFD_*, NOME_*) non si passano agli script: valgono le impostazioni di ciascun gruppo.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { elencoGruppi } from './push.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('Uso: node scripts/per-gruppi.mjs <comando> [argomenti]'); process.exit(2); }
const LIMITE_MS = (Number(process.env.GRUPPO_TIMEOUT_S) || 170) * 1000;
const singolo = !!(process.env.GRUPPO_ID || '').trim();

let gruppi;
// PER_GRUPPI_ELENCO_FILE: solo per le prove
try { gruppi = process.env.PER_GRUPPI_ELENCO_FILE ? JSON.parse(readFileSync(process.env.PER_GRUPPI_ELENCO_FILE, 'utf8')) : await elencoGruppi(); }  catch (e) { console.log('::error::' + (e.message || e)); process.exit(1); }
if (!gruppi.length) { console.log('Nessun gruppo da servire (nessun gruppo attivo con le impostazioni compilate, oppure manca FIREBASE_SERVICE_ACCOUNT).'); process.exit(0); }
console.log(`Gruppi da servire: ${gruppi.map(g => g.id).join(', ')}`);

const esegui = g => new Promise(ris => {
  const env = { ...process.env, GRUPPO_ID: g.id, OUT_DIR: join(process.env.OUT_DIR || 'out', g.id) };
  if (!singolo) for (const v of ['TELEGRAM_CHAT_ID', 'COMUNE', 'CFD_ZONA', 'CFD_NOME_ZONA', 'NOME_GRUPPO', 'NOME_MITTENTE']) delete env[v];
  const p = spawn(cmd, args, { env, stdio: 'inherit' });
  const t = setTimeout(() => { console.log(`::error::Gruppo ${g.id}: tempo scaduto (${LIMITE_MS / 1000} s), interrotto.`); p.kill('SIGKILL'); }, LIMITE_MS);
  p.on('error', e => { clearTimeout(t); console.log(`::error::Gruppo ${g.id}: ${e.message}`); ris(1); });
  p.on('close', c => { clearTimeout(t); ris(c === 0 ? 0 : 1); });
});

let falliti = [];
for (const g of gruppi) {
  console.log(`::group::Gruppo ${g.id} (${g.comune})`);
  const c = await esegui(g);
  console.log('::endgroup::');
  if (c) { falliti.push(g.id); console.log(`::error::Gruppo ${g.id}: errore (codice ${c}).`); }
}
console.log(falliti.length ? `Terminato con errori nei gruppi: ${falliti.join(', ')}` : `Terminato: ${gruppi.length} gruppi serviti.`);
process.exit(falliti.length ? 1 : 0);
