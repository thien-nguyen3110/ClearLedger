// Features added in the terminal redesign: the reconciliation bridge, amount search, the
// command line, keyboard triage, bulk review, record clues, and the close report.
import { test, expect } from '@playwright/test';
import { installApi } from './mock.js';
import { configRules, seededState } from './fixtures.js';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}
async function open(page, state = seededState()) {
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  await page.goto('/');
  await expect(page.getByRole('table')).toBeVisible();
  return mockApi;
}
const command = async (page, text) => { await page.getByLabel('clearledger:~$').fill(text); await page.getByLabel('clearledger:~$').press('Enter'); };

test('the bridge explains the whole gap with server amounts', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page);
  const summary = page.getByRole('region', { name: 'Workspace summary' });
  await expect(summary).toContainText('$477.40'); // processor net expected
  await expect(summary).toContainText('$415.90'); // bank deposits imported
  // Expected plus the four per-type differences equals received.
  await expect(summary.locator('.bridgenote')).toContainText('(-$61.50)');
  await expect(summary.locator('.sysline')).toHaveText('RECON:4 OPEN');
  await expect(summary).toContainText('0 of 4 exceptions (0%)');
  expect(errors).toEqual([]);
});

test('search matches an exact amount as well as text', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page);
  await page.getByRole('searchbox', { name: 'Search payouts' }).fill('$5.00');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toContainText('PO-1002');
  await page.getByRole('searchbox', { name: 'Search payouts' }).fill('68.50');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toContainText('PO-1003');
  expect(errors).toEqual([]);
});

test('the command line opens payouts, filters, and reports errors in its log', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page);
  await command(page, 'open PO-1003');
  await expect(page.locator('.detail h2')).toHaveText('PO-1003');
  await command(page, 'type unexpected');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await command(page, 'type all');
  await command(page, 'frobnicate');
  const log = page.getByRole('log', { name: 'Command output' });
  await expect(log).toContainText('$ open PO-1003');
  await expect(log).toContainText('Unknown command "frobnicate"');
  await command(page, 'go report');
  await expect(page.getByRole('heading', { name: 'Payout reconciliation close' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('j and k move through the list and / focuses search', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page);
  await page.getByRole('button', { name: 'PO-1001', exact: true }).click();
  await expect(page.locator('.detail h2')).toHaveText('PO-1001');
  await page.keyboard.press('j');
  await expect(page.locator('.detail h2')).toHaveText('PO-1002');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(page.locator('.detail h2')).toHaveText('PO-1002');
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search payouts' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('bulk review sends one review per payout with each fingerprint', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = await open(page);
  for (const id of ['case-1004', 'case-1007']) {
    mockApi.queue('POST', '/cases/:id/review', route => {
      const idx = mockApi.store.state.cases.findIndex(c => c.id === id);
      mockApi.store.state.cases[idx] = { ...mockApi.store.state.cases[idx], status: 'reviewed', review_note: JSON.parse(route.request().postData()).note };
      return route.fulfill({ json: { status: 'reviewed' } });
    });
  }
  await page.getByRole('checkbox', { name: 'Select for bulk review: PO-1004' }).check();
  await page.getByRole('checkbox', { name: 'Select for bulk review: PO-1007' }).check();
  const bulk = page.getByRole('form', { name: 'Bulk review' });
  await expect(bulk).toContainText('2 payouts selected.');
  await bulk.getByLabel('Note for the selected payouts').fill('Both confirmed on the bank statement dated 2026-01-06.');
  await bulk.getByRole('button', { name: 'Apply note to 2 payouts' }).click();
  await expect(page.getByRole('status')).toContainText('Recorded this note as a review on 2 payouts.');
  const reviews = mockApi.store.requests.filter(r => r.method === 'POST' && r.path.endsWith('/review')).map(r => JSON.parse(r.body));
  expect(reviews.map(r => r.fingerprint).sort()).toEqual(['fp-1004-v1', 'fp-1007-v1']);
  await expect(page.locator('tbody tr', { hasText: 'PO-1004' }).locator('.badge')).toHaveText('Reviewed');
  await expect(page.getByRole('form', { name: 'Bulk review' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('clues and ages come from record arithmetic, never overdue claims', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page);
  await page.getByRole('button', { name: 'PO-1004', exact: true }).click();
  await expect(page.locator('.clues')).toContainText('Together the deposits equal the expected net exactly');
  await page.getByRole('button', { name: 'PO-1003', exact: true }).click();
  await expect(page.locator('.agefact')).toContainText('1 day before the newest imported record (2026-01-06)');
  await expect(page.locator('.agefact')).toContainText('not an overdue claim');
  expect(errors).toEqual([]);
});
