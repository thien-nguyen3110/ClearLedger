import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { installApi } from './mock.js';
import { configRules, emptyState, seededState, proposalFor } from './fixtures.js';

// Tracks uncaught exceptions only. Browser-level "Failed to load resource" console
// entries for intentionally mocked 4xx/5xx responses are expected noise, not app bugs.
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
}

const csvHeader = 'id,payout,currency,date,gross_cents,fee_cents,description';

test('empty workspace loads the sample dataset and shows the reconciliation summary', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: emptyState() });
  await mockApi.install();
  mockApi.queue('POST', '/demo', route => {
    mockApi.store.state = seededState();
    return route.fulfill({ json: { status: 'loaded' } });
  });

  await page.goto('/');
  await expect(page.getByText('Your first reconciliation starts here.')).toBeVisible();
  await page.getByRole('button', { name: 'Load ReconRiver dataset' }).click();

  await expect(page.getByText('ReconRiver dataset loaded: 107 synthetic payouts. No real accounts are connected.')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('.stats')).toContainText('3'); // matched count
  await expect(page.locator('.navcount')).toHaveText('4'); // open count in sidebar

  expect(errors).toEqual([]);
});

test('exact, mismatched, and unexpected-deposit cases render distinct statuses', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');

  const row1001 = page.locator('tbody tr', { hasText: 'PO-1001' });
  await expect(row1001.locator('.badge')).toHaveText('Matched');

  const row1002 = page.locator('tbody tr', { hasText: 'PO-1002' });
  await expect(row1002.locator('.badge')).toHaveText('Amount mismatch');
  await row1002.getByRole('button', { name: 'PO-1002' }).click();
  await expect(page.locator('.figures .difference strong')).toHaveText('-$5.00');
  await expect(page.locator('.why')).toContainText('The bank received $5.00 less than expected.');

  const row1007 = page.locator('tbody tr', { hasText: 'PO-1007' });
  await expect(row1007.locator('.badge')).toHaveText('Unexpected deposit');

  expect(errors).toEqual([]);
});

test('CSV import preview flags invalid rows without contacting the server', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Imports' }).click();

  const badCsv = [csvHeader, '9002,PO-9002,EUR,02/01/2026,abc,100,Bad row'].join('\n');
  await page.getByLabel('Choose import file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(badCsv) });

  await expect(page.locator('.previewbad')).toContainText('0 of 1 row(s) look valid');
  await expect(page.locator('.previewerrors')).toContainText('this release supports USD only');
  await expect(page.locator('.previewerrors')).toContainText('date must be YYYY-MM-DD');
  expect(mockApi.store.requests.filter(r => r.path === 'import')).toHaveLength(0);

  expect(errors).toEqual([]);
});

test('a failed import retries with the same idempotency key; a changed file gets a new one', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  mockApi.queue('POST', '/import', route => route.fulfill({ status: 500, json: { error: 'temporary failure' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Imports' }).click();

  const goodCsv = [csvHeader, '9001,PO-9001,USD,2026-02-01,5000,100,Test settlement'].join('\n');
  await page.getByLabel('Choose import file').setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(goodCsv) });
  await expect(page.locator('.previewgood')).toContainText('1 row(s) match the expected format.');

  await page.getByRole('button', { name: 'Import and reconcile' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('temporary failure');
  await expect(alert).toContainText("Retrying the same file is safe: it won't create duplicates.");

  // The server accepts the retry and the new payout appears in state.
  mockApi.queue('POST', '/import', route => {
    const st = mockApi.store.state;
    st.records['processor:9001'] = { id: 'processor:9001', source: 'processor', payout: 'PO-9001', currency: 'USD', date: '2026-02-01', gross_cents: 5000, fee_cents: 100, description: 'Test settlement' };
    st.cases.push({ id: 'case-9001', payout: 'PO-9001', currency: 'USD', expected_cents: 4900, actual_cents: 0, delta_cents: -4900, kind: 'awaiting_deposit', status: 'open', fingerprint: 'fp-9001-v1', evidence: ['processor:9001'] });
    st.revision++;
    return route.fulfill({ json: { status: 'imported' } });
  });
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('status')).toContainText('Import complete. Reconciliation updated: 1 new payout.');
  await expect(page.locator('tbody tr', { hasText: 'PO-9001' }).locator('.tag.updated')).toHaveText('New evidence');

  const imports = mockApi.store.requests.filter(r => r.path === 'import');
  expect(imports).toHaveLength(2);
  const key1 = imports[0].headers['idempotency-key'];
  const key2 = imports[1].headers['idempotency-key'];
  expect(key1).toBeTruthy();
  expect(key1).toBe(key2);

  // A different file must use a different key: this is a new logical submission.
  await page.getByRole('button', { name: 'Imports' }).click();
  const otherCsv = [csvHeader, '9003,PO-9003,USD,2026-02-01,6000,100,Different row'].join('\n');
  await page.getByLabel('Choose import file').setInputFiles({ name: 'other.csv', mimeType: 'text/csv', buffer: Buffer.from(otherCsv) });
  await page.getByRole('button', { name: 'Import and reconcile' }).click();
  // The mock state did not change, so nothing new was reconciled from this file.
  await expect(page.getByRole('status')).toContainText('no new records, everything in this file was already imported');
  const key3 = mockApi.store.requests.filter(r => r.path === 'import')[2].headers['idempotency-key'];
  expect(key3).not.toBe(key1);

  expect(errors).toEqual([]);
});

test('a successful investigation renders the proposal, action, evidence, and trace', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  mockApi.queue('POST', '/cases/:id/investigate', route => {
    const proposal = proposalFor('case-1002');
    const idx = mockApi.store.state.cases.findIndex(c => c.id === 'case-1002');
    mockApi.store.state.cases[idx] = { ...mockApi.store.state.cases[idx], proposal };
    mockApi.store.state.revision++;
    return route.fulfill({ json: proposal });
  });

  await page.goto('/');
  await page.locator('tbody tr', { hasText: 'PO-1002' }).getByRole('button', { name: 'PO-1002' }).click();
  await page.getByRole('button', { name: 'Investigate exception' }).click();

  await expect(page.getByText('Review fees and refunds')).toBeVisible();
  await expect(page.locator('.draftflag')).toHaveText('Draft · Checklist (rules) · nothing has been sent, paid, or changed');
  await expect(page.getByRole('status')).toContainText('Draft suggestion ready for PO-1002.');
  // Cited evidence is marked on the record and a citation jumps to it.
  await expect(page.locator('[id="record-processor:1002-a"] .tag.cited')).toHaveText('Cited by draft');
  await page.getByRole('button', { name: 'Show record bank:1002-b' }).click();
  await expect(page.locator('[id="record-bank:1002-b"]')).toBeFocused();
  await page.getByText('Steps the investigator took').click();
  await expect(page.getByText('Fetched case evidence')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run investigation again' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('an unavailable model surfaces a clear error and never fabricates a proposal', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  mockApi.queue('POST', '/cases/:id/investigate', route => route.fulfill({ status: 502, json: { error: 'local model request failed: connection refused' } }));

  await page.goto('/');
  await page.locator('tbody tr', { hasText: 'PO-1002' }).getByRole('button', { name: 'PO-1002' }).click();
  await page.getByRole('button', { name: 'Investigate exception' }).click();

  await expect(page.getByRole('alert')).toContainText('The investigation could not finish. No draft was created.');
  await expect(page.getByRole('alert')).toContainText('connection refused');
  await expect(page.getByRole('button', { name: 'Investigate exception' })).toBeVisible();
  await expect(page.getByText('Review fees and refunds')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('an investigation that never responds times out client-side and can be retried', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => { window.__CL_INVESTIGATE_TIMEOUT_MS__ = 1500; }); // long enough for the busy state to be observed, short enough to keep the test fast
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  mockApi.queue('POST', '/cases/:id/investigate', () => new Promise(() => {})); // never resolves

  await page.goto('/');
  await page.locator('tbody tr', { hasText: 'PO-1002' }).getByRole('button', { name: 'PO-1002' }).click();
  await page.getByRole('button', { name: 'Investigate exception' }).click();
  await expect(page.getByRole('button', { name: 'Investigating…' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('timed out', { timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Investigate exception' })).toBeEnabled();

  mockApi.queue('POST', '/cases/:id/investigate', route => {
    const proposal = proposalFor('case-1002');
    const idx = mockApi.store.state.cases.findIndex(c => c.id === 'case-1002');
    mockApi.store.state.cases[idx] = { ...mockApi.store.state.cases[idx], proposal };
    return route.fulfill({ json: proposal });
  });
  await page.getByRole('button', { name: 'Investigate exception' }).click();
  await expect(page.getByText('Review fees and refunds')).toBeVisible();

  expect(errors).toEqual([]);
});

test('a stale review conflict refreshes the case and preserves the unsent note', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();

  await page.goto('/');
  await page.locator('tbody tr', { hasText: 'PO-1002' }).getByRole('button', { name: 'PO-1002' }).click();
  await page.getByLabel('Reviewer note').fill('Checked the fee schedule against the statement.');

  // Another import changed this payout's evidence, as the real server would on a conflict.
  mockApi.queue('POST', '/cases/:id/review', route => {
    const idx = mockApi.store.state.cases.findIndex(c => c.id === 'case-1002');
    mockApi.store.state.cases[idx] = { ...mockApi.store.state.cases[idx], fingerprint: 'fp-1002-v2' };
    mockApi.store.state.revision++;
    return route.fulfill({ status: 409, json: { error: 'conflict: record or case changed' } });
  });
  await page.getByRole('button', { name: 'Record review' }).click();
  await expect(page.locator('.alert')).toContainText('evidence changed');
  await expect(page.getByLabel('Reviewer note')).toHaveValue('Checked the fee schedule against the statement.');
  // Resubmission must be deliberate: the button stays disabled until the reviewer confirms.
  await expect(page.getByRole('button', { name: 'Record review' })).toBeDisabled();
  await page.getByRole('button', { name: 'I’ve checked the updated records' }).click();

  mockApi.queue('POST', '/cases/:id/review', route => {
    const idx = mockApi.store.state.cases.findIndex(c => c.id === 'case-1002');
    mockApi.store.state.cases[idx] = { ...mockApi.store.state.cases[idx], status: 'reviewed', review_note: mockApi.store.state.cases[idx].review_note };
    return route.fulfill({ json: { status: 'reviewed' } });
  });
  await page.getByRole('button', { name: 'Record review' }).click();
  await expect(page.getByText('Review recorded for PO-1002. Source amounts remain available in the evidence package.')).toBeVisible();
  const reviews = mockApi.store.requests.filter(r => r.path.endsWith('/review'));
  expect(JSON.parse(reviews[1].body).fingerprint).toBe('fp-1002-v2');

  expect(errors).toEqual([]);
});

test('evidence export downloads the current state as JSON', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export evidence' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('clearledger-evidence.json');

  expect(errors).toEqual([]);
});

test('keyboard users can skip to content and select a case with the keyboard', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');

  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();

  await page.locator('tbody tr', { hasText: 'PO-1001' }).getByRole('button', { name: 'PO-1001' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.detail h2')).toBeFocused();
  await expect(page.locator('.detail h2')).toHaveText('PO-1001');

  expect(errors).toEqual([]);
});

test('the page has no horizontal overflow on a narrow viewport', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  await expect(page.getByRole('table')).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

test('the payout table shows a signed difference column and sorts by it in both directions', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');

  await expect(page.locator('tbody tr', { hasText: 'PO-1002' }).locator('.deltacell')).toHaveText('-$5.00');
  await expect(page.locator('tbody tr', { hasText: 'PO-1007' }).locator('.deltacell')).toHaveText('+$12.00');
  await expect(page.locator('tbody tr', { hasText: 'PO-1001' }).locator('.deltacell')).toHaveText('$0.00');

  const deltaHeader = page.locator('th', { hasText: 'Difference' });
  const firstRow = page.locator('tbody tr').first();
  await expect(deltaHeader).toHaveAttribute('aria-sort', 'none');
  await expect(firstRow).toContainText('PO-1001'); // server order until a column is chosen

  await page.getByRole('button', { name: 'Difference, not sorted' }).click();
  await expect(deltaHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(firstRow).toContainText('PO-1003'); // -$68.50, the largest missing deposit

  await page.getByRole('button', { name: 'Difference, sorted ascending' }).click();
  await expect(deltaHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(firstRow).toContainText('PO-1007'); // +$12.00, the unexpected deposit

  await page.getByRole('button', { name: 'Difference, sorted descending' }).click();
  await expect(deltaHeader).toHaveAttribute('aria-sort', 'none');
  await expect(firstRow).toContainText('PO-1001');

  // Sorting composes with the status filter and only reorders the fetched rows.
  await page.getByRole('button', { name: 'Needs review' }).click();
  await page.getByRole('button', { name: 'Expected net, not sorted' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await expect(firstRow).toContainText('PO-1007'); // expected $0.00
  expect(mockApi.store.requests.filter(r => r.path === 'state')).toHaveLength(1);

  expect(errors).toEqual([]);
});

test('recording a review advances to the next open case, then reports when none remain', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  const markReviewed = id => route => {
    const idx = mockApi.store.state.cases.findIndex(c => c.id === id);
    mockApi.store.state.cases[idx] = { ...mockApi.store.state.cases[idx], status: 'reviewed', review_note: 'checked' };
    mockApi.store.state.revision++;
    return route.fulfill({ json: { status: 'reviewed' } });
  };

  await page.goto('/');
  await page.locator('tbody tr', { hasText: 'PO-1002' }).getByRole('button', { name: 'PO-1002' }).click();
  await page.getByLabel('Reviewer note').fill('Fee schedule confirmed against the statement.');
  mockApi.queue('POST', '/cases/:id/review', markReviewed('case-1002'));
  await page.getByRole('button', { name: 'Record review' }).click();

  await expect(page.getByRole('status')).toContainText('Moved to the next open case, PO-1003.');
  await expect(page.locator('.detail h2')).toHaveText('PO-1003');
  await expect(page.locator('.detail h2')).toBeFocused();
  await expect(page.getByLabel('Reviewer note')).toHaveValue('');
  await expect(page.locator('tbody tr', { hasText: 'PO-1002' }).locator('.badge')).toHaveText('Reviewed');

  // Close the remaining open cases out of band, then review the last one.
  for (const id of ['case-1004', 'case-1007']) {
    const idx = mockApi.store.state.cases.findIndex(c => c.id === id);
    mockApi.store.state.cases[idx] = { ...mockApi.store.state.cases[idx], status: 'reviewed', review_note: 'checked' };
  }
  await page.getByLabel('Reviewer note').fill('Deposit still missing; statement requested.');
  mockApi.queue('POST', '/cases/:id/review', markReviewed('case-1003'));
  await page.getByRole('button', { name: 'Record review' }).click();

  await expect(page.getByRole('status')).toContainText('No cases currently need review.');
  await expect(page.locator('.detail h2')).toHaveText('PO-1003');
  await expect(page.locator('.navcount')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('the CSV summary download is derived from fetched cases and labelled as non-authoritative', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  await expect(page.getByText('CSV is a derived summary. The JSON evidence export is the source of record.')).toBeVisible();

  const requestsBefore = mockApi.store.requests.length;
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV summary' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('clearledger-payout-summary.csv');
  const lines = fs.readFileSync(await download.path(), 'utf8').trim().split('\r\n');
  expect(lines[0]).toBe('payout,status,kind,expected_cents,actual_cents,delta_cents,expected_usd,actual_usd,delta_usd,source_records');
  expect(lines).toHaveLength(8); // header + 7 payouts
  expect(lines).toContain('PO-1002,open,amount_mismatch,4900,4400,-500,49.00,44.00,-5.00,2');
  expect(lines).toContain('PO-1007,open,unexpected_deposit,0,1200,1200,0.00,12.00,12.00,1');
  expect(mockApi.store.requests.length).toBe(requestsBefore); // no server call; purely client-side
  await expect(page.getByRole('status')).toContainText('derived view of revision 2');

  expect(errors).toEqual([]);
});

test('a case permalink selects that case on load, follows selection, and reacts to hash changes', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();

  await page.goto('/#case=case-1007');
  await expect(page.locator('.detail h2')).toHaveText('PO-1007');

  await page.locator('tbody tr', { hasText: 'PO-1002' }).getByRole('button', { name: 'PO-1002' }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#case=case-1002');

  await page.evaluate(() => { window.location.hash = '#case=case-1003'; });
  await expect(page.locator('.detail h2')).toHaveText('PO-1003');
  await expect(page.locator('.detail h2')).toBeFocused();

  // An unknown id falls back to the first open case rather than an empty panel.
  // (A hash-only goto is a same-document navigation, so reload to get a fresh load.)
  await page.evaluate(() => { window.location.hash = '#case=does-not-exist'; });
  await page.reload();
  await expect(page.locator('.detail h2')).toHaveText('PO-1002');
  await expect.poll(() => new URL(page.url()).hash).toBe('#case=case-1002');

  expect(errors).toEqual([]);
});

test('search matches payout references, evidence record IDs, and record descriptions', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  const search = page.getByLabel('Search payouts');
  const rows = page.locator('tbody tr');

  await search.fill('chargeback');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('PO-1001');

  await search.fill('bank:1007');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('PO-1007');

  await search.fill('po-100');
  await expect(rows).toHaveCount(7);

  await search.fill('no such record');
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No payouts match this filter.')).toBeVisible();

  expect(errors).toEqual([]);
});
