// The matching-rules view and statement import against a workspace shaped like the default
// ReconRiver demo. Counts and totals come from the state the mocked server returns.
import { test, expect } from '@playwright/test';
import { installApi } from './mock.js';
import { configRules } from './fixtures.js';
import { reconRiverShape } from './reconriver-shape.js';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
}
async function open(page, state) {
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  await page.goto('/');
  await expect(page.getByRole('table')).toBeVisible();
  return mockApi;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('rr-init')) { localStorage.removeItem('clearledger-rules'); sessionStorage.setItem('rr-init', '1'); } } catch { /* ignore */ } });
});

test('the fixture has the demo shape: 22 open cases, no multiple deposits', () => {
  const { state } = reconRiverShape();
  const count = kind => state.cases.filter(c => c.kind === kind).length;
  expect([count('amount_mismatch'), count('awaiting_deposit'), count('unexpected_deposit'), count('ambiguous_deposit')]).toEqual([8, 9, 5, 0]);
  expect(state.cases.filter(c => c.kind === 'amount_mismatch').every(c => c.delta_cents === 200)).toBe(true);
  expect(state.cases.filter(c => c.kind === 'unexpected_deposit').every(c => c.actual_cents === 2500)).toBe(true);
  expect(state.cases.filter(c => c.payout.includes('REFUND')).every(c => c.kind === 'matched' && c.actual_cents < 0)).toBe(true);
});

test('the dry run points to the smallest difference, then lists the eight +$2.00 mismatches by full reference', async ({ page }) => {
  const errors = trackErrors(page);
  const { state } = reconRiverShape();
  await open(page, state);
  await page.keyboard.press('5');
  const results = page.getByRole('region', { name: 'Dry run' });
  await expect(results.locator('.panelheading')).toContainText('0 of 22 open payouts have a lead');
  await expect(results).toContainText('The smallest open difference is $2.00 (8 payouts).');
  await results.getByRole('button', { name: 'Use $2.00' }).click();
  await expect(page.getByLabel('Amount tolerance (USD)')).toHaveValue('2.00');

  const tolerance = results.getByRole('table', { name: /within the amount tolerance/ });
  await expect(tolerance.locator('tbody tr')).toHaveCount(8);
  await expect(tolerance.locator('tbody td.num:last-child')).toHaveText(Array(8).fill('+$2.00'));
  // References are shown whole, colons and all.
  await expect(tolerance.getByRole('button', { name: 'Open MX:SYNTH-BATCH-AMOUNT-BREAK-000266' })).toHaveText('MX:SYNTH-BATCH-AMOUNT-BREAK-000266');
  await expect(results.locator('.panelheading')).toContainText('8 of 22 open payouts have a lead');

  // $25.00 deposits and $500+ missing payouts never pair, even with a month-wide window.
  await page.getByLabel('Date window (days)').fill('31');
  await expect(results).toContainText('No awaiting payout fits an unexpected deposit under these rules.');
  await expect(results).toContainText('No unexpected deposit equals two awaiting payouts under these rules.');

  // Nothing on the page scrolls sideways at any width; long references wrap.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('a reviewed mismatch leaves the dry run but keeps its kind', async ({ page }) => {
  const { state } = reconRiverShape();
  const mockApi = await open(page, state);
  await page.getByRole('button', { name: 'Matching rules' }).click();
  await page.getByLabel('Amount tolerance (USD)').fill('2');
  const tolerance = page.getByRole('table', { name: /within the amount tolerance/ });
  await expect(tolerance.locator('tbody tr')).toHaveCount(8);

  const target = mockApi.store.state.cases.find(c => c.payout === 'MX:SYNTH-BATCH-AMOUNT-BREAK-000266');
  target.status = 'reviewed';
  target.review_note = 'Bank statement shows a $2.00 adjustment credit.';
  mockApi.store.state.revision++;
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(tolerance.locator('tbody tr')).toHaveCount(7);
  await expect(page.getByRole('region', { name: 'Dry run' }).locator('.panelheading')).toContainText('7 of 21 open payouts have a lead');

  await page.keyboard.press('1');
  const row = page.locator('tbody tr', { hasText: 'MX:SYNTH-BATCH-AMOUNT-BREAK-000266' });
  await expect(row.locator('.badge')).toHaveText('Reviewed');
  await expect(row.locator('.deltacell')).toHaveText('+$2.00');
});

test('the demo bank file, written as a camt.053 statement, converts back to the same bank records', async ({ page }) => {
  const errors = trackErrors(page);
  const { bank, state } = reconRiverShape();
  const mockApi = await open(page, state);
  const money = c => (Math.abs(c) / 100).toFixed(2);
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>'
    + bank.map(b => `<Ntry><Amt Ccy="USD">${money(b.gross_cents)}</Amt><CdtDbtInd>${b.gross_cents < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${b.date}</Dt></BookgDt><AcctSvcrRef>${b.id}</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>${b.payout}</EndToEndId></Refs></TxDtls></NtryDtls></Ntry>`).join('')
    + '</Stmt></BkToCstmrStmt></Document>';
  await page.getByRole('button', { name: 'Imports' }).click();
  await page.getByLabel('Choose import file').setInputFiles({ name: 'demo-bank.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  const debits = bank.filter(b => b.gross_cents < 0).length;
  await expect(page.locator('.statement .banner')).toContainText((bank.length - debits) + ' credits and ' + debits + ' debits converted.');
  await expect(page.locator('.previewgood')).toContainText(bank.length + ' row(s) match the expected format.');
  await page.getByRole('button', { name: 'Import and reconcile' }).click();
  await expect(page.getByRole('status')).toContainText('Import complete.');

  const body = JSON.parse(mockApi.store.requests.find(r => r.path === 'import').body);
  const sent = body.csv.trim().split('\n').slice(1).map(line => line.split(','));
  // Same IDs, references, dates, signs and cents as the bank file; only descriptions differ.
  expect(sent.map(([id, payout, , date, gross, fee]) => [id, payout, date, Number(gross), fee])).toEqual(
    bank.map(b => [b.id, b.payout, b.date, b.gross_cents, '0']));
  expect(sent.filter(r => Number(r[4]) < 0).every(r => r[6].startsWith('Bank debit'))).toBe(true);
  expect(errors).toEqual([]);
});
