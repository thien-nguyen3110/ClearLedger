// Curation pipeline for the ReconRiver synthetic reconciliation dataset.
//
// Dataset: "ReconRiver Synthetic Reconciliation Scenarios" by heybadrinath,
// https://huggingface.co/datasets/heybadrinath/reconriver-synthetic-reconciliation
// licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). This script keeps
// only what ClearLedger v0 reconciles and converts it to ClearLedger's CSV format; see
// backend/testdata/reconriver/ATTRIBUTION.txt for the rules. Entirely synthetic data.
//
// Usage (from the repository root):
//   node scripts/reconriver.mjs curate [--scenario <name>|all]   # download, verify, clean, write
//   node scripts/reconriver.mjs import --scenario <name>         # POST the curated files to the API
//   node scripts/reconriver.mjs compare --scenario <name>        # score /api/state against the labels
// API settings: CLEARLEDGER_BASE_URL (default http://127.0.0.1:18080) and API_TOKEN
// (environment, else the repository .env). The token is never printed.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULES_VERSION = 'clearledger-curation-v1';
// Pinned source revision: the manifest checksums below always describe the same bytes.
const REVISION = '2f128f1059b1faee78d73c0ffc0f5e745c075d9b';
const SOURCE = `https://huggingface.co/datasets/heybadrinath/reconriver-synthetic-reconciliation/resolve/${REVISION}/generated`;
const RAW_FILES = ['processor_transactions.csv', 'bank_settlements.csv', 'expected_reconciliation.csv'];
const HEADER = 'id,payout,currency,date,gross_cents,fee_cents,description';
const MAX_RECORDS = 10000; // ClearLedger workspace capacity and per-import row limit
const MAX_CSV_BYTES = 1_800_000; // the API caps the JSON request at 2 MiB

// Scenarios ClearLedger uses. failure-recovery is not curated: after cleaning it is a
// second 10,000-payment matched set like month-end-close, because what makes it
// distinct (invalid rows, repeated rows, restart contract) is exactly what the rules drop.
// Small curated scenarios are committed as test fixtures; the large one is regenerated.
const SCENARIOS = {
  'clean-settlement': { prefix: 'CS', out: 'backend/testdata/reconriver/clean-settlement', purpose: 'smoke test: every batch settles exactly' },
  'mixed-exceptions': { prefix: 'MX', out: 'backend/testdata/reconriver/mixed-exceptions', purpose: 'exception coverage for demos and regression tests' },
  'month-end-close': { prefix: 'ME', out: 'backend/data/reconriver-curated/month-end-close', purpose: 'volume near the 10,000-record capacity (regenerate; not committed)' },
};

// Source settlement outcome -> ClearLedger case kind. Outcomes absent from this map
// cannot be represented by ClearLedger v0 and their batches are quarantined.
const KIND = {
  MATCHED: 'matched',
  AMOUNT_MISMATCH: 'amount_mismatch',
  MISSING_BANK_SETTLEMENT: 'awaiting_deposit',
  MISSING_PROCESSOR: 'unexpected_deposit',
};

// Batch-level quarantine rules, applied in this order; the first match is recorded.
// A batch is kept or dropped whole, because reconciling part of a batch would give
// a different answer than its label.
const RULES = {
  R1_NON_USD: 'batch has a non-USD processor or bank row (ClearLedger v0 is USD-only)',
  R2_INVALID_ROW: 'batch has a row with an invalid ID, amount, date, fee or net',
  R3_REPEATED_SOURCE_ID: 'a source ID appears more than once; the label counts it twice, ClearLedger keeps one record per ID',
  R4_NO_LABEL: 'batch has no settlement ground truth',
  R5_OUTCOME_NOT_MODELED: 'ground-truth outcome has no ClearLedger equivalent (late settlement window, duplicate bank entry, currency mismatch)',
  R6_LABEL_ARITHMETIC: 'the label difference does not equal bank credits minus processor net for the batch rows',
  R7_LABEL_WITHOUT_ROWS: 'a settlement label names a batch that has no processor or bank rows (logged; nothing to import)',
};

function fail(message) {
  console.error('reconriver: ' + message);
  process.exit(2);
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['curate', 'import', 'compare'].includes(command)) fail('usage: node scripts/reconriver.mjs curate|import|compare [--scenario <name>|all]');
  let scenario = command === 'curate' ? 'all' : undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--scenario') scenario = rest[++i];
    else fail(`unknown argument ${rest[i]}`);
  }
  const names = scenario === 'all' ? Object.keys(SCENARIOS) : [scenario];
  for (const n of names) if (!SCENARIOS[n]) fail(`--scenario must be one of ${Object.keys(SCENARIOS).join(', ')}${command === 'curate' ? ', all' : ''}`);
  return { command, names };
}

// RFC 4180 CSV; the ground truth quotes explanations that contain commas.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length > 1 || r[0] !== '').map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
function toCSV(header, rows) {
  const cell = v => (/[",\r\n]/.test(String(v)) ? '"' + String(v).replaceAll('"', '""') + '"' : String(v));
  return header + '\n' + rows.map(r => r.map(cell).join(',')).join('\n') + (rows.length ? '\n' : '');
}
// Exact two-decimal string to integer cents; never floating point.
function cents(amount) {
  const m = /^(-?)(\d{1,12})\.(\d{2})$/.exec(amount ?? '');
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -v : v;
}
// ClearLedger parses dates with Go's 2006-01-02 layout; 2026-99-99 must fail here too.
function validDate(d) {
  const t = Date.parse(d + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function fetchRaw(name) {
  const dir = join(ROOT, 'backend', 'data', 'reconriver', 'raw', name); // git-ignored cache
  mkdirSync(dir, { recursive: true });
  const get = async file => {
    const path = join(dir, file);
    if (!existsSync(path)) {
      const res = await fetch(`${SOURCE}/${name}/${file}`, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!res.ok) fail(`download failed with HTTP ${res.status}: ${name}/${file}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
    return readFileSync(path);
  };
  const manifest = JSON.parse((await get('scenario_manifest.json')).toString('utf8'));
  const raw = { manifest, sha256: {} };
  for (const file of RAW_FILES) {
    const data = await get(file);
    raw.sha256[file] = sha256(data);
    if (manifest.file_sha256_checksums?.[file] !== raw.sha256[file]) fail(`${name}/${file} does not match the source manifest checksum; delete ${dir} and retry`);
    raw[file] = data.toString('utf8');
  }
  return raw;
}

// Source timestamps must be full UTC instants (…Z); the record keeps the UTC date.
function utcDate(timestamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(timestamp ?? '');
  return m && validDate(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60 ? m[1] : null;
}
function rowProblem(id, batch, prefix, amounts, date, extra) {
  if (!id || !batch || `${prefix}:${id}`.length > 100 || `${prefix}:${batch}`.length > 100) return 'missing ID or batch, or over 100 characters with the prefix';
  if (amounts.some(a => a === null)) return 'amount is not a two-decimal number';
  if (!date) return 'timestamp is not a valid UTC instant (YYYY-MM-DDTHH:MM:SSZ)';
  return extra;
}

function curate(name, raw) {
  const { prefix } = SCENARIOS[name];
  const tag = v => `${prefix}:${v}`;
  const processor = parseCSV(raw['processor_transactions.csv']);
  const bank = parseCSV(raw['bank_settlements.csv']);
  const truth = parseCSV(raw['expected_reconciliation.csv']).filter(r => r.result_scope === 'SETTLEMENT');

  // Normalize rows and note row-level problems.
  const rows = [];
  for (const r of processor) {
    const gross = cents(r.gross_amount), fee = cents(r.fee_amount), net = cents(r.net_amount);
    const date = utcDate(r.processor_event_time);
    const problem = rowProblem(r.processor_transaction_id, r.settlement_batch_id, prefix, [gross, fee, net], date,
      fee < 0 ? 'negative fee' : net !== gross - fee ? 'net_amount is not gross_amount - fee_amount' : null);
    // processor_status is always SETTLED in the source and net_amount is derived, so both
    // are dropped; event type and order ID stay as investigation evidence.
    rows.push({ file: 'processor', id: r.processor_transaction_id, batch: r.settlement_batch_id, currency: r.currency, problem,
      record: [tag(r.processor_transaction_id), tag(r.settlement_batch_id), 'USD', date, gross, fee, `${r.processor_event_type} for ${r.merchant_order_id}`] });
  }
  for (const r of bank) {
    const credited = cents(r.credited_amount);
    const date = utcDate(r.booked_at);
    const problem = rowProblem(r.bank_entry_id, r.settlement_batch_id, prefix, [credited], date, null);
    rows.push({ file: 'bank', id: r.bank_entry_id, batch: r.settlement_batch_id, currency: r.currency, problem,
      record: [tag(r.bank_entry_id), tag(r.settlement_batch_id), 'USD', date, credited, 0, `Bank ${credited < 0 ? 'debit' : 'credit'} ${r.bank_reference}`] });
  }

  const idCount = new Map();
  for (const r of rows) idCount.set(`${r.file}:${r.id}`, (idCount.get(`${r.file}:${r.id}`) ?? 0) + 1);
  const labels = new Map();
  for (const t of truth) {
    if (labels.has(t.settlement_batch_id)) fail(`${name}: more than one settlement label for ${t.settlement_batch_id}`);
    labels.set(t.settlement_batch_id, t);
  }
  const batches = new Map();
  for (const r of rows) (batches.get(r.batch) ?? batches.set(r.batch, []).get(r.batch)).push(r);

  const kept = [], quarantine = [], labelRows = [];
  const byRule = Object.fromEntries(Object.keys(RULES).map(k => [k, { batches: 0, rows: 0 }]));
  for (const [batch, members] of [...batches].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const label = labels.get(batch);
    const net = members.reduce((sum, r) => sum + (r.file === 'bank' ? r.record[4] : -(r.record[4] - r.record[5])), 0);
    const diff = label ? cents(label.expected_difference) : null;
    let rule = null, detail = '';
    const bad = members.find(r => r.problem);
    if (members.some(r => r.currency !== 'USD')) { rule = 'R1_NON_USD'; detail = [...new Set(members.map(r => r.currency))].sort().join('/'); }
    else if (bad) { rule = 'R2_INVALID_ROW'; detail = `${bad.file} ${bad.id}: ${bad.problem}`; }
    else if (members.some(r => idCount.get(`${r.file}:${r.id}`) > 1)) { rule = 'R3_REPEATED_SOURCE_ID'; detail = [...new Set(members.filter(r => idCount.get(`${r.file}:${r.id}`) > 1).map(r => `${r.file} ${r.id}`))].sort().join('; '); }
    else if (!label) { rule = 'R4_NO_LABEL'; }
    else if (!KIND[label.expected_outcome]) { rule = 'R5_OUTCOME_NOT_MODELED'; detail = label.expected_outcome; }
    else if (diff === null || diff !== net) { rule = 'R6_LABEL_ARITHMETIC'; detail = `label ${label.expected_difference}, rows give ${net}`; }
    if (rule) {
      byRule[rule].batches++;
      byRule[rule].rows += members.length;
      for (const r of members) quarantine.push([r.file, r.id, batch, rule, detail]);
      continue;
    }
    kept.push(...members);
    labelRows.push([tag(batch), KIND[label.expected_outcome], diff, label.expected_outcome, label.expected_reason_code]);
  }
  // A label whose batch has no processor or bank rows cannot be scored; log it too.
  for (const [batch, label] of [...labels].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (batches.has(batch)) continue;
    byRule.R7_LABEL_WITHOUT_ROWS.batches++;
    quarantine.push(['labels', label.work_key, batch, 'R7_LABEL_WITHOUT_ROWS', label.expected_outcome]);
  }
  const processorOut = kept.filter(r => r.file === 'processor').map(r => r.record).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const bankOut = kept.filter(r => r.file === 'bank').map(r => r.record).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (processorOut.length + bankOut.length > MAX_RECORDS) fail(`${name}: ${processorOut.length + bankOut.length} curated records exceed the 10,000-record capacity`);
  return { processorOut, bankOut, labelRows, quarantine, byRule, sourceRows: { processor: processor.length, bank: bank.length, settlement_labels: truth.length } };
}

function write(name, raw, c) {
  const dir = join(ROOT, SCENARIOS[name].out);
  mkdirSync(dir, { recursive: true });
  const files = {
    'processor.csv': toCSV(HEADER, c.processorOut),
    'bank.csv': toCSV(HEADER, c.bankOut),
    'labels.csv': toCSV('payout,expected_kind,expected_delta_cents,source_outcome,source_reason_code', c.labelRows),
    'quarantine.csv': toCSV('source_file,source_id,source_batch,rule,detail', c.quarantine),
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  const kinds = {};
  for (const l of c.labelRows) kinds[l[1]] = (kinds[l[1]] ?? 0) + 1;
  const manifest = {
    dataset: 'heybadrinath/reconriver-synthetic-reconciliation', license: 'CC-BY-4.0',
    attribution: 'ReconRiver Synthetic Reconciliation Scenarios by heybadrinath, https://huggingface.co/datasets/heybadrinath/reconriver-synthetic-reconciliation',
    source_revision: REVISION, source_scenario: name, source_generator_version: raw.manifest.generator_version,
    source_sha256: raw.sha256, rules_version: RULES_VERSION, purpose: SCENARIOS[name].purpose, id_prefix: SCENARIOS[name].prefix,
    source_rows: c.sourceRows,
    curated: { processor_records: c.processorOut.length, bank_records: c.bankOut.length, payouts: c.labelRows.length, expected_kinds: kinds },
    quarantined: c.byRule, rules: RULES,
    curated_sha256: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha256(t)])),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // A scenario regenerated outside git still gets its manifest committed, so its
  // curated checksums are recorded in the repository.
  if (!SCENARIOS[name].out.startsWith('backend/testdata/')) {
    writeFileSync(join(ROOT, 'backend', 'testdata', 'reconriver', `${name}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log(`${name}: kept ${c.labelRows.length} payouts (${c.processorOut.length} processor + ${c.bankOut.length} bank records) -> ${SCENARIOS[name].out}`);
  console.log(`  kinds ${JSON.stringify(kinds)}`);
  for (const [rule, n] of Object.entries(c.byRule)) if (n.batches) console.log(`  quarantined ${rule}: ${n.batches} batches, ${n.rows} rows`);
}

function readCurated(name) {
  const dir = join(ROOT, SCENARIOS[name].out);
  if (!existsSync(join(dir, 'manifest.json'))) fail(`${name} is not curated yet; run: node scripts/reconriver.mjs curate --scenario ${name}`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const text = f => {
    const t = readFileSync(join(dir, f), 'utf8');
    if (sha256(t) !== manifest.curated_sha256[f]) fail(`${SCENARIOS[name].out}/${f} changed since curation; rerun curate`);
    return t;
  };
  return { processor: text('processor.csv'), bank: text('bank.csv'), labels: parseCSV(text('labels.csv')) };
}

function apiSettings() {
  let token = process.env.API_TOKEN;
  if (token === undefined && existsSync(join(ROOT, '.env'))) {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*API_TOKEN\s*=\s*(.*)$/.exec(line);
      if (m) token = m[1].trim();
    }
  }
  return { base: (process.env.CLEARLEDGER_BASE_URL ?? 'http://127.0.0.1:18080').replace(/\/$/, ''), token: token ?? '' };
}
async function api(path, { method = 'GET', body, key } = {}) {
  const { base, token } = apiSettings();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Split a curated file into imports the API accepts. A payout may span two parts;
// every import reconciles the whole workspace again, so the result is the same.
function parts(csv) {
  const lines = csv.trimEnd().split('\n').slice(1);
  const out = [];
  let current = [], bytes = 0;
  for (const line of lines) {
    if (current.length && (current.length >= MAX_RECORDS || bytes + line.length + 1 > MAX_CSV_BYTES)) { out.push(current); current = []; bytes = 0; }
    current.push(line); bytes += line.length + 1;
  }
  if (current.length) out.push(current);
  return out.map(p => HEADER + '\n' + p.join('\n') + '\n');
}

async function importScenario(name) {
  const curated = readCurated(name);
  const state = await api('/api/state');
  const incoming = { processor: parseCSV(curated.processor), bank: parseCSV(curated.bank) };
  const fresh = incoming.processor.filter(r => !state.records['processor:' + r.id]).length + incoming.bank.filter(r => !state.records['bank:' + r.id]).length;
  const existing = Object.keys(state.records).length;
  if (existing + fresh > MAX_RECORDS) fail(`workspace holds ${existing} records; ${fresh} more would pass the 10,000-record capacity`);
  for (const source of ['processor', 'bank']) {
    for (const [i, csv] of parts(curated[source]).entries()) {
      // Content-derived key: rerunning the same curated import is an idempotent replay.
      await api('/api/import', { method: 'POST', body: { source, csv }, key: `reconriver-${name}-${source}-${i}-${sha256(csv).slice(0, 16)}` });
      console.log(`${name}: imported ${source} part ${i + 1} (${csv.split('\n').length - 2} rows)`);
    }
  }
}

async function compare(name) {
  const { labels } = readCurated(name);
  const state = await api('/api/state');
  const cases = new Map(state.cases.map(c => [c.payout, c]));
  const diffs = [];
  for (const l of labels) {
    const c = cases.get(l.payout);
    if (!c) diffs.push(`${l.payout}: no case`);
    else if (c.kind !== l.expected_kind || c.delta_cents !== Number(l.expected_delta_cents)) diffs.push(`${l.payout}: expected ${l.expected_kind} ${l.expected_delta_cents}, got ${c.kind} ${c.delta_cents}`);
  }
  const extra = [...cases.keys()].filter(p => p.startsWith(SCENARIOS[name].prefix + ':') && !labels.some(l => l.payout === p));
  console.log(`${name}: ${labels.length - diffs.length}/${labels.length} payouts match their label (kind and delta to the cent); ${extra.length} unlabeled ${SCENARIOS[name].prefix}: payouts`);
  for (const d of [...diffs, ...extra.map(p => `${p}: not in labels`)].slice(0, 20)) console.log('  DIFF ' + d);
  if (diffs.length || extra.length) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
for (const name of args.names) {
  if (args.command === 'curate') {
    const raw = await fetchRaw(name);
    write(name, raw, curate(name, raw));
  } else if (args.command === 'import') await importScenario(name);
  else await compare(name);
}
