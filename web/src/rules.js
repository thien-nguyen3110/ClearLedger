// Dry-run matching rules, after Blnk's reconciliation rules: an allowed amount drift, an
// allowed date drift, and an optional reference edit distance, tried one-to-one (an awaiting
// payout against an unexpected deposit) and many-to-one (two awaiting payouts against one
// combined deposit). Read-only: the server's case kinds stay authoritative and nothing here
// is saved. Every result is a lead for a reviewer to check, never a match.
import { daysBetween, lastDate } from './model.js';

export const DEFAULT_RULES = Object.freeze({ amountCents: 100, dateDays: 3, maxEdits: null });
export const RULE_LIMITS = Object.freeze({ amountCents: 100000, dateDays: 31, maxEdits: 3 });
// Pairs of awaiting payouts grow quadratically, so the many-to-one pass only runs while the
// open awaiting set is small enough to stay instant on every keystroke.
export const COMBINE_LIMIT = 200;

const clampInt = (v, lo, hi, fallback) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

// Accepts anything (stored settings can be stale or hand-edited) and returns valid rules.
export function normalizeRules(r) {
  const x = r && typeof r === 'object' ? r : {};
  return {
    amountCents: clampInt(x.amountCents, 0, RULE_LIMITS.amountCents, DEFAULT_RULES.amountCents),
    dateDays: clampInt(x.dateDays, 0, RULE_LIMITS.dateDays, DEFAULT_RULES.dateDays),
    maxEdits: x.maxEdits === null ? null : clampInt(x.maxEdits, 0, RULE_LIMITS.maxEdits, DEFAULT_RULES.maxEdits),
  };
}

// "1.5", "$1,000.25", "0" -> integer cents. Parsed as text so no float rounding can creep in.
export function dollarsToCents(text) {
  const t = String(text ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

// Levenshtein distance between two references, giving up once it exceeds `cap` (returns
// cap + 1) so long free-text references cost no more than short ones.
export function editDistance(a, b, cap = Infinity) {
  const s = String(a).toLowerCase(), t = String(b).toLowerCase();
  if (Math.abs(s.length - t.length) > cap) return cap + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return Math.min(prev[t.length], cap + 1);
}

export function dryRun(cases, records, rules) {
  const r = normalizeRules(rules);
  const open = cases.filter(c => c.status === 'open' && c.kind !== 'matched');

  const tolerance = open
    .filter(c => c.kind === 'amount_mismatch' && Math.abs(c.delta_cents) <= r.amountCents)
    .map(c => ({ case: c, gap: Math.abs(c.delta_cents) }))
    .sort((a, b) => a.gap - b.gap);

  // The smallest open mismatch the current tolerance misses, so the reviewer can see how far
  // the rule is from the data instead of guessing a number.
  let nearest = null;
  for (const c of open) {
    const gap = Math.abs(c.delta_cents);
    if (c.kind !== 'amount_mismatch' || gap <= r.amountCents) continue;
    if (!nearest || gap < nearest.gap) nearest = { gap, count: 1 };
    else if (gap === nearest.gap) nearest.count++;
  }

  // A side without a dated record cannot satisfy a date rule, so it is left out.
  const awaiting = open.filter(c => c.kind === 'awaiting_deposit').map(c => ({ c, date: lastDate(c, records, 'processor') })).filter(a => a.date);
  const deposits = open.filter(c => c.kind === 'unexpected_deposit').map(c => ({ c, date: lastDate(c, records, 'bank') })).filter(d => d.date);
  const withinDays = (from, to) => { const d = daysBetween(from, to); return d !== null && Math.abs(d) <= r.dateDays ? d : null; };

  const pairs = [];
  for (const a of awaiting) {
    for (const d of deposits) {
      const gap = Math.abs(d.c.actual_cents - a.c.expected_cents);
      if (gap > r.amountCents) continue;
      const days = withinDays(a.date, d.date);
      if (days === null) continue;
      const edits = editDistance(a.c.payout, d.c.payout, 9);
      if (r.maxEdits !== null && edits > r.maxEdits) continue;
      pairs.push({ awaiting: a.c, deposit: d.c, gap, days, edits });
    }
  }
  // ClearLedger never picks between candidates, so a payout or deposit that fits more than
  // one partner is flagged instead of resolved.
  const seen = new Map();
  for (const p of pairs) for (const id of [p.awaiting.id, p.deposit.id]) seen.set(id, (seen.get(id) || 0) + 1);
  for (const p of pairs) p.ambiguous = seen.get(p.awaiting.id) > 1 || seen.get(p.deposit.id) > 1;
  pairs.sort((x, y) => x.gap - y.gap || Math.abs(x.days) - Math.abs(y.days) || x.edits - y.edits);

  const combined = [];
  const combinedSkipped = awaiting.length > COMBINE_LIMIT;
  if (!combinedSkipped) {
    for (const d of deposits) {
      for (let i = 0; i < awaiting.length; i++) {
        const di = withinDays(awaiting[i].date, d.date);
        if (di === null) continue;
        for (let j = i + 1; j < awaiting.length; j++) {
          const gap = Math.abs(d.c.actual_cents - awaiting[i].c.expected_cents - awaiting[j].c.expected_cents);
          if (gap > r.amountCents) continue;
          const dj = withinDays(awaiting[j].date, d.date);
          if (dj === null) continue;
          combined.push({ deposit: d.c, parts: [awaiting[i].c, awaiting[j].c], gap, days: Math.max(Math.abs(di), Math.abs(dj)) });
        }
      }
    }
    combined.sort((x, y) => x.gap - y.gap || x.days - y.days);
  }

  const touched = new Set([
    ...tolerance.map(t => t.case.id),
    ...pairs.flatMap(p => [p.awaiting.id, p.deposit.id]),
    ...combined.flatMap(m => [m.deposit.id, ...m.parts.map(c => c.id)]),
  ]);
  return {
    rules: r,
    tolerance,
    nearest,
    pairs,
    combined,
    combinedSkipped,
    openExceptions: open.length,
    touched: touched.size,
  };
}
