// Pure-function tests for the matching-rules dry run. Run with: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMBINE_LIMIT, DEFAULT_RULES, dollarsToCents, dryRun, editDistance, normalizeRules } from '../src/rules.js';

const rec = (id, source, payout, date, gross, fee = 0) => ({ id, source, payout, currency: 'USD', date, gross_cents: gross, fee_cents: fee, description: '' });
const kase = (id, payout, kind, expected, actual, evidence, status = 'open') => ({ id, payout, kind, status, expected_cents: expected, actual_cents: actual, delta_cents: actual - expected, evidence, fingerprint: 'fp-' + id });

function workspace() {
  const records = Object.fromEntries([
    rec('p:1', 'processor', 'PO-1', '2026-01-05', 10000, 0),
    rec('b:1', 'bank', 'PO-1', '2026-01-06', 9950),
    rec('p:2', 'processor', 'PO-2', '2026-01-05', 7000, 150),
    rec('b:9', 'bank', 'PO-9', '2026-01-07', 6850),
    rec('p:3', 'processor', 'PO-3', '2026-01-05', 3000, 0),
    rec('p:4', 'processor', 'PO-4', '2026-01-06', 2000, 0),
    rec('b:8', 'bank', 'DEP-COMBINED', '2026-01-07', 5000),
    rec('b:7', 'bank', 'PO-77', '2026-03-01', 6850),
  ].map(r => [r.id, r]));
  const cases = [
    kase('c1', 'PO-1', 'amount_mismatch', 10000, 9950, ['p:1', 'b:1']),
    kase('c2', 'PO-2', 'awaiting_deposit', 6850, 0, ['p:2']),
    kase('c9', 'PO-9', 'unexpected_deposit', 0, 6850, ['b:9']),
    kase('c3', 'PO-3', 'awaiting_deposit', 3000, 0, ['p:3']),
    kase('c4', 'PO-4', 'awaiting_deposit', 2000, 0, ['p:4']),
    kase('c8', 'DEP-COMBINED', 'unexpected_deposit', 0, 5000, ['b:8']),
    kase('c7', 'PO-77', 'unexpected_deposit', 0, 6850, ['b:7']),
    kase('c0', 'PO-0', 'matched', 100, 100, [], 'matched'),
  ];
  return { cases, records };
}

test('editDistance counts edits case-insensitively and stops at the cap', () => {
  assert.equal(editDistance('PO-1003', 'po-1003'), 0);
  assert.equal(editDistance('PO-1003', 'PO-1007'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('PO-1', 'A-VERY-DIFFERENT-REFERENCE', 3), 4);
});

test('dollarsToCents parses text exactly and rejects junk', () => {
  assert.equal(dollarsToCents('1'), 100);
  assert.equal(dollarsToCents('$1,000.5'), 100050);
  assert.equal(dollarsToCents('0.07'), 7);
  assert.equal(dollarsToCents('-1'), null);
  assert.equal(dollarsToCents('1.234'), null);
  assert.equal(dollarsToCents('abc'), null);
});

test('normalizeRules clamps stored values and keeps "off" for the reference rule', () => {
  assert.deepEqual(normalizeRules(null), { ...DEFAULT_RULES });
  assert.deepEqual(normalizeRules({ amountCents: -5, dateDays: 400, maxEdits: null }), { amountCents: 0, dateDays: 31, maxEdits: null });
  assert.equal(normalizeRules({ maxEdits: 9 }).maxEdits, 3);
  assert.equal(normalizeRules({ amountCents: 1.5 }).amountCents, DEFAULT_RULES.amountCents);
});

test('amount tolerance lists open mismatches within the drift only', () => {
  const { cases, records } = workspace();
  assert.equal(dryRun(cases, records, { amountCents: 49, dateDays: 3, maxEdits: null }).tolerance.length, 0);
  const r = dryRun(cases, records, { amountCents: 50, dateDays: 3, maxEdits: null });
  assert.deepEqual(r.tolerance.map(t => [t.case.payout, t.gap]), [['PO-1', 50]]);
});

test('one-to-one pairs need amount and date to fit; the reference rule is optional', () => {
  const { cases, records } = workspace();
  const r = dryRun(cases, records, { amountCents: 0, dateDays: 3, maxEdits: null });
  // PO-77 has the same amount but is 55 days away, so only PO-9 pairs with PO-2.
  assert.deepEqual(r.pairs.map(p => [p.awaiting.payout, p.deposit.payout, p.days, p.edits]), [['PO-2', 'PO-9', 2, 1]]);
  assert.equal(r.pairs[0].ambiguous, false);
  assert.equal(dryRun(cases, records, { amountCents: 0, dateDays: 3, maxEdits: 0 }).pairs.length, 0);
});

test('a payout that fits two deposits is flagged ambiguous, never resolved', () => {
  const { cases, records } = workspace();
  const r = dryRun(cases, records, { amountCents: 0, dateDays: 31, maxEdits: null });
  records['b:7'].date = '2026-01-08';
  const wide = dryRun(cases, records, { amountCents: 0, dateDays: 31, maxEdits: null });
  assert.equal(r.pairs.length, 1);
  assert.equal(wide.pairs.length, 2);
  assert.ok(wide.pairs.every(p => p.ambiguous));
});

test('many-to-one finds two awaiting payouts that sum to one deposit', () => {
  const { cases, records } = workspace();
  const r = dryRun(cases, records, { amountCents: 0, dateDays: 3, maxEdits: null });
  assert.deepEqual(r.combined.map(m => [m.deposit.payout, m.parts.map(c => c.payout)]), [['DEP-COMBINED', ['PO-3', 'PO-4']]]);
  assert.equal(r.combinedSkipped, false);
  // Touched: PO-2, PO-9, DEP-COMBINED, PO-3, PO-4 (PO-1's $0.50 gap is over a $0 tolerance).
  assert.equal(r.touched, 5);
  assert.equal(r.openExceptions, 7);
});

test('reviewed and matched cases are never proposed', () => {
  const { cases, records } = workspace();
  for (const c of cases) if (c.status === 'open') c.status = 'reviewed';
  const r = dryRun(cases, records, { amountCents: 100000, dateDays: 31, maxEdits: null });
  assert.equal(r.tolerance.length + r.pairs.length + r.combined.length, 0);
});

test('the many-to-one pass is skipped, and says so, above the size limit', () => {
  const records = {}, cases = [];
  for (let i = 0; i <= COMBINE_LIMIT; i++) {
    records['p:' + i] = rec('p:' + i, 'processor', 'PO-' + i, '2026-01-05', 100);
    cases.push(kase('c' + i, 'PO-' + i, 'awaiting_deposit', 100, 0, ['p:' + i]));
  }
  const r = dryRun(cases, records, DEFAULT_RULES);
  assert.equal(r.combinedSkipped, true);
  assert.equal(r.combined.length, 0);
});

test('when nothing is within tolerance, the smallest open difference is reported', () => {
  const { cases, records } = workspace();
  cases.push(kase('c5', 'PO-5', 'amount_mismatch', 1000, 1050, ['p:1']), kase('c6', 'PO-6', 'amount_mismatch', 1000, 900, ['p:1']));
  const r = dryRun(cases, records, { amountCents: 10, dateDays: 3, maxEdits: null });
  assert.equal(r.tolerance.length, 0);
  // PO-1 and PO-5 both differ by 50 cents (one each way); PO-6 by 100.
  assert.deepEqual(r.nearest, { gap: 50, count: 2 });
  assert.equal(dryRun(cases, records, { amountCents: 100, dateDays: 3, maxEdits: null }).nearest, null);
});
