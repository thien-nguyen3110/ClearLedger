import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { DEFAULT_RULES, RULE_LIMITS, dollarsToCents, dryRun, normalizeRules } from './rules.js';
import { kindLabels, money, signedMoney } from './model.js';

// Matching-rules dry run. The rules live in this browser only (a per-viewer preference, so
// localStorage, guarded because storage can be blocked); results are recomputed from the
// workspace already on screen and never sent anywhere.
const STORE_KEY = 'clearledger-rules';
// Rows rendered per result table; the counts above each table stay exact.
const SHOW = 200;

function loadRules() {
  try { return normalizeRules(JSON.parse(localStorage.getItem(STORE_KEY))); } catch { return { ...DEFAULT_RULES }; }
}
const toText = r => ({ amount: (r.amountCents / 100).toFixed(2), days: String(r.dateDays), edits: r.maxEdits === null ? 'off' : String(r.maxEdits) });
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const dayText = d => (d === 0 ? 'same day' : plural(Math.abs(d), 'day', 'days') + (d > 0 ? ' after' : ' before'));

function parse(text) {
  const amountCents = dollarsToCents(text.amount);
  const days = /^\d+$/.test(text.days.trim()) ? Number(text.days) : null;
  const errors = {};
  if (amountCents === null || amountCents > RULE_LIMITS.amountCents) errors.amount = 'Enter an amount from 0.00 to ' + money(RULE_LIMITS.amountCents) + '.';
  if (days === null || days > RULE_LIMITS.dateDays) errors.days = 'Enter whole days from 0 to ' + RULE_LIMITS.dateDays + '.';
  return { errors, rules: { amountCents, dateDays: days, maxEdits: text.edits === 'off' ? null : Number(text.edits) } };
}

function Shown({ total }) {
  return total > SHOW ? <p className="muted">Showing the first {SHOW} of {total}, closest first.</p> : null;
}

export function RulesPreview({ cases, records, onOpenCase }) {
  const [text, setText] = useState(() => toText(loadRules()));
  const parsed = parse(text);
  const valid = !Object.keys(parsed.errors).length;
  // The last valid rules keep the results on screen while a field is mid-edit.
  const [applied, setApplied] = useState(() => loadRules());
  useEffect(() => {
    if (!valid) return;
    const next = normalizeRules(parsed.rules);
    setApplied(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* storage blocked: rules last for this visit */ }
  }, [valid, parsed.rules.amountCents, parsed.rules.dateDays, parsed.rules.maxEdits]);
  const rules = useDeferredValue(applied);
  const result = useMemo(() => dryRun(cases, records, rules), [cases, records, rules]);
  const set = key => e => setText(t => ({ ...t, [key]: e.target.value }));
  const open = (c, label) => <button type="button" className="linkbutton" onClick={() => onOpenCase(c.id)} aria-label={'Open ' + c.payout + (label ? ', ' + label : '')}>{c.payout}</button>;

  return <div className="rulesgrid">
    <section className="panel rulespanel" aria-labelledby="rules-heading">
      <h2 id="rules-heading">Rules</h2>
      <p>Each rule widens what counts as a lead. A lead is only shown here, so you can tune the rules before anything relies on them.</p>
      <form onSubmit={e => e.preventDefault()} noValidate>
        <label>Amount tolerance (USD)
          <input inputMode="decimal" value={text.amount} onChange={set('amount')} aria-invalid={!!parsed.errors.amount} aria-describedby="rule-amount-hint" />
          <small id="rule-amount-hint" className={parsed.errors.amount ? 'fielderror' : ''}>{parsed.errors.amount || 'Largest difference between expected and received that still counts as a lead.'}</small>
        </label>
        <label>Date window (days)
          <input inputMode="numeric" value={text.days} onChange={set('days')} aria-invalid={!!parsed.errors.days} aria-describedby="rule-days-hint" />
          <small id="rule-days-hint" className={parsed.errors.days ? 'fielderror' : ''}>{parsed.errors.days || 'Days allowed between the processor record and the bank deposit, either way.'}</small>
        </label>
        <label>Reference similarity
          <select value={text.edits} onChange={set('edits')} aria-describedby="rule-edits-hint">
            <option value="off">Not required</option>
            <option value="0">Identical reference</option>
            <option value="1">Up to 1 character different</option>
            <option value="2">Up to 2 characters different</option>
            <option value="3">Up to 3 characters different</option>
          </select>
          <small id="rule-edits-hint">Sequential references such as PO-1003 and PO-1007 are always close, so similarity alone is weak evidence.</small>
        </label>
        <button type="button" className="secondary" onClick={() => setText(toText(DEFAULT_RULES))}>Reset to defaults</button>
      </form>
      <p className="muted">Rules are saved in this browser only. The approach follows Blnk&rsquo;s open-source reconciliation rules: amount drift, date drift, and reference distance, tried one-to-one and many-to-one.</p>
    </section>

    <section className="panel rulesresults" aria-labelledby="dryrun-heading">
      <div className="panelheading"><h2 id="dryrun-heading">Dry run</h2><span className="muted" aria-live="polite">{result.touched} of {plural(result.openExceptions, 'open payout has', 'open payouts have')} a lead</span></div>
      <p className="banner info">Preview only. Nothing is saved, and the server&rsquo;s match decisions do not change. Check each lead against the records, then record a review on the payout.</p>

      <h3>Within amount tolerance <span className="count">{result.tolerance.length}</span></h3>
      {result.tolerance.length ? <><div className="tablewrap"><table className="reporttable">
        <caption className="visually-hidden">Open amount mismatches whose difference is within the amount tolerance</caption>
        <thead><tr><th scope="col">Payout</th><th scope="col" className="num">Expected</th><th scope="col" className="num">Received</th><th scope="col" className="num">Difference</th></tr></thead>
        <tbody>{result.tolerance.slice(0, SHOW).map(({ case: c }) => <tr key={c.id}>
          <th scope="row">{open(c)}</th><td className="num">{money(c.expected_cents)}</td><td className="num">{money(c.actual_cents)}</td><td className="num">{signedMoney(c.delta_cents)}</td>
        </tr>)}</tbody>
      </table></div><Shown total={result.tolerance.length} /></> : <div className="none">
        <p>No open amount mismatch is within {money(rules.amountCents)}.</p>
        {result.nearest && <p>The smallest open difference is {money(result.nearest.gap)} ({plural(result.nearest.count, 'payout', 'payouts')}).{' '}
          {result.nearest.gap <= RULE_LIMITS.amountCents && <button type="button" className="linkbutton" onClick={() => setText(t => ({ ...t, amount: (result.nearest.gap / 100).toFixed(2) }))}>Use {money(result.nearest.gap)}</button>}</p>}
      </div>}

      <h3>Deposit under another reference <span className="count">{result.pairs.length}</span></h3>
      <p className="muted">An awaiting payout and an unexpected deposit with matching amounts and nearby dates.</p>
      {result.pairs.length ? <><div className="tablewrap"><table className="reporttable">
        <caption className="visually-hidden">Awaiting payouts paired with unexpected deposits that fit the rules</caption>
        <thead><tr><th scope="col">{kindLabels.awaiting_deposit}</th><th scope="col">{kindLabels.unexpected_deposit}</th><th scope="col" className="num">Amount gap</th><th scope="col">Deposit date</th><th scope="col" className="num">Reference edits</th></tr></thead>
        <tbody>{result.pairs.slice(0, SHOW).map(p => <tr key={p.awaiting.id + '|' + p.deposit.id}>
          <th scope="row">{open(p.awaiting, 'awaiting ' + money(p.awaiting.expected_cents))}<small>expects {money(p.awaiting.expected_cents)}</small>{p.ambiguous && <span className="tag">Several candidates</span>}</th>
          <td>{open(p.deposit, 'deposit of ' + money(p.deposit.actual_cents))}<small>received {money(p.deposit.actual_cents)}</small></td>
          <td className="num">{money(p.gap)}</td><td>{dayText(p.days)}</td><td className="num">{p.edits > 9 ? '10+' : p.edits}</td>
        </tr>)}</tbody>
      </table></div><Shown total={result.pairs.length} /></> : <p className="none">No awaiting payout fits an unexpected deposit under these rules.</p>}

      <h3>Two payouts in one deposit <span className="count">{result.combined.length}</span></h3>
      <p className="muted">An unexpected deposit that equals two awaiting payouts added together.</p>
      {result.combinedSkipped ? <p className="banner warn">Skipped: more than 200 payouts are awaiting a deposit, which is too many pairs to check in the browser.</p>
        : result.combined.length ? <><div className="tablewrap"><table className="reporttable">
          <caption className="visually-hidden">Unexpected deposits that equal two awaiting payouts combined</caption>
          <thead><tr><th scope="col">{kindLabels.unexpected_deposit}</th><th scope="col">Awaiting payouts</th><th scope="col" className="num">Amount gap</th><th scope="col" className="num">Furthest date</th></tr></thead>
          <tbody>{result.combined.slice(0, SHOW).map(m => <tr key={m.deposit.id + '|' + m.parts.map(c => c.id).join('+')}>
            <th scope="row">{open(m.deposit)}<small>received {money(m.deposit.actual_cents)}</small></th>
            <td>{m.parts.map((c, i) => <React.Fragment key={c.id}>{i > 0 && ' + '}{open(c)} <small className="inline">{money(c.expected_cents)}</small></React.Fragment>)}</td>
            <td className="num">{money(m.gap)}</td><td className="num">{plural(m.days, 'day', 'days')}</td>
          </tr>)}</tbody>
        </table></div><Shown total={result.combined.length} /></> : <p className="none">No unexpected deposit equals two awaiting payouts under these rules.</p>}
    </section>
  </div>;
}
