// Statement conversion tests that need no DOM (BAI2, detection, CSV output). camt.05x XML
// conversion uses the browser's DOMParser and is covered by tests/statements.spec.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, convertBai2, detectFormat, prepareImport, rowsToCSV } from '../src/statement.js';
import { previewCSV } from '../src/csv.js';

const BAI2 = [
  '01,BANKID,CUSTID,260106,0800,1,,,2/',
  '02,CUSTID,BANKID,1,260106,0800,USD,2/',
  '03,000123456,USD,010,500000,,/',
  '16,165,440000,0,BR-1002,PO-1002,Processor settlement',
  '88,for payout PO-1002',
  '16,475,12500,0,BR-CHK,,Check paid',
  '16,165,120000,V,260107,0900,BR-1007,PO-1007/',
  '88,ACH deposit, unmatched',
  '16,195,99,D,2,0,50,1,49,BR-D,PO-D,Wire with distributed availability',
  '49,1060099,6/',
  '98,1060099,1,8/',
  '99,1060099,1,10/',
].join('\n');

test('detectFormat recognises CSV, BAI2, camt and other XML', () => {
  assert.equal(detectFormat('id,payout\n'), 'csv');
  assert.equal(detectFormat('﻿01,BANK,CUST/'), 'bai2');
  assert.equal(detectFormat('<?xml version="1.0"?><Document><BkToCstmrStmt>'), 'camt053');
  assert.equal(detectFormat('<Document><BkToCstmrDbtCdtNtfctn>'), 'camt054');
  assert.equal(detectFormat('<Document><BkToCstmrAcctRpt>'), 'camt052');
  assert.equal(detectFormat('<html>'), 'xml');
});

test('BAI2 keeps credits, skips debits, and reads every funds-availability layout', () => {
  const r = convertBai2(BAI2);
  assert.equal(r.skipped.debits, 1);
  assert.deepEqual(r.rows.map(x => [x.id, x.payout, x.date, x.gross_cents, x.currency]), [
    ['BR-1002', 'PO-1002', '2026-01-06', 440000, 'USD'],
    ['BR-1007', 'PO-1007', '2026-01-06', 120000, 'USD'],
    ['BR-D', 'PO-D', '2026-01-06', 99, 'USD'],
  ]);
  // 88 continuations: free text carries on with a space; after "/" it is the text field.
  assert.equal(r.rows[0].description, 'Processor settlement for payout PO-1002');
  assert.equal(r.rows[1].description, 'ACH deposit, unmatched');
});

test('BAI2 reference field and pattern choose the payout reference', () => {
  assert.equal(convertBai2(BAI2, { referenceField: 'bankRef' }).rows[0].payout, 'BR-1002');
  const { pattern } = compilePattern('PO-\\d+');
  assert.equal(convertBai2(BAI2, { referenceField: 'text', pattern }).rows[0].payout, 'PO-1002');
  // No match leaves the reference empty, which the format preview then reports.
  assert.equal(convertBai2(BAI2, { referenceField: 'text', pattern: /ZZZ/ }).rows[0].payout, '');
});

test('BAI2 without a file header is refused with a reason', () => {
  assert.match(convertBai2('16,165,100,0,A,B,C').error, /01 file header/);
});

test('converted BAI2 passes the same format preview as a hand-made bank CSV', () => {
  const p = prepareImport(BAI2);
  assert.equal(p.format, 'bai2');
  assert.equal(p.converted, true);
  assert.equal(p.rows, 3);
  const preview = previewCSV('bank', p.csv);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.validRows, 3);
});

test('rowsToCSV quotes commas and quotes without spreadsheet escaping', () => {
  const csv = rowsToCSV([{ id: 'a', payout: 'P', currency: 'USD', date: '2026-01-01', gross_cents: 5, description: '=SUM, "x"' }]);
  assert.equal(csv, 'id,payout,currency,date,gross_cents,fee_cents,description\na,P,USD,2026-01-01,5,0,"=SUM, ""x"""\n');
});

test('prepareImport passes CSV through and reports bad patterns and foreign XML', () => {
  assert.deepEqual(prepareImport('id,payout\n'), { format: 'csv', converted: false, csv: 'id,payout\n' });
  assert.match(prepareImport(BAI2, { pattern: '(' }).error, /regular expression/);
  assert.match(prepareImport('<html></html>').error, /not an ISO 20022/);
});
