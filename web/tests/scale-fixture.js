// Deterministic synthetic scale fixture: 1,000 source transactions (processor + bank rows)
// with labelled ground truth per payout. Everything here is synthetic test data generated
// from a seeded PRNG; no real accounts, merchants, or amounts, and no Math.random.
//
// reconcileForFixture() below is TEST SCAFFOLDING ONLY. It mirrors the backend grouping
// rules (backend/domain.go reconcile) just far enough to build a contract-shaped State for
// the Playwright API mock. It is not app logic: the server remains the only authority for
// matching, totals, and case kinds, and the browser never runs this code.

// ---------- seeded PRNG ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const rng = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive
  const pick = list => list[Math.floor(rng() * list.length)];
  const chance = p => rng() < p;
  const weighted = entries => {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = rng() * total;
    for (const [value, w] of entries) { if ((r -= w) < 0) return value; }
    return entries[entries.length - 1][0];
  };
  return { rng, int, pick, chance, weighted };
}

// ---------- synthetic content ----------

const KIND_WEIGHTS = [
  ['matched', 70],
  ['amount_mismatch', 10],
  ['awaiting_deposit', 7], // the "missing deposit" label
  ['ambiguous_deposit', 6],
  ['unexpected_deposit', 7],
];

const CHARGE_DESCRIPTIONS = [
  'Card settlement batch',
  'Weekly settlement',
  'Subscription renewals',
  'Online store sales',
  'In-person terminal sales',
  'Marketplace orders',
  'Invoice payments collected',
];
const REFUND_DESCRIPTIONS = ['Partial refund', 'Refund for order', 'Chargeback reversal', 'Customer goodwill credit'];
const TRICKY_SUFFIXES = [
  ', region "North", net of adjustments',
  ' (batch "A", "B"), see memo',
  ' - café, bakery & deli, "rush" orders',
  '\nMemo: two-line note, second line',
];

export const XSS_DESCRIPTION = '<img src=x onerror=alert(1)>';
export const SCRIPT_DESCRIPTION = '<script>alert("clearledger")</script> ACH deposit';
export const MARKER_DESCRIPTION = 'Zephyrine quartermaster rebate, synthetic marker';
export const QUOTED_DESCRIPTION = 'Settlement for "Northwind Sample Co., Ltd." - batch 7, "rush"\nSecond line: fees, refunds, and adjustments';
export const LONG_DESCRIPTION = (
  'Synthetic long description for layout testing: consolidated settlement covering online orders, ' +
  'terminal sales, subscription renewals, and marketplace payouts for the period, net of processor ' +
  'fees, partial refunds, and chargeback reversals; reference SYNTH-REF-0000-1111-2222-3333 retained ' +
  'for audit purposes only. No real account data.'
);
export const LARGE_CENTS = 125000000; // $1,250,000.00

function isoDate(dayOffset) {
  const d = new Date(Date.UTC(2026, 0, 1) + dayOffset * 86400000);
  return d.toISOString().slice(0, 10);
}

function processorFee(gross) {
  return Math.round(gross * 0.029) + 30; // synthetic card-like fee schedule
}

// ---------- dataset ----------

// Special payouts are always present so browser tests can target them. Each lists its
// processor/bank rows as templates; amounts are fixed, IDs and payouts are assigned later.
function specialPlans() {
  return [
    {
      special: 'largeMatched', kind: 'matched',
      processor: [{ gross: 128750000, fee: 3750000, description: 'Enterprise annual contract settlement' }],
      bank: [{ gross: LARGE_CENTS, description: 'Wire deposit' }],
    },
    {
      special: 'largeUnexpected', kind: 'unexpected_deposit',
      processor: [],
      bank: [{ gross: LARGE_CENTS, description: 'Incoming wire, reference not recognized' }],
    },
    {
      special: 'xss', kind: 'amount_mismatch',
      processor: [{ gross: 42000, fee: 1248, description: XSS_DESCRIPTION }],
      bank: [{ gross: 40000, description: SCRIPT_DESCRIPTION }],
    },
    {
      special: 'quoted', kind: 'matched',
      processor: [
        { gross: 25000, fee: 755, description: QUOTED_DESCRIPTION },
        { gross: -1500, fee: 0, description: 'Refund, order "A-1", reason: damaged' },
      ],
      bank: [{ gross: 25000 - 755 - 1500, description: 'ACH deposit, memo "split, manual"\nline two' }],
    },
    {
      special: 'long', kind: 'awaiting_deposit',
      processor: [{ gross: 91000, fee: processorFee(91000), description: LONG_DESCRIPTION }],
      bank: [],
    },
    {
      special: 'multiRefund', kind: 'matched',
      processor: [
        { gross: 60000, fee: processorFee(60000), description: 'Card settlement batch 1' },
        { gross: 35000, fee: processorFee(35000), description: 'Card settlement batch 2' },
        { gross: 12000, fee: processorFee(12000), description: 'Card settlement batch 3' },
        { gross: -4000, fee: 0, description: 'Partial refund' },
        { gross: -2500, fee: 0, description: 'Chargeback reversal' },
      ],
      bank: null, // computed: exact expected net
    },
    {
      special: 'ambiguousExact', kind: 'ambiguous_deposit',
      processor: [{ gross: 80000, fee: processorFee(80000), description: 'Weekly settlement' }],
      bank: 'split-exact', // two deposits that total the expected net exactly
    },
    {
      special: 'marker', kind: 'matched',
      processor: [{ gross: 15500, fee: processorFee(15500), description: MARKER_DESCRIPTION }],
      bank: null,
    },
  ];
}

function randomDescription(r, base) {
  let text = base + (r.chance(0.5) ? ' ' + r.int(1000, 9999) : '');
  if (r.chance(0.04)) text += r.pick(TRICKY_SUFFIXES);
  if (r.chance(0.02)) text += '. ' + LONG_DESCRIPTION.slice(0, r.int(120, 260)).trim();
  return text.trim();
}

function randomPlan(r, maxRows) {
  const kind = r.weighted(KIND_WEIGHTS);
  if (kind === 'unexpected_deposit') {
    return { kind, processor: [], bank: [{ gross: r.int(1000, 300000), description: randomDescription(r, 'Deposit, reference not recognized') }] };
  }
  const bankRows = kind === 'awaiting_deposit' ? 0 : kind === 'ambiguous_deposit' ? 2 : 1;
  const maxProcessor = Math.max(1, Math.min(4, maxRows - bankRows));
  const chargeCount = r.weighted([[1, 50], [2, 30], [3, 15], [4, 5]].filter(([n]) => n <= maxProcessor));
  const processor = [];
  for (let i = 0; i < chargeCount; i++) {
    const gross = r.chance(0.01) ? r.int(2000000, 25000000) : r.int(500, 250000);
    processor.push({ gross, fee: processorFee(gross), description: randomDescription(r, r.pick(CHARGE_DESCRIPTIONS)) });
  }
  // A refund replaces nothing; it is an extra row when budget allows.
  if (processor.length + bankRows < maxRows && r.chance(0.18)) {
    const refund = r.int(100, Math.max(100, Math.floor(processor[0].gross / 3)));
    processor.push({ gross: -refund, fee: 0, description: randomDescription(r, r.pick(REFUND_DESCRIPTIONS)) });
  }
  let bank = null;
  if (kind === 'awaiting_deposit') bank = [];
  else if (kind === 'ambiguous_deposit') bank = r.chance(0.5) ? 'split-exact' : 'split';
  else if (kind === 'amount_mismatch') bank = 'mismatch';
  return { kind, processor, bank, mismatch: kind === 'amount_mismatch' ? r.int(1, 5000) * (r.chance(0.6) ? -1 : 1) : 0 };
}

// Rows a plan will emit: its processor rows plus 0, 1, or 2 bank rows.
function rowsFor(plan) {
  const bank = plan.bank;
  return plan.processor.length + (Array.isArray(bank) ? bank.length : bank === 'split' || bank === 'split-exact' ? 2 : 1);
}

export function scaleDataset({ seed = 20260925, transactions = 1000 } = {}) {
  if (!Number.isInteger(transactions) || transactions < 40) throw new Error('transactions must be an integer >= 40');
  const r = makeRandom(seed);
  const specials = specialPlans();
  let budget = transactions - specials.reduce((s, p) => s + rowsFor(p), 0);

  const plans = [];
  let filler = 0;
  while (budget > 0) {
    let plan = randomPlan(r, Math.min(budget, 6));
    if (rowsFor(plan) > budget) {
      // Top up the exact total with single-row payouts (processor-only or bank-only).
      plan = filler++ % 2 === 0
        ? { kind: 'awaiting_deposit', processor: [{ gross: r.int(500, 50000), fee: 0, description: 'Weekly settlement' }], bank: [] }
        : { kind: 'unexpected_deposit', processor: [], bank: [{ gross: r.int(500, 50000), description: 'Deposit, reference not recognized' }] };
      plan.processor.forEach(p => { p.fee = processorFee(p.gross); });
    }
    budget -= rowsFor(plan);
    plans.push(plan);
  }
  // Scatter the special payouts through the list so they are not all at the top.
  for (const s of specials) plans.splice(Math.floor(r.rng() * (plans.length + 1)), 0, s);

  const processorRows = [];
  const bankRows = [];
  const labels = {};
  const specialPayouts = {};
  let txn = 0;
  let dep = 0;
  plans.forEach((plan, index) => {
    const payout = 'PO-' + String(10001 + index).padStart(5, '0');
    const day = r.int(0, 260);
    labels[payout] = plan.kind;
    if (plan.special) specialPayouts[plan.special] = payout;

    let expected = 0;
    for (const p of plan.processor) {
      txn++;
      processorRows.push({ id: 'txn-' + String(txn).padStart(6, '0'), payout, currency: 'USD', date: isoDate(day), gross_cents: p.gross, fee_cents: p.fee, description: p.description });
      expected += p.gross - p.fee;
    }
    let deposits;
    if (Array.isArray(plan.bank)) deposits = plan.bank;
    else if (plan.bank === null) deposits = [{ gross: expected, description: 'ACH deposit ' + payout }];
    else if (plan.bank === 'mismatch') {
      let delta = plan.mismatch;
      if (expected + delta <= 0) delta = Math.abs(delta);
      deposits = [{ gross: expected + delta, description: 'ACH deposit ' + payout }];
    } else {
      const first = Math.max(1, Math.floor(expected * (0.3 + r.rng() * 0.4)));
      const second = plan.bank === 'split-exact' ? expected - first : expected - first + r.int(1, 900);
      deposits = [
        { gross: first, description: 'ACH deposit ' + payout + ' (1 of 2)' },
        { gross: second, description: 'ACH deposit ' + payout + ' (2 of 2)' },
      ];
    }
    for (const d of deposits) {
      dep++;
      bankRows.push({ id: 'dep-' + String(dep).padStart(6, '0'), payout, currency: 'USD', date: isoDate(day + r.int(1, 3)), gross_cents: d.gross, fee_cents: 0, description: d.description });
    }
  });

  const dataset = { processorRows, bankRows, labels, specials: specialPayouts };
  assertDatasetConsistent(dataset, transactions);
  return dataset;
}

// ---------- CSV ----------

export const CSV_HEADER = ['id', 'payout', 'currency', 'date', 'gross_cents', 'fee_cents', 'description'];

function csvField(value) {
  const text = String(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

// RFC 4180: CRLF record separators, fields quoted when they contain a comma, quote, CR/LF
// (or edge whitespace), with embedded quotes doubled.
export function toCSV(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const row of rows) lines.push(CSV_HEADER.map(k => csvField(row[k])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// ---------- test-only reconciliation scaffolding ----------

function fnv1a(text, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// TEST SCAFFOLDING ONLY: mirrors backend/domain.go reconcile() grouping rules so the API
// mock can serve a contract-shaped State. Not app logic. Rules, in backend order:
// banks > 1 -> ambiguous_deposit; processor == 0 -> unexpected_deposit; banks == 0 ->
// awaiting_deposit; delta != 0 -> amount_mismatch; else matched (status matched).
// expected = sum(processor gross - fee); actual = sum(bank gross); delta = actual - expected.
export function reconcileForFixture(processorRows, bankRows) {
  const records = {};
  const toRecord = (source, row) => ({ id: source + ':' + row.id, source, payout: row.payout, currency: 'USD', date: row.date, gross_cents: row.gross_cents, fee_cents: row.fee_cents, description: row.description });
  for (const row of processorRows) { const rec = toRecord('processor', row); records[rec.id] = rec; }
  for (const row of bankRows) { const rec = toRecord('bank', row); records[rec.id] = rec; }

  const groups = new Map();
  for (const rec of Object.values(records)) {
    if (!groups.has(rec.payout)) groups.set(rec.payout, []);
    groups.get(rec.payout).push(rec);
  }
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // Go string order for ASCII
  const payouts = [...groups.keys()].sort(byCodeUnit);
  const cases = payouts.map((payout, index) => {
    const rs = groups.get(payout).sort((a, b) => byCodeUnit(a.id, b.id));
    let banks = 0, processor = 0, expected = 0, actual = 0;
    for (const rec of rs) {
      if (rec.source === 'bank') { banks++; actual += rec.gross_cents; }
      else { processor++; expected += rec.gross_cents - rec.fee_cents; }
    }
    const delta = actual - expected;
    const kind = banks > 1 ? 'ambiguous_deposit'
      : processor === 0 ? 'unexpected_deposit'
        : banks === 0 ? 'awaiting_deposit'
          : delta !== 0 ? 'amount_mismatch' : 'matched';
    const encoded = JSON.stringify(rs);
    return {
      id: 'case-' + index,
      payout,
      currency: 'USD',
      expected_cents: expected,
      actual_cents: actual,
      delta_cents: delta,
      kind,
      status: kind === 'matched' ? 'matched' : 'open',
      fingerprint: 'fp-' + fnv1a(encoded, 0x811c9dc5) + fnv1a(encoded, 0x01234567),
      evidence: rs.map(rec => rec.id),
    };
  });

  return {
    revision: 2,
    records,
    cases,
    audit: [
      { at: '2026-09-25T09:00:00Z', action: 'import.completed', detail: 'processor: ' + processorRows.length + ' new records' },
      { at: '2026-09-25T09:00:05Z', action: 'import.completed', detail: 'bank: ' + bankRows.length + ' new records' },
    ],
    imports: {},
    processed: {},
  };
}

// Self-check: every labelled payout reconciles to its intended kind, and the row total is
// exact. Throws so an inconsistent fixture can never silently reach a test.
export function assertDatasetConsistent({ processorRows, bankRows, labels }, transactions) {
  const total = processorRows.length + bankRows.length;
  if (transactions !== undefined && total !== transactions) throw new Error('scale fixture has ' + total + ' rows, expected ' + transactions);
  const ids = new Set();
  for (const row of [...processorRows.map(r => 'processor:' + r.id), ...bankRows.map(r => 'bank:' + r.id)]) {
    if (ids.has(row)) throw new Error('duplicate record id ' + row);
    ids.add(row);
  }
  const state = reconcileForFixture(processorRows, bankRows);
  const labelled = Object.keys(labels);
  if (labelled.length !== state.cases.length) throw new Error('label count ' + labelled.length + ' != case count ' + state.cases.length);
  for (const c of state.cases) {
    if (labels[c.payout] !== c.kind) throw new Error('fixture label mismatch for ' + c.payout + ': labelled ' + labels[c.payout] + ', reconciles to ' + c.kind);
  }
  return state;
}

// Convenience: reconciled State for the full scale dataset. `reviewed` optionally marks the
// first N amount_mismatch cases as reviewed (as the backend would after a human review) so
// the "Reviewed" filter has rows; the default keeps the pure reconcile output.
export function scaleState({ seed, transactions, reviewed = 0 } = {}) {
  const dataset = scaleDataset({ seed, transactions });
  const state = reconcileForFixture(dataset.processorRows, dataset.bankRows);
  let left = reviewed;
  for (const c of state.cases) {
    if (left <= 0) break;
    if (c.kind === 'amount_mismatch' && c.payout !== dataset.specials.xss) {
      c.status = 'reviewed';
      c.review_note = 'Synthetic review note: fee difference confirmed against the processor statement.';
      left--;
    }
  }
  if (reviewed > 0) state.audit.push({ at: '2026-09-25T10:00:00Z', action: 'case.reviewed', detail: reviewed + ' synthetic reviews' });
  return state;
}

export function countBy(list, key) {
  const out = {};
  for (const item of list) out[item[key]] = (out[item[key]] || 0) + 1;
  return out;
}
