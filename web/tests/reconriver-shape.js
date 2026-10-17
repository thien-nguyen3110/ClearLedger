// A workspace shaped like the default ReconRiver demo (samples/README.md on the dataset
// branch; ReconRiver by heybadrinath, CC BY 4.0): long MX:/CS: references with colons, every
// amount mismatch +$2.00, every unexpected deposit $25.00, missing deposits, and refund
// batches that settle as negative bank debits. No multiple-deposit or short-payment cases,
// exactly like the demo; those stay covered by fixtures.js (PO-1004, PO-1002). Amounts and
// dates are generated here, not copied from the dataset. Payout names are identifiers only.
import { reconcileForFixture } from './scale-fixture.js';

const day = n => '2026-01-' + String(n).padStart(2, '0');
const pad = (n, w = 6) => String(n).padStart(w, '0');

export function reconRiverShape() {
  const processor = [], bank = [];
  const proc = (id, payout, date, gross, fee, description) => processor.push({ id, payout, date, gross_cents: gross, fee_cents: fee, description });
  const dep = (id, payout, date, gross) => bank.push({ id, payout, date, gross_cents: gross, fee_cents: 0, description: (gross < 0 ? 'Bank debit ' : 'Bank credit ') + id.replace('MX:SYNTH-BANK-', 'SYNTH-BANK-REF-').replace('CS:SYNTH-BANK-', 'SYNTH-BANK-REF-') });

  // 8 amount mismatches: one capture each, the bank credit is $2.00 more than the net.
  [266, 304, 374, 449, 508, 611, 702, 815].forEach((n, i) => {
    const gross = 50000 + i * 13111, fee = Math.round(gross * 0.029) + 30, payout = 'MX:SYNTH-BATCH-AMOUNT-BREAK-' + pad(n);
    proc('MX:SYNTH-PROC-' + pad(n), payout, day(2 + i), gross, fee, 'CAPTURE for SYNTH-ORDER-' + pad(n));
    dep('MX:SYNTH-BANK-' + pad(n), payout, day(3 + i), gross - fee + 200);
  });
  // 9 awaiting deposits: processor only.
  [183, 193, 316, 362, 566, 586, 667, 838, 893].forEach((n, i) => {
    const gross = 51000 + i * 17000, fee = Math.round(gross * 0.029) + 30;
    proc('MX:SYNTH-PROC-' + pad(n), 'MX:SYNTH-BATCH-MISSING-' + pad(n), day(1 + i), gross, fee, 'CAPTURE for SYNTH-ORDER-' + pad(n));
  });
  // 5 unexpected deposits of $25.00, dated inside the same weeks as the missing ones.
  for (let n = 1; n <= 5; n++) dep('MX:SYNTH-BANK-9' + pad(n, 5), 'MX:SYNTH-BATCH-BANK-ONLY-' + pad(n), day(2 + n), 2500);
  // 4 matched refund batches: negative processor gross, settled by a negative bank debit.
  [23, 28, 135, 146].forEach((n, i) => {
    const amount = -(60000 + i * 9000), payout = 'MX:SYNTH-BATCH-REFUND-' + pad(n);
    proc('MX:SYNTH-PROC-' + pad(n) + '-REFUND', payout, day(5 + i), amount, 0, 'REFUND for SYNTH-ORDER-' + pad(n));
    dep('MX:SYNTH-BANK-1' + pad(n, 5), payout, day(6 + i), amount);
  });
  // 3 matched multi-record batches, including the demo's longest reference shape.
  ['CS:SYNTH-BATCH-USD-2026-01-16-0002', 'CS:SYNTH-BATCH-USD-2026-01-17-0001', 'MX:SYNTH-BATCH-USD-2026-01-09-0004'].forEach((payout, i) => {
    let net = 0;
    for (let k = 0; k < 4; k++) {
      const gross = 2000 + k * 750 + i * 100, fee = 60 + k;
      net += gross - fee;
      proc(payout.slice(0, 3) + 'SYNTH-PROC-' + pad(i * 10 + k + 1) + '-' + k, payout, day(10 + i), gross, fee, 'CAPTURE for SYNTH-ORDER-' + pad(900 + i * 10 + k));
    }
    dep(payout.slice(0, 3) + 'SYNTH-BANK-2' + pad(i, 5), payout, day(11 + i), net);
  });

  return { processor, bank, state: reconcileForFixture(processor, bank) };
}
