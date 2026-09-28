// Contract-conformant fixtures (the frozen /api contract: endpoints, field names, integer cents). Shapes mirror the
// documented Config/State/Case/Record/Proposal objects and the starter's documented
// initial demo dataset: 15 source records, 7 payout groups, 3 matched + 4 open.

export function configRules() {
  return { investigator: 'rules', storage: 'local-file', redis_configured: false, kafka_configured: false };
}

export function configOllama() {
  return { investigator: 'ollama:qwen3:4b', storage: 'local-file', redis_configured: false, kafka_configured: false };
}

export function emptyState() {
  return { revision: 0, records: {}, cases: [], audit: [], imports: {}, processed: {} };
}

function rec(id, source, payout, date, gross, fee, description) {
  return { id: source + ':' + id, source, payout, currency: 'USD', date, gross_cents: gross, fee_cents: fee, description };
}

export function seededState() {
  const records = {};
  const add = r => { records[r.id] = r; };

  // PO-1001: matched, with a processor refund offsetting a fee (3 source records).
  add(rec('1001-a', 'processor', 'PO-1001', '2026-01-05', 10000, 200, 'Weekly settlement'));
  add(rec('1001-b', 'processor', 'PO-1001', '2026-01-05', -1000, 0, 'Chargeback refund'));
  add(rec('1001-c', 'bank', 'PO-1001', '2026-01-06', 8800, 0, 'ACH deposit PO-1001'));

  // PO-1002: amount_mismatch, delta -500.
  add(rec('1002-a', 'processor', 'PO-1002', '2026-01-05', 5000, 100, 'Weekly settlement'));
  add(rec('1002-b', 'bank', 'PO-1002', '2026-01-06', 4400, 0, 'ACH deposit PO-1002'));

  // PO-1003: awaiting_deposit (processor only).
  add(rec('1003-a', 'processor', 'PO-1003', '2026-01-05', 7000, 150, 'Weekly settlement'));

  // PO-1004: ambiguous_deposit (two bank rows).
  add(rec('1004-a', 'processor', 'PO-1004', '2026-01-05', 8000, 100, 'Weekly settlement'));
  add(rec('1004-b', 'bank', 'PO-1004', '2026-01-06', 4000, 0, 'ACH deposit PO-1004 (1 of 2)'));
  add(rec('1004-c', 'bank', 'PO-1004', '2026-01-06', 3900, 0, 'ACH deposit PO-1004 (2 of 2)'));

  // PO-1005: matched, expected net 16340 after a refund.
  add(rec('1005-a', 'processor', 'PO-1005', '2026-01-05', 17000, 160, 'Weekly settlement'));
  add(rec('1005-b', 'processor', 'PO-1005', '2026-01-05', -500, 0, 'Partial refund'));
  add(rec('1005-c', 'bank', 'PO-1005', '2026-01-06', 16340, 0, 'ACH deposit PO-1005'));

  // PO-1006: matched.
  add(rec('1006-a', 'processor', 'PO-1006', '2026-01-05', 3000, 50, 'Weekly settlement'));
  add(rec('1006-b', 'bank', 'PO-1006', '2026-01-06', 2950, 0, 'ACH deposit PO-1006'));

  // PO-1007: unexpected_deposit (bank only).
  add(rec('1007-a', 'bank', 'PO-1007', '2026-01-06', 1200, 0, 'Unmatched ACH deposit'));

  const cases = [
    { id: 'case-1001', payout: 'PO-1001', currency: 'USD', expected_cents: 8800, actual_cents: 8800, delta_cents: 0, kind: 'matched', status: 'matched', fingerprint: 'fp-1001-v1', evidence: ['processor:1001-a', 'processor:1001-b', 'bank:1001-c'] },
    { id: 'case-1002', payout: 'PO-1002', currency: 'USD', expected_cents: 4900, actual_cents: 4400, delta_cents: -500, kind: 'amount_mismatch', status: 'open', fingerprint: 'fp-1002-v1', evidence: ['processor:1002-a', 'bank:1002-b'] },
    { id: 'case-1003', payout: 'PO-1003', currency: 'USD', expected_cents: 6850, actual_cents: 0, delta_cents: -6850, kind: 'awaiting_deposit', status: 'open', fingerprint: 'fp-1003-v1', evidence: ['processor:1003-a'] },
    { id: 'case-1004', payout: 'PO-1004', currency: 'USD', expected_cents: 7900, actual_cents: 7900, delta_cents: 0, kind: 'ambiguous_deposit', status: 'open', fingerprint: 'fp-1004-v1', evidence: ['processor:1004-a', 'bank:1004-b', 'bank:1004-c'] },
    { id: 'case-1005', payout: 'PO-1005', currency: 'USD', expected_cents: 16340, actual_cents: 16340, delta_cents: 0, kind: 'matched', status: 'matched', fingerprint: 'fp-1005-v1', evidence: ['processor:1005-a', 'processor:1005-b', 'bank:1005-c'] },
    { id: 'case-1006', payout: 'PO-1006', currency: 'USD', expected_cents: 2950, actual_cents: 2950, delta_cents: 0, kind: 'matched', status: 'matched', fingerprint: 'fp-1006-v1', evidence: ['processor:1006-a', 'bank:1006-b'] },
    { id: 'case-1007', payout: 'PO-1007', currency: 'USD', expected_cents: 0, actual_cents: 1200, delta_cents: 1200, kind: 'unexpected_deposit', status: 'open', fingerprint: 'fp-1007-v1', evidence: ['bank:1007-a'] },
  ];

  return {
    revision: 2,
    records,
    cases,
    audit: [
      { at: '2026-01-06T09:00:00Z', action: 'import.completed', detail: 'processor: 8 new records' },
      { at: '2026-01-06T09:00:05Z', action: 'import.completed', detail: 'bank: 7 new records' },
    ],
    imports: { 'demo-processor-v1': 'hash-a', 'demo-bank-v1': 'hash-b' },
    processed: {},
  };
}

export function proposalFor(caseId) {
  return {
    mode: 'rules',
    summary: 'Processor fees were higher than the bank deposit reflects. Confirm the fee schedule with the processor statement for this period.',
    action: 'review_fees',
    evidence: caseId === 'case-1002' ? ['processor:1002-a', 'bank:1002-b'] : [],
    trace: ['Fetched case evidence', 'Compared processor net to bank deposits', 'Selected review_fees based on fee delta'],
  };
}
