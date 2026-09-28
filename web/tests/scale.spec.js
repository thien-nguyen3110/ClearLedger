import { test, expect } from '@playwright/test';
import { installApi } from './mock.js';
import { configRules } from './fixtures.js';
import {
  scaleDataset, scaleState, toCSV, reconcileForFixture, assertDatasetConsistent, countBy,
  CSV_HEADER, XSS_DESCRIPTION, MARKER_DESCRIPTION, LARGE_CENTS,
} from './scale-fixture.js';

// Scale tests against a deterministic 1,000-transaction synthetic workspace. The API is
// mocked (mock.js); the fixture's reconcile helper is test scaffolding, not app logic.

const TRANSACTIONS = 1000;
const MIB = 1024 * 1024;

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
}

// Any dialog (alert/confirm/prompt) means untrusted text was executed: fail the test.
function failOnDialog(page) {
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.type() + ': ' + d.message()); await d.dismiss(); });
  return dialogs;
}

async function openWorkspace(page, state) {
  const mockApi = installApi(page, { config: configRules(), state });
  await mockApi.install();
  const started = performance.now();
  await page.goto('/');
  const table = page.getByRole('table', { name: /^Payouts/ });
  await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 15000 });
  const renderMs = performance.now() - started;
  return { mockApi, table, rows: table.locator('tbody tr'), renderMs };
}

test.describe('scale fixture (node-side)', () => {
  test('dataset has exactly 1,000 rows, is deterministic, and labels match reconciliation', () => {
    const a = scaleDataset();
    const b = scaleDataset();
    expect(a.processorRows.length + a.bankRows.length).toBe(TRANSACTIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(scaleDataset({ seed: 7 }))).not.toBe(JSON.stringify(a));

    const state = assertDatasetConsistent(a, TRANSACTIONS);
    expect(Object.keys(state.records)).toHaveLength(TRANSACTIONS);
    for (const c of state.cases) expect(c.kind).toBe(a.labels[c.payout]);
    expect(JSON.stringify(reconcileForFixture(b.processorRows, b.bankRows))).toBe(JSON.stringify(state));

    const kinds = countBy(state.cases, 'kind');
    for (const kind of ['matched', 'amount_mismatch', 'awaiting_deposit', 'ambiguous_deposit', 'unexpected_deposit']) expect(kinds[kind]).toBeGreaterThan(0);
    expect(kinds.matched).toBeGreaterThan(state.cases.length / 2);
    expect(a.processorRows.some(r => r.gross_cents < 0)).toBe(true);
    expect(a.bankRows.every(r => r.fee_cents === 0)).toBe(true);
    for (const r of [...a.processorRows, ...a.bankRows]) {
      expect(Number.isSafeInteger(r.gross_cents) && Number.isSafeInteger(r.fee_cents)).toBe(true);
      expect(r.description.length).toBeLessThanOrEqual(1000);
    }
    expect(a.bankRows.some(r => r.gross_cents === LARGE_CENTS)).toBe(true);
    expect(a.processorRows.some(r => r.description === XSS_DESCRIPTION)).toBe(true);
    expect(a.processorRows.some(r => /[",]/.test(r.description) && r.description.includes('\n'))).toBe(true);

    const csv = toCSV(a.processorRows);
    expect(csv.split('\r\n')[0]).toBe(CSV_HEADER.join(','));
    expect(csv).toBe(toCSV(b.processorRows));
  });
});

test.describe('1,000-transaction workspace', () => {
  test('loads and renders every payout within the time budget', async ({ page }, testInfo) => {
    const errors = trackErrors(page);
    const state = scaleState();
    const { rows, renderMs } = await openWorkspace(page, state);
    console.log(`[scale] ${testInfo.project.name}: goto -> first payout row visible in ${renderMs.toFixed(0)} ms (${state.cases.length} payouts, ${Object.keys(state.records).length} records)`);
    await expect(rows).toHaveCount(state.cases.length);
    expect(renderMs).toBeLessThan(5000);

    // Server order is preserved: first and last payout references match the fixture.
    await expect(rows.first().getByRole('button', { name: state.cases[0].payout, exact: true })).toBeVisible();
    await expect(rows.last().getByRole('button', { name: state.cases.at(-1).payout, exact: true })).toBeAttached();

    // The $1,250,000.00 deposit is formatted from integer cents without precision loss.
    const large = scaleDataset().specials.largeMatched;
    await expect(rows.filter({ has: page.getByRole('button', { name: large, exact: true }) })).toContainText('$1,250,000.00');
    expect(errors).toEqual([]);
  });

  test('status filters show the fixture counts by status', async ({ page }) => {
    const errors = trackErrors(page);
    const state = scaleState({ reviewed: 15 });
    const byStatus = countBy(state.cases, 'status');
    expect(byStatus.reviewed).toBe(15);
    const { rows } = await openWorkspace(page, state);
    const group = page.getByRole('group', { name: 'Filter payouts by status' });

    const expectations = [['Needs review', byStatus.open], ['Matched', byStatus.matched], ['Reviewed', byStatus.reviewed], ['All', state.cases.length]];
    for (const [label, count] of expectations) {
      const button = group.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(rows).toHaveCount(count);
    }
    expect(errors).toEqual([]);
  });

  test('search narrows to a payout reference and to a description substring', async ({ page }) => {
    const errors = trackErrors(page);
    const state = scaleState();
    const { specials } = scaleDataset();
    const { rows } = await openWorkspace(page, state);
    const search = page.getByRole('searchbox', { name: 'Search payouts' });

    const target = state.cases[Math.floor(state.cases.length / 2)].payout;
    await search.fill(target);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByRole('button', { name: target, exact: true })).toBeVisible();

    // A unique description marker finds only its payout.
    await search.fill('zephyrine quartermaster');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByRole('button', { name: specials.marker, exact: true })).toBeVisible();
    expect(MARKER_DESCRIPTION.toLowerCase()).toContain('zephyrine quartermaster');

    // A shared description substring finds every payout with a matching source record.
    const shared = 'partial refund';
    const expected = state.cases.filter(c => c.evidence.some(id => state.records[id].description.toLowerCase().includes(shared))).length;
    expect(expected).toBeGreaterThan(1);
    await search.fill(shared);
    await expect(rows).toHaveCount(expected);

    await search.fill('');
    await expect(rows).toHaveCount(state.cases.length);
    expect(errors).toEqual([]);
  });

  test('HTML-like descriptions render as literal text and never execute', async ({ page }) => {
    const errors = trackErrors(page);
    const dialogs = failOnDialog(page);
    const state = scaleState();
    const { specials } = scaleDataset();
    const { rows } = await openWorkspace(page, state);

    await page.getByRole('searchbox', { name: 'Search payouts' }).fill(specials.xss);
    await expect(rows).toHaveCount(1);
    await rows.first().getByRole('button', { name: specials.xss, exact: true }).click();
    await expect(page.getByRole('heading', { name: specials.xss, exact: true })).toBeVisible();

    await expect(page.getByText(XSS_DESCRIPTION, { exact: true })).toBeVisible();
    await expect(page.getByText('<script>alert("clearledger")</script> ACH deposit', { exact: true })).toBeVisible();
    await expect(page.locator('img[src="x"], img[onerror]')).toHaveCount(0);
    await expect(page.locator('main script')).toHaveCount(0);
    // Give any injected handler a chance to fire before asserting nothing did.
    await page.waitForTimeout(300);
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('no horizontal page overflow at mobile width, including long descriptions', async ({ page }) => {
    const errors = trackErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const state = scaleState();
    const { specials } = scaleDataset();
    const { rows } = await openWorkspace(page, state);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);

    for (const payout of [specials.long, specials.quoted, specials.largeMatched]) {
      await page.getByRole('searchbox', { name: 'Search payouts' }).fill(payout);
      await expect(rows).toHaveCount(1);
      await rows.first().getByRole('button', { name: payout, exact: true }).click();
      await expect(page.getByRole('heading', { name: payout, exact: true })).toBeVisible();
      expect(await overflow(), 'overflow with ' + payout + ' selected').toBeLessThanOrEqual(1);
    }
    expect(errors).toEqual([]);
  });

  test('import preview accepts every processor row of the scale CSV', async ({ page }) => {
    const errors = trackErrors(page);
    const { processorRows } = scaleDataset();
    const csv = toCSV(processorRows);
    const bytes = Buffer.byteLength(csv, 'utf8');
    const requestBytes = Buffer.byteLength(JSON.stringify({ source: 'processor', csv }), 'utf8');
    console.log(`[scale] processor CSV: ${processorRows.length} rows, ${bytes} bytes (JSON request ${requestBytes} bytes)`);
    expect(bytes).toBeLessThan(2 * MIB);
    expect(requestBytes).toBeLessThan(2 * MIB);

    const { mockApi } = await openWorkspace(page, scaleState());
    await page.getByRole('button', { name: 'Imports' }).click();
    await page.getByLabel('Choose CSV file').setInputFiles({ name: 'processor-scale.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await expect(page.getByText(`${processorRows.length} row(s) match the expected format.`)).toBeVisible();
    await expect(page.getByText(/row\(s\) look valid/)).toHaveCount(0);

    // The submitted body carries the exact CSV bytes (quotes, commas, newlines intact).
    await page.getByRole('button', { name: 'Import and reconcile' }).click();
    await expect(page.getByRole('status')).toContainText('Import complete. Reconciliation updated');
    const imports = mockApi.store.requests.filter(r => r.method === 'POST' && r.path === 'import');
    expect(imports).toHaveLength(1);
    expect(JSON.parse(imports[0].body)).toEqual({ source: 'processor', csv });
    expect(errors).toEqual([]);
  });
});
