// Matching rules dry run: tolerance rules preview leads from the workspace on screen and
// never write to the server.
import { test, expect } from '@playwright/test';
import { installApi } from './mock.js';
import { configRules, seededState } from './fixtures.js';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
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

// Seeded state plus a deposit under another reference for PO-1003 ($68.50, one day later)
// and a deposit that equals PO-1003 + PO-2001 combined.
function stateWithLeads() {
  const s = seededState();
  const add = (id, source, payout, date, gross, fee = 0) => { s.records[id] = { id, source, payout, currency: 'USD', date, gross_cents: gross, fee_cents: fee, description: 'Fixture' }; };
  add('bank:x1', 'bank', 'DEP-77', '2026-01-06', 6850);
  add('processor:2001', 'processor', 'PO-2001', '2026-01-05', 1000);
  add('bank:x2', 'bank', 'DEP-COMBO', '2026-01-07', 7850);
  s.cases.push(
    { id: 'case-dep77', payout: 'DEP-77', currency: 'USD', expected_cents: 0, actual_cents: 6850, delta_cents: 6850, kind: 'unexpected_deposit', status: 'open', fingerprint: 'fp-d77', evidence: ['bank:x1'] },
    { id: 'case-2001', payout: 'PO-2001', currency: 'USD', expected_cents: 1000, actual_cents: 0, delta_cents: -1000, kind: 'awaiting_deposit', status: 'open', fingerprint: 'fp-2001', evidence: ['processor:2001'] },
    { id: 'case-combo', payout: 'DEP-COMBO', currency: 'USD', expected_cents: 0, actual_cents: 7850, delta_cents: 7850, kind: 'unexpected_deposit', status: 'open', fingerprint: 'fp-combo', evidence: ['bank:x2'] },
  );
  return s;
}

test.beforeEach(async ({ page }) => {
  // Rules are a per-browser preference; start every test from the defaults.
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('rules-test-init')) { localStorage.removeItem('clearledger-rules'); sessionStorage.setItem('rules-test-init', '1'); } } catch { /* ignore */ } });
});

test('key 5 opens the dry run, and widening the amount tolerance lists PO-1002', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = await open(page);
  await page.keyboard.press('5');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Matching rules');
  await expect(page.locator('.rulesresults .banner')).toContainText('Preview only. Nothing is saved');

  const results = page.getByRole('region', { name: 'Dry run' });
  await expect(results).toContainText('No open amount mismatch is within $1.00.');
  await page.getByLabel('Amount tolerance (USD)').fill('5.00');
  const tolerance = results.getByRole('table', { name: /within the amount tolerance/ });
  await expect(tolerance.locator('tbody tr')).toHaveCount(1);
  await expect(tolerance).toContainText('PO-1002');
  await expect(tolerance).toContainText('-$5.00');

  // A lead opens the real case; the dry run itself never writes.
  await tolerance.getByRole('button', { name: 'Open PO-1002' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Reconciliation');
  await expect(page.locator('tr.selectedrow')).toContainText('PO-1002');
  expect(mockApi.store.requests.filter(r => r.method !== 'GET')).toEqual([]);
  expect(errors).toEqual([]);
});

test('pairs a deposit under another reference and a combined deposit, with the reference rule optional', async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, stateWithLeads());
  await command(page, 'go rules');
  const results = page.getByRole('region', { name: 'Dry run' });
  const pairs = results.getByRole('table', { name: /paired with unexpected deposits/ });
  await expect(pairs.locator('tbody tr')).toHaveCount(1);
  await expect(pairs.locator('tbody tr').first()).toContainText('PO-1003');
  await expect(pairs.locator('tbody tr').first()).toContainText('DEP-77');
  await expect(pairs.locator('tbody tr').first()).toContainText('1 day after');

  const combined = results.getByRole('table', { name: /equal two awaiting payouts/ });
  await expect(combined.locator('tbody tr')).toHaveCount(1);
  await expect(combined).toContainText('DEP-COMBO');
  await expect(combined).toContainText('PO-1003');
  await expect(combined).toContainText('PO-2001');

  // DEP-77 is far from PO-1003 as text, so requiring a similar reference removes the pair.
  await page.getByLabel('Reference similarity').selectOption('2');
  await expect(results).toContainText('No awaiting payout fits an unexpected deposit under these rules.');
  await expect(results.locator('.panelheading')).toContainText('3 of 7 open payouts have a lead');
  expect(errors).toEqual([]);
});

test('an invalid rule is explained and the last valid results stay on screen', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Matching rules' }).click();
  await page.getByLabel('Amount tolerance (USD)').fill('5');
  const tolerance = page.getByRole('table', { name: /within the amount tolerance/ });
  await expect(tolerance.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Amount tolerance (USD)').fill('five');
  await expect(page.getByLabel('Amount tolerance (USD)')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#rule-amount-hint')).toContainText('Enter an amount from 0.00 to');
  await expect(tolerance.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Date window (days)').fill('40');
  await expect(page.locator('#rule-days-hint')).toContainText('Enter whole days from 0 to 31.');
});

test('rules are remembered in this browser across a reload, and reset restores defaults', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Matching rules' }).click();
  await page.getByLabel('Amount tolerance (USD)').fill('12.50');
  await page.getByLabel('Date window (days)').fill('7');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('clearledger-rules'))).toContain('"amountCents":1250');
  await page.reload();
  await page.getByRole('button', { name: 'Matching rules' }).click();
  await expect(page.getByLabel('Amount tolerance (USD)')).toHaveValue('12.50');
  await expect(page.getByLabel('Date window (days)')).toHaveValue('7');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.getByLabel('Amount tolerance (USD)')).toHaveValue('1.00');
  await expect(page.getByLabel('Date window (days)')).toHaveValue('3');
});
