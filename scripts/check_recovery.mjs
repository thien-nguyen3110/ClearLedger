// Exercise failure recovery on a dedicated ClearLedger Compose project.
//
// Uses only synthetic records with a fresh run ID. Never deletes volumes or resets
// a workspace. Infrastructure outages affect ONLY --project (explicitly required).
// Run the backend integration suite first; do not run it concurrently with this.
//
//   node scripts/check_recovery.mjs --project clearledger-codex --port 18080
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = 'id,payout,currency,date,gross_cents,fee_cents,description\n';
const PROJECTS = ['clearledger-codex', 'clearledger-integration'];
const USAGE = 'usage: check_recovery.mjs [-h] --project {' + PROJECTS.join(',') + '} --port PORT';

class SystemExit extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
class AssertionError extends Error {}
class NetworkError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertionError(message ?? 'AssertionError');
}

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: { project: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new SystemExit(`${USAGE}\ncheck_recovery.mjs: error: ${error.message}`, 2);
  }
  if (values.help) {
    console.log(USAGE);
    throw new SystemExit('', 0);
  }
  const missing = ['project', 'port'].filter((name) => values[name] === undefined).map((name) => '--' + name);
  if (missing.length) {
    throw new SystemExit(`${USAGE}\ncheck_recovery.mjs: error: the following arguments are required: ${missing.join(', ')}`, 2);
  }
  if (!PROJECTS.includes(values.project)) {
    throw new SystemExit(`${USAGE}\ncheck_recovery.mjs: error: argument --project: invalid choice: '${values.project}' (choose from ${PROJECTS.map((p) => `'${p}'`).join(', ')})`, 2);
  }
  if (!/^\s*[+-]?\d+\s*$/.test(values.port)) {
    throw new SystemExit(`${USAGE}\ncheck_recovery.mjs: error: argument --port: invalid int value: '${values.port}'`, 2);
  }
  return { project: values.project, port: Number.parseInt(values.port.trim(), 10) };
}

function loadSettings() {
  const settings = {};
  const envFile = path.join(ROOT, '.env');
  // The Python version required .env to exist; API_TOKEN from the environment alone is enough here.
  if (!existsSync(envFile)) return settings;
  for (const line of readFileSync(envFile, 'utf8').split(/\r\n|\n|\r/)) {
    if (line.includes('=') && !line.trimStart().startsWith('#')) {
      const at = line.indexOf('=');
      settings[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return settings;
}

async function main() {
  const args = parseCli();
  const settings = loadSettings();
  // The token is sent only in the Authorization header and is never printed.
  const token = process.env.API_TOKEN !== undefined ? process.env.API_TOKEN : (settings.API_TOKEN ?? '');
  if (!token) throw new SystemExit('API_TOKEN required');
  const base = `http://127.0.0.1:${args.port}`;
  const command = ['compose', '-p', args.project];

  function compose(...parts) {
    const result = spawnSync('docker', [...command, ...parts], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) {
      throw new Error('Compose failed: ' + parts.join(' ') + '\n' + result.error.message);
    }
    if (result.status !== 0) {
      throw new Error('Compose failed: ' + parts.join(' ') + '\n' + (result.stderr ?? '').slice(-2000));
    }
    return (result.stdout ?? '').trim();
  }

  const mapping = compose('port', 'api', '8080');
  if (mapping !== `127.0.0.1:${args.port}`) {
    throw new SystemExit('Refusing recovery test: API port does not belong to selected project');
  }

  async function request(apiPath, method = 'GET', body = null, key = null, expected = 200) {
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    if (key) headers['Idempotency-Key'] = key;
    let status;
    let data;
    try {
      const response = await fetch(base + apiPath, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(100_000),
      });
      status = response.status;
      data = await response.text();
    } catch (error) {
      // Connection refused/reset and timeouts; wait_for treats these like Python's OSError/URLError.
      throw new NetworkError(`${method} ${apiPath}: ${error.cause?.code ?? error.name}`);
    }
    if (status !== expected) {
      throw new AssertionError(`${method} ${apiPath}: HTTP ${status}, expected ${expected}; ${JSON.stringify(data.slice(0, 300))}`);
    }
    return JSON.parse(data);
  }

  async function waitFor(predicate, seconds = 100) {
    const deadline = performance.now() + seconds * 1000;
    let last = null;
    while (performance.now() < deadline) {
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        if (!(error instanceof NetworkError || error instanceof AssertionError)) throw error;
        last = error.constructor.name;
      }
      await sleep(500);
    }
    throw new AssertionError('condition did not recover within deadline: ' + String(last));
  }

  const initial = await request('/api/state');
  if ((await request('/api/config')).investigator !== 'rules') {
    throw new SystemExit('Recovery tests require checklist mode for deterministic results');
  }
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const payout = 'RECOVERY-' + runId;
  const recordId = 'recovery-' + runId;
  const csv = HEADER + `${recordId},${payout},USD,2026-09-12,1000,0,Synthetic recovery check\n`;
  const key = 'recovery-import-' + runId;
  const caseId = createHash('sha256').update(payout).digest('hex').slice(0, 16);

  async function currentCase() {
    const found = (await request('/api/state')).cases.find((c) => c.id === caseId);
    if (!found) throw new Error('synthetic case not found: ' + caseId);
    return found;
  }
  const reviewEntries = (state) => state.audit.filter((a) => a.action === 'case.reviewed' && a.detail.startsWith(payout + ': '));

  const stopped = new Set();
  try {
    compose('stop', 'kafka');
    stopped.add('kafka');
    await request('/api/import', 'POST', { source: 'processor', csv }, key);
    await request('/api/import', 'POST', { source: 'processor', csv }, key);
    const state = await request('/api/state');
    assert(Object.keys(state.records).length === Object.keys(initial.records).length + 1);
    const pending = compose('exec', '-T', 'postgres', 'psql', '-U', 'clearledger', '-d', 'clearledger', '-tAc',
      `SELECT count(*) FROM outbox WHERE published_at IS NULL AND payload->'case_ids' ? '${caseId}'`);
    assert(Number.parseInt(pending, 10) >= 1, 'import did not retain an unpublished outbox event');
    console.log('PASS: import committed while Kafka was stopped; retry did not duplicate records.');
    compose('start', 'kafka');
    stopped.delete('kafka');
    await waitFor(async () => (await currentCase()).proposal);
    console.log('PASS: broker restart delivered pending event and worker saved a draft.');

    const before = await currentCase();
    const note = 'Checked synthetic recovery evidence and requested the corresponding statement.';
    const review = { fingerprint: before.fingerprint, note };
    await request(`/api/cases/${caseId}/review`, 'POST', review);
    const reviewed = await request('/api/state');
    await request(`/api/cases/${caseId}/review`, 'POST', review);
    // Changed from a plain revision comparison: the worker saves outcomes in batches
    // and records rejected events, and both bump the revision concurrently. The
    // retry must add no case.reviewed entry; any revision change must come with
    // other Activity entries.
    const retried = await request('/api/state');
    assert(reviewEntries(retried).length === 1 && reviewEntries(reviewed).length === 1, 'review retry duplicated effect');
    assert(retried.audit.length > reviewed.audit.length || retried.revision === reviewed.revision, 'review retry duplicated effect');
    compose('restart', 'postgres');
    await waitFor(() => request('/api/state'));
    compose('restart', 'api', 'worker');
    await waitFor(() => request('/api/state'));
    const after = await currentCase();
    assert(after.status === 'reviewed' && after.review_note === note);
    assert(after.kind === 'awaiting_deposit' && after.delta_cents === -1000);
    console.log('PASS: review survived PostgreSQL/API/worker restart without asserting a match.');

    const bankCsv = HEADER + `${recordId}-bank,${payout},USD,2026-09-12,900,0,Synthetic late bank evidence\n`;
    await request('/api/import', 'POST', { source: 'bank', csv: bankCsv }, key + '-bank');
    await request(`/api/cases/${caseId}/review`, 'POST', review, null, 409);
    const changed = await currentCase();
    assert(changed.status === 'open' && changed.fingerprint !== before.fingerprint);
    assert(!changed.review_note && changed.delta_cents === -100);
    console.log('PASS: new evidence invalidated review; stale submission returned 409.');

    compose('stop', 'redis');
    stopped.add('redis');
    await request('/api/state');
    await request(`/api/cases/${caseId}/investigate`, 'POST', null, null, 503);
    compose('start', 'redis');
    stopped.delete('redis');
    await waitFor(() => request(`/api/cases/${caseId}/investigate`, 'POST'));
    console.log('PASS: Redis outage preserved reads and returned 503 for investigation; recovery succeeded.');

    const exported = await request('/api/export');
    assert(exported.records['processor:' + recordId].gross_cents === 1000);
    assert(exported.records['bank:' + recordId + '-bank'].gross_cents === 900);
    console.log('PASS: evidence export retains real API source records.');
    console.log('Synthetic recovery case retained:', payout);
  } finally {
    for (const service of [...stopped].sort()) {
      compose('start', service);
    }
  }
}

main().catch((error) => {
  if (error instanceof SystemExit) {
    if (error.message) console.error(error.message);
    process.exitCode = error.code;
  } else {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
});
