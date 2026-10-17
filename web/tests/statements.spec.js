// Bank statements on the import screen: camt.05x XML and BAI2 files convert in the browser
// to the documented bank CSV, which is what the server receives. The conversion follows the
// curated ReconRiver bank file: credits positive, debits negative ("Bank debit"), fee 0.
import { test, expect } from '@playwright/test';
import { installApi } from './mock.js';
import { configRules, seededState } from './fixtures.js';

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
}
async function openImports(page) {
  const mockApi = installApi(page, { config: configRules(), state: seededState() });
  await mockApi.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Imports' }).click();
  return mockApi;
}
const upload = (page, name, body, mimeType) => page.getByLabel('Choose import file').setInputFiles({ name, mimeType, buffer: Buffer.from(body) });

const entry = ({ amt, ind = 'CRDT', sts = 'BOOK', date = '<Dt>2026-01-06</Dt>', ref, e2e, ustrd, info }) => `
      <Ntry>
        <Amt Ccy="USD">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts><Cd>${sts}</Cd></Sts>
        <BookgDt>${date}</BookgDt><AcctSvcrRef>${ref}</AcctSvcrRef>
        <NtryDtls><TxDtls><Refs><EndToEndId>${e2e}</EndToEndId></Refs><RmtInf><Ustrd>${ustrd}</Ustrd></RmtInf></TxDtls></NtryDtls>
        <AddtlNtryInf>${info}</AddtlNtryInf>
      </Ntry>`;
const camt = entries => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt><GrpHdr><MsgId>STMT-1</MsgId></GrpHdr><Stmt><Id>S1</Id>${entries.map(entry).join('')}
  </Stmt></BkToCstmrStmt>
</Document>`;
const CAMT = camt([
  { amt: '44.00', ref: 'BNK-1', e2e: 'PO-1002', ustrd: 'Settlement PO-1002 week 1', info: 'ACH CREDIT' },
  { amt: '12', ref: 'BNK-2', e2e: 'NOTPROVIDED', ustrd: 'Payout PO-1007 from processor', info: 'ACH CREDIT' },
  { amt: '3.10', ind: 'DBIT', ref: 'BNK-3', e2e: 'FEE', ustrd: 'Account fee', info: 'FEE' },
  { amt: '9.99', sts: 'PDNG', ref: 'BNK-4', e2e: 'PO-9', ustrd: 'Pending', info: 'PENDING' },
]);

test('a camt.053 statement converts credits and debits to bank CSV and imports as bank records', async ({ page }) => {
  const errors = trackErrors(page);
  const mockApi = await openImports(page);
  await page.getByLabel('Record source').selectOption('processor');
  await upload(page, 'statement.xml', CAMT, 'application/xml');

  const panel = page.locator('.importpanel');
  const banner = panel.locator('.statement .banner');
  await expect(banner).toContainText('ISO 20022 camt.053 bank statement.');
  await expect(banner).toContainText('2 credits and 1 debit converted; 1 pending entry skipped.');
  await expect(page.getByLabel('Record source')).toBeDisabled();
  await expect(page.getByLabel('Record source')).toHaveValue('bank');
  await expect(panel.locator('.previewgood')).toContainText('3 row(s) match the expected format.');
  // Automatic reference: the end-to-end ID, or the remittance text when it is NOTPROVIDED.
  const rows = panel.locator('.previewtable tbody tr');
  await expect(rows.nth(0)).toContainText('PO-1002');
  await expect(rows.nth(1)).toContainText('Payout PO-1007 from processor');
  // A debit keeps a negative amount, as a refund payout's bank row does.
  await expect(rows.nth(2)).toContainText('-$3.10');

  // A pattern keeps only the payout ID, and the account fee, which has none, is skipped.
  await page.getByLabel('Payout reference from').selectOption('Ustrd');
  await page.getByLabel('Reference pattern (optional)').fill('PO-\\d+');
  await expect(banner).toContainText('2 credits and 0 debits converted; 1 entry without a matching reference skipped, 1 pending entry skipped.');
  await expect(rows.nth(1)).toContainText('PO-1007');
  await expect(rows.nth(1)).not.toContainText('from processor');

  await page.getByRole('button', { name: 'Import and reconcile' }).click();
  await expect(page.getByRole('status')).toContainText('Import complete.');
  const sent = mockApi.store.requests.filter(r => r.path === 'import');
  expect(sent).toHaveLength(1);
  const body = JSON.parse(sent[0].body);
  expect(body.source).toBe('bank');
  expect(body.csv).toBe([
    'id,payout,currency,date,gross_cents,fee_cents,description',
    'BNK-1,PO-1002,USD,2026-01-06,4400,0,Bank credit · ACH CREDIT',
    'BNK-2,PO-1007,USD,2026-01-06,1200,0,Bank credit · ACH CREDIT',
  ].join('\n') + '\n');
  expect(sent[0].headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
  expect(errors).toEqual([]);
});

test('debits can be left out of a statement, and the banner counts them', async ({ page }) => {
  await openImports(page);
  await upload(page, 'statement.xml', CAMT, 'application/xml');
  const debits = page.getByLabel('Include debits as negative amounts');
  await expect(debits).toBeChecked();
  await debits.uncheck();
  await expect(page.locator('.statement .banner')).toContainText('2 credits and 0 debits converted; 1 debit skipped, 1 pending entry skipped.');
  await expect(page.locator('.previewgood')).toContainText('2 row(s) match the expected format.');
});

test('a booking time with a zone is stored as its UTC calendar date', async ({ page }) => {
  await openImports(page);
  await upload(page, 'late.xml', camt([{ amt: '1.00', date: '<DtTm>2026-01-06T23:30:00-05:00</DtTm>', ref: 'BNK-9', e2e: 'PO-1002', ustrd: '', info: 'ACH' }]), 'application/xml');
  await expect(page.locator('.previewtable tbody tr').first()).toContainText('2026-01-07');
});

test('a BAI2 file converts its credits and debits', async ({ page }) => {
  const errors = trackErrors(page);
  await openImports(page);
  const bai2 = [
    '01,BANK,CUST,260106,0800,1,,,2/',
    '02,CUST,BANK,1,260106,0800,USD,2/',
    '03,000123,USD,010,0,,/',
    '16,165,440000,0,BR-1,PO-1002,ACH settlement',
    '16,475,1000,0,BR-2,PO-1004,Refund payout returned',
    '49,0,3/', '98,0,1,5/', '99,0,1,7/',
  ].join('\r\n');
  await upload(page, 'statement.bai2', bai2, 'text/plain');
  const panel = page.locator('.importpanel');
  await expect(panel.locator('.statement .banner')).toContainText('BAI2 cash management file.');
  await expect(panel.locator('.statement .banner')).toContainText('1 credit and 1 debit converted.');
  await expect(panel.locator('.previewgood')).toContainText('2 row(s) match the expected format.');
  await expect(panel.locator('.previewtable')).toContainText('$4,400.00');
  await expect(panel.locator('.previewtable')).toContainText('-$10.00');
  expect(errors).toEqual([]);
});

test('a statement that cannot be read explains why and cannot be imported', async ({ page }) => {
  await openImports(page);
  await upload(page, 'broken.xml', '<Document><BkToCstmrStmt><Ntry>', 'application/xml');
  await expect(page.getByRole('alert')).toContainText('This file is not well-formed XML.');
  await expect(page.getByRole('button', { name: 'Import and reconcile' })).toBeDisabled();

  await upload(page, 'page.xml', '<html><body>not a statement</body></html>', 'application/xml');
  await expect(page.getByRole('alert')).toContainText('not an ISO 20022 camt.052, camt.053, or camt.054 statement');
  await expect(page.getByRole('button', { name: 'Import and reconcile' })).toBeDisabled();
});

test('a pattern that matches nothing explains that nothing can be imported', async ({ page }) => {
  await openImports(page);
  await upload(page, 'statement.xml', CAMT, 'application/xml');
  await page.getByLabel('Reference pattern (optional)').fill('INV-\\d+');
  await expect(page.getByRole('alert')).toContainText('Nothing in this statement can be imported: 3 entries without a matching reference skipped, 1 pending entry skipped.');
  await expect(page.getByRole('button', { name: 'Import and reconcile' })).toBeDisabled();
  await page.getByLabel('Reference pattern (optional)').fill('(');
  await expect(page.getByRole('alert')).toContainText('not a valid regular expression');
});
