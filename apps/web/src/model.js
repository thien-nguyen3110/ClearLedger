// Pure presentation helpers for the ClearLedger UI. Nothing here decides a match: the
// server's case kind, amounts, and fingerprint are authoritative (the frozen /api contract: endpoints, field names, integer cents).
// These functions only explain server state in plain language and compare two snapshots.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = cents => usd.format(cents / 100);
export const signedMoney = cents => (cents > 0 ? '+' : '') + money(cents);

export const kindLabels = {
  matched: 'Matched',
  amount_mismatch: 'Amount mismatch',
  awaiting_deposit: 'Awaiting deposit',
  ambiguous_deposit: 'Multiple deposits',
  unexpected_deposit: 'Unexpected deposit',
};

// Order used by the exception summary: missing money first, then wrong amounts.
export const exceptionKinds = ['awaiting_deposit', 'amount_mismatch', 'ambiguous_deposit', 'unexpected_deposit'];

export const actionLabels = {
  review_fees: 'Review fees and refunds',
  request_statement: 'Request the bank statement',
  check_duplicate: 'Check for duplicate records',
  request_processor_detail: 'Request payout details from the processor',
};

export function statusLabel(c) {
  if (c.status === 'matched') return 'Matched';
  if (c.status === 'reviewed') return 'Reviewed';
  return kindLabels[c.kind] || 'Needs review';
}

// "rules" is the deterministic checklist; "ollama:<model>" is the local model. A configured
// model is not proof that it is running, so the config label says "configured".
export function modeLabel(mode) {
  if (!mode) return '';
  if (mode === 'rules') return 'Checklist (rules)';
  if (mode.startsWith('ollama:')) return 'Local model ' + mode.slice('ollama:'.length);
  return mode;
}
export function configModeLabel(investigator) {
  if (!investigator) return 'Unknown';
  if (investigator === 'rules') return 'Checklist mode';
  if (investigator.startsWith('ollama:')) return 'Local model configured: ' + investigator.slice('ollama:'.length);
  return investigator;
}

// Plain-language reason for the server's classification, using only the server's amounts.
export function explain(c) {
  const exp = money(c.expected_cents), act = money(c.actual_cents), diff = money(Math.abs(c.delta_cents));
  switch (c.kind) {
    case 'matched':
      return 'One bank deposit with reference ' + c.payout + ' equals the processor net of ' + exp + '.';
    case 'amount_mismatch':
      return 'The bank received ' + act + ', but the processor records for ' + c.payout + ' net to ' + exp + '. The bank received ' + diff + (c.delta_cents < 0 ? ' less' : ' more') + ' than expected.';
    case 'awaiting_deposit':
      return 'Processor records expect ' + exp + ', but the imported bank records have no deposit with reference ' + c.payout + '. This is not marked overdue: ClearLedger has no expected settlement date for it.';
    case 'ambiguous_deposit':
      return 'More than one bank deposit uses reference ' + c.payout + ' (together ' + act + ', expected ' + exp + '). ClearLedger does not pick one for you, even when the total matches.';
    case 'unexpected_deposit':
      return 'The bank received ' + act + ' with reference ' + c.payout + ', but no imported processor records use that reference.';
    default:
      return 'This payout needs review.';
  }
}

// General guidance per exception type. Shown as a fixed checklist, never as AI output.
export const checklists = {
  amount_mismatch: [
    'Compare the processor payout report with the fees and refunds listed below.',
    'Look for a chargeback, reserve, or adjustment that the processor file does not include.',
    'Confirm the bank amount on the statement matches the imported bank row.',
  ],
  awaiting_deposit: [
    "Check that the imported bank file covers dates after the processor's payout date.",
    'Look for the deposit under a different reference or combined with another payout.',
    "If it still doesn't appear, ask the processor for the payout's status and trace details.",
  ],
  ambiguous_deposit: [
    'Check whether the processor split this payout into several transfers.',
    'Make sure the same deposit was not imported twice under different IDs.',
    'Decide which deposits belong to this payout before recording a review.',
  ],
  unexpected_deposit: [
    'Check whether the processor file for this period was imported.',
    'Confirm the deposit reference; it may belong to a payout with a different reference.',
    'It may not be a processor payout at all, such as a transfer or refund from another source.',
  ],
};

// Display breakdown of the case's records. The server's expected/actual figures stay
// authoritative; `consistent` flags a disagreement instead of silently preferring either.
export function breakdown(c, records) {
  const rows = c.evidence.map(id => records[id]).filter(Boolean);
  const processor = rows.filter(r => r.source === 'processor');
  const bank = rows.filter(r => r.source === 'bank');
  const sales = processor.filter(r => r.gross_cents >= 0).reduce((s, r) => s + r.gross_cents, 0);
  const refunds = processor.filter(r => r.gross_cents < 0).reduce((s, r) => s + r.gross_cents, 0);
  const fees = processor.reduce((s, r) => s + r.fee_cents, 0);
  const deposits = bank.reduce((s, r) => s + r.gross_cents, 0);
  const missing = c.evidence.length - rows.length;
  return {
    processor, bank, sales, refunds, fees, deposits, missing,
    consistent: missing === 0 && sales + refunds - fees === c.expected_cents && deposits === c.actual_cents,
  };
}

// Audit entries whose detail starts with "<payout>: " (investigation.drafted,
// investigation.failed, case.reviewed). Imports are workspace-wide and are not included.
export function caseHistory(audit, payout) {
  const prefix = payout + ': ';
  return audit.filter(a => a.detail.startsWith(prefix)).map(a => ({ ...a, text: a.detail.slice(prefix.length) }));
}

// The server drops a case's draft and review whenever its evidence fingerprint changes and
// re-opens it (backend reconcile). The audit log still holds the earlier events, so a case
// that is not reviewed now but has a case.reviewed entry was reset by new evidence.
export function resetInfo(c, history) {
  const reviews = history.filter(h => h.action === 'case.reviewed');
  const drafts = history.filter(h => h.action === 'investigation.drafted');
  return {
    reviewReset: c.status !== 'reviewed' && reviews.length > 0 ? reviews[reviews.length - 1] : null,
    draftReset: c.status === 'open' && !c.proposal && drafts.length > 0 ? drafts[drafts.length - 1] : null,
  };
}

// Compare two state snapshots by case id and fingerprint.
export function diffStates(prev, next) {
  if (!prev) return { added: [], changed: [], removed: [], revisionChanged: false };
  const before = new Map(prev.cases.map(c => [c.id, c]));
  const after = new Set(next.cases.map(c => c.id));
  const added = [], changed = [];
  for (const c of next.cases) {
    const old = before.get(c.id);
    if (!old) added.push(c.id);
    else if (old.fingerprint !== c.fingerprint) changed.push(c.id);
  }
  const removed = prev.cases.filter(c => !after.has(c.id)).map(c => c.id);
  return { added, changed, removed, revisionChanged: prev.revision !== next.revision };
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
export function describeDiff(d) {
  const parts = [];
  if (d.added.length) parts.push(plural(d.added.length, 'new payout', 'new payouts'));
  if (d.changed.length) parts.push(plural(d.changed.length, 'payout has new evidence', 'payouts have new evidence'));
  if (d.removed.length) parts.push(plural(d.removed.length, 'payout was removed', 'payouts were removed'));
  return parts.join(', ');
}

// Status-aware, recovery-oriented error copy. The server's message is shown as detail, but
// the UI never depends on its wording (contract: do not depend on exact error messages).
export function describeError(e, op) {
  const status = e && typeof e.status === 'number' ? e.status : -1;
  const server = e?.message || '';
  const t = (title, hint) => ({ title, detail: server && server !== title ? server : '', hint: hint || '', status });
  if (status === 0) {
    return op === 'import'
      ? t("Can't reach the ClearLedger server.", "The import may or may not have been saved. Retrying the same file is safe: it won't create duplicates.")
      : t("Can't reach the ClearLedger server.", 'Check that it is running and your connection is up, then try again.');
  }
  if (status === 408) return { title: server || 'The request timed out.', detail: '', hint: '', status };
  if (status === 400) {
    if (op === 'import') return t('The server rejected this file. Nothing was imported.', 'Fix the rows it mentions and import the file again.');
    if (op === 'review') return t("The review note wasn't accepted.", 'Notes need 10 to 1,000 characters.');
    return t("The request wasn't accepted.");
  }
  if (status === 401) return t('Enter the workspace access token to continue.');
  if (status === 403) return t('The server blocked this request.', 'Open ClearLedger from the address the server is configured to serve.');
  if (status === 404) return t('That payout is no longer in this workspace.', 'The workspace has been refreshed.');
  if (status === 409) {
    if (op === 'import') return t('This file conflicts with records already imported. Nothing was imported.', 'A record ID already exists with different contents. Check the file, or use new IDs for new records.');
    return t('This payout changed on the server.', 'The workspace has been refreshed.');
  }
  if (status === 413) return t('This file is over the 2 MB request limit.', 'Split it into smaller files and import each one.');
  if (status === 429) return t('Too many requests right now.', 'Wait a moment, then try again.');
  if (status === 502 && op === 'investigate') return t('The investigation could not finish. No draft was created.', 'You can try again, or review the evidence without a draft.');
  if (status === 503) return t('A required service is temporarily unavailable.', 'Try again shortly.');
  if (status >= 500) {
    return op === 'import'
      ? t('The server hit an error during the import.', "It may or may not have been saved. Retrying the same file is safe: it won't create duplicates.")
      : t('The server hit an error.', 'Try again. If it keeps happening, check the server logs.');
  }
  return t(server || 'Something went wrong.');
}

// Spreadsheet-safe CSV cell. Text that starts with a formula trigger is prefixed with an
// apostrophe so a spreadsheet shows it as text (CSV injection). Numbers, including signed
// decimal strings such as "-5.00", are left as numbers.
export function csvCell(v) {
  if (typeof v === 'number') return String(v);
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replaceAll('"', '""') + '"' : t;
}

export const activityLabels = {
  'import.completed': 'Import completed',
  'investigation.drafted': 'Draft suggestion prepared',
  'investigation.failed': 'Investigation failed',
  'case.reviewed': 'Review recorded',
};
export function activityLabel(action) {
  return activityLabels[action] || action.replaceAll('.', ' ').replaceAll('_', ' ');
}
export function activityGroup(action) {
  if (action.startsWith('import')) return 'imports';
  if (action === 'investigation.failed') return 'failures';
  if (action.startsWith('investigation')) return 'drafts';
  if (action.startsWith('case')) return 'reviews';
  return 'other';
}

// Audit timestamps are UTC RFC 3339; show them in local time with a spelled-out month so
// 7/1 vs 1/7 cannot be misread.
export const when = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Reconciliation bridge: bank received = processor net expected + the sum of every case's
// delta (actual minus expected). Grouping the deltas by kind explains the whole gap with the
// server's own numbers; nothing is estimated.
export function bridge(cases) {
  const rows = exceptionKinds.map(kind => ({ kind, cases: 0, open: 0, delta: 0 }));
  const byKind = Object.fromEntries(rows.map(r => [r.kind, r]));
  let expected = 0, received = 0;
  for (const c of cases) {
    expected += c.expected_cents;
    received += c.actual_cents;
    const row = byKind[c.kind];
    if (!row) continue;
    row.cases++;
    if (c.status === 'open') row.open++;
    row.delta += c.delta_cents;
  }
  return { expected, received, gap: received - expected, rows };
}

// Month-end progress: exceptions (everything that is not an exact match) that a reviewer
// has explained with a recorded review.
export function closeProgress(cases) {
  const exceptions = cases.filter(c => c.kind !== 'matched');
  const explained = exceptions.filter(c => c.status === 'reviewed').length;
  return { exceptions: exceptions.length, explained, open: exceptions.length - explained, pct: exceptions.length ? Math.floor(explained * 100 / exceptions.length) : 100 };
}

// "As of" is the newest record date in the workspace, not today's date: ages are measured
// inside the imported data, so a file imported late does not make everything look old.
export function asOfDate(records) {
  let max = '';
  for (const id in records) if (records[id].date > max) max = records[id].date;
  return max || null;
}
export function daysBetween(from, to) {
  if (!from || !to) return null;
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}
export function lastDate(c, records, source) {
  let max = '';
  for (const id of c.evidence) { const r = records[id]; if (r && r.source === source && r.date > max) max = r.date; }
  return max || null;
}

// A search that looks like an amount ("2.00", "$1,862.63", "-5") also matches payouts whose
// expected, received, or absolute difference equals it exactly.
export function amountQuery(q) {
  const t = q.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.replace('-', '').split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

// Arithmetic clues from the case's own records and the workspace. Each clue is an exact
// equality or date fact, labeled as a clue; none is a conclusion or an AI suggestion.
export function clues(c, records, cases) {
  const out = [];
  const rows = c.evidence.map(id => records[id]).filter(Boolean);
  const processor = rows.filter(r => r.source === 'processor');
  const bank = rows.filter(r => r.source === 'bank');
  const gap = Math.abs(c.delta_cents);
  if (c.kind === 'amount_mismatch' && gap) {
    for (const r of processor) {
      if (r.fee_cents === gap) out.push({ text: 'The difference equals the fee on ' + r.id + ' (' + money(r.fee_cents) + ').', record: r.id });
      else if (r.gross_cents < 0 && -r.gross_cents === gap) out.push({ text: 'The difference equals the refund ' + r.id + ' (' + money(r.gross_cents) + ').', record: r.id });
      else if (r.gross_cents - r.fee_cents === gap) out.push({ text: 'The difference equals the net of ' + r.id + ' alone (' + money(gap) + '). That record may be missing from the deposit.', record: r.id });
    }
  }
  if (c.kind === 'ambiguous_deposit' && bank.length > 1) {
    const amounts = new Set(bank.map(r => r.gross_cents));
    if (amounts.size < bank.length) out.push({ text: 'Two or more deposits have the same amount, which can mean the same deposit was exported twice.' });
    if (c.actual_cents === c.expected_cents) out.push({ text: 'Together the deposits equal the expected net exactly, which can mean the processor split the payout.' });
    else if (bank.some(r => r.gross_cents === c.expected_cents)) out.push({ text: 'One of the deposits equals the expected net exactly.' });
  }
  if (c.kind === 'unexpected_deposit') {
    const twin = cases.find(o => o.kind === 'awaiting_deposit' && o.status === 'open' && o.expected_cents === c.actual_cents);
    if (twin) out.push({ text: 'An awaiting payout, ' + twin.payout + ', expects exactly ' + money(c.actual_cents) + '. The deposit may carry a different reference.', caseId: twin.id });
  }
  if (c.kind === 'awaiting_deposit') {
    const twin = cases.find(o => o.kind === 'unexpected_deposit' && o.status === 'open' && o.actual_cents === c.expected_cents);
    if (twin) out.push({ text: 'An unexpected deposit, ' + twin.payout + ', is exactly ' + money(c.expected_cents) + '. It may be this payout under a different reference.', caseId: twin.id });
  }
  return out;
}
