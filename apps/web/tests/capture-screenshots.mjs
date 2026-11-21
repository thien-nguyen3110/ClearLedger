// Dev utility to regenerate the handoff screenshots. Not part of the test:e2e suite.
// Usage: start `node tests/static-server.mjs` in one terminal, then run this file.
// Every screen uses the contract-shaped mock in tests/mock.js, never a real backend.
import { chromium } from 'playwright-core';
import { installApi } from './mock.js';
import { configRules, proposalFor, seededState } from './fixtures.js';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const outDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'docs', 'frontend', 'screenshots');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };

function withDraftAndHistory() {
  const state = seededState();
  const i = state.cases.findIndex(c => c.id === 'case-1002');
  state.cases[i] = { ...state.cases[i], proposal: proposalFor('case-1002') };
  state.audit.push({ at: '2026-01-07T10:00:00Z', action: 'investigation.drafted', detail: 'PO-1002: rules' });
  return state;
}
function withReopened() {
  const state = seededState();
  state.audit.push(
    { at: '2026-01-07T10:05:00Z', action: 'case.reviewed', detail: 'PO-1004: Both transfers belong to this payout; processor split it.' },
    { at: '2026-01-08T09:00:00Z', action: 'import.completed', detail: 'bank: 1 new records' },
  );
  return state;
}

async function shot(name, viewport, { state = seededState(), fullPage = false, before, after } = {}) {
  const page = await browser.newPage({ viewport });
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  if (before) await before(page, mockApi);
  await page.goto('http://127.0.0.1:15173/');
  await page.waitForSelector('table, .empty, .alert');
  if (after) await after(page, mockApi);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, name), fullPage });
  await page.close();
}
const open = payout => async page => {
  await page.locator('tbody tr', { hasText: payout }).getByRole('button', { name: payout }).click();
};

await shot('desktop-reconciliation.png', desktop, { state: withDraftAndHistory(), after: open('PO-1002') });
await shot('desktop-case-full.png', desktop, { state: withDraftAndHistory(), fullPage: true, after: open('PO-1002') });
await shot('desktop-awaiting-deposit.png', desktop, { after: open('PO-1003') });
await shot('desktop-reopened-case.png', desktop, { state: withReopened(), after: open('PO-1004') });
await shot('desktop-error-state.png', desktop, {
  before: (page, api) => api.queue('GET', '/state', route => route.fulfill({ status: 503, json: { error: 'request limiter unavailable' } })),
});
await shot('desktop-imports.png', desktop, { after: page => page.getByRole('button', { name: 'Imports' }).click() });
await shot('desktop-import-preview.png', desktop, {
  after: async page => {
    await page.getByRole('button', { name: 'Imports' }).click();
    const csv = 'id,payout,currency,date,gross_cents,fee_cents,description\n9002,PO-9002,EUR,02/01/2026,abc,100,Bad row\n9001,PO-9001,USD,2026-02-01,5000,100,Good row';
    await page.getByLabel('Choose CSV file').setInputFiles({ name: 'mixed.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForSelector('.csvpreview');
  },
});
await shot('desktop-activity.png', desktop, { state: withDraftAndHistory(), after: page => page.getByRole('button', { name: 'Activity' }).click() });
await shot('mobile-reconciliation.png', mobile, { fullPage: true });
await shot('mobile-detail.png', mobile, { state: withDraftAndHistory(), fullPage: true, after: open('PO-1002') });

await browser.close();
console.log('screenshots written to', outDir);
