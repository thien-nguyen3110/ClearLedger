// First acceptance check for a local Docker deployment with synthetic data only.
// Node.js port of scripts/check_stack.py (no npm packages; Node 18+ for fetch).
//
//   node scripts/check_stack.mjs
//   CLEARLEDGER_BASE_URL=http://127.0.0.1:18080 node scripts/check_stack.mjs
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

class SystemExit extends Error {}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'AssertionError');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadSettings() {
  const settings = {};
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r\n|\n|\r/)) {
      if (line.includes('=') && !line.trimStart().startsWith('#')) {
        const at = line.indexOf('=');
        settings[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
    }
  }
  return settings;
}

async function main() {
  const settings = loadSettings();
  // The token is sent only in the Authorization header and is never printed.
  const token = process.env.API_TOKEN !== undefined ? process.env.API_TOKEN : (settings.API_TOKEN ?? '');
  if (!token) throw new SystemExit('Set API_TOKEN in your environment or .env first.');
  const base = process.env.CLEARLEDGER_BASE_URL ?? 'http://127.0.0.1:8080';

  async function request(apiPath, method = 'GET') {
    const response = await fetch(base + '/api/' + apiPath, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${method} /api/${apiPath}; ${body.slice(0, 300)}`);
    }
    return JSON.parse(body);
  }

  const config = await request('config');
  assert(config.storage === 'postgres', 'Expected the PostgreSQL deployment.');
  assert(config.kafka_configured, 'Kafka must be configured.');
  assert(config.redis_configured, 'Redis must be configured.');
  let state = await request('state');
  const sampleIds = new Set([
    'processor:ch_101', 'processor:ch_102', 'processor:ch_103',
    'processor:ch_104', 'processor:ch_105', 'processor:ch_106',
    'processor:re_106', 'processor:ch_107', 'bank:bn_201',
    'bank:bn_202', 'bank:bn_204a', 'bank:bn_204b', 'bank:bn_205',
    'bank:bn_206', 'bank:bn_207',
  ]);
  const recordIds = Object.keys(state.records ?? {});
  if (recordIds.length === 0) {
    await request('demo', 'POST');
  } else if (recordIds.length !== sampleIds.size || !recordIds.every((id) => sampleIds.has(id))) {
    throw new SystemExit('Workspace is nonempty and not the sample. Use a separate test deployment.');
  }
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    state = await request('state');
    assert(Object.keys(state.records).length === 15);
    assert(state.cases.length === 7);
    assert(state.cases.filter((c) => c.status === 'matched').length === 3);
    const exceptions = state.cases.filter((c) => c.kind !== 'matched');
    if (exceptions.every((c) => c.proposal)) {
      console.log('PASS: 15 source records, seven payouts, three matches, four investigation drafts.');
      console.log('This is a startup/workflow check, not a crash-recovery or model-quality benchmark.');
      return;
    }
    await sleep(2_000);
  }
  throw new SystemExit('Worker drafts not ready. Inspect api/worker/Kafka logs and Ollama configuration.');
}

main().catch((error) => {
  if (error instanceof SystemExit) {
    console.error(error.message);
  } else {
    console.error(error?.stack ?? String(error));
  }
  process.exitCode = 1;
});
