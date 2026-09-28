import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, createClient, idempotencyKeyFor, withTimeout } from './api.js';
import { previewCSV } from './csv.js';
import { Icon } from './Icon.jsx';
import { Logo } from './Logo.jsx';
import { CaseDetail } from './CaseDetail.jsx';
import {
  activityGroup, activityLabel, amountQuery, asOfDate, bridge, closeProgress, configModeLabel, csvCell,
  daysBetween, describeDiff, describeError, diffStates, exceptionKinds, kindLabels, lastDate, money,
  signedMoney, statusLabel, when,
} from './model.js';

// Overridable only by browser tests (window.__CL_INVESTIGATE_TIMEOUT_MS__ is never set in
// production) so the timeout path can be exercised without a real 45-second wait.
const INVESTIGATE_TIMEOUT_MS = (typeof window !== 'undefined' && window.__CL_INVESTIGATE_TIMEOUT_MS__) || 45000;
// A background check runs when the tab regains focus, at most this often. No polling.
const FOCUS_REFRESH_MIN_MS = 10000;
// Rows rendered before "Show all"; keeps a 10,000-record workspace responsive.
const ROW_LIMIT = 1000;
// The server caps one JSON request at 2 MiB; the CSV travels inside that JSON body.
const REQUEST_LIMIT_BYTES = 2 * 1024 * 1024;
// Command transcript kept in memory for this tab only.
const LOG_LIMIT = 60;

const clock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
// Block-character meter: the terminal's own way of drawing a proportion.
const meter = (pct, width = 20) => { const full = Math.round(pct / 100 * width); return '█'.repeat(full) + '░'.repeat(width - full); };

const VIEWS = [
  ['Reconciliation', 'grid', 'reconcile'],
  ['Imports', 'upload', 'imports'],
  ['Activity', 'clock', 'activity'],
  ['Close report', 'report', 'report'],
];
const KIND_WORDS = { awaiting: 'awaiting_deposit', mismatch: 'amount_mismatch', multiple: 'ambiguous_deposit', unexpected: 'unexpected_deposit' };
const SORT_WORDS = { expected: 'expected_cents', received: 'actual_cents', difference: 'delta_cents', diff: 'delta_cents' };

function App() {
  const [data, setData] = useState(null);
  const [config, setConfig] = useState(null);
  const [view, setView] = useState('Reconciliation');
  const caseFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('case');
  const [selected, setSelected] = useState(caseFromHash);
  const [filter, setFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState(null);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState('');
  const [investigatingId, setInvestigatingId] = useState(null);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState(() => { try { return sessionStorage.getItem('clearledger-token') || ''; } catch { return ''; } });
  const [needsToken, setNeedsToken] = useState(false);
  const [note, setNote] = useState('');
  const [noteFp, setNoteFp] = useState(null);
  const [updatedIds, setUpdatedIds] = useState(() => new Set());
  const [checked, setChecked] = useState(null);
  const [source, setSource] = useState('processor');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [activityFilter, setActivityFilter] = useState('all');
  const [picked, setPicked] = useState(() => new Set());
  const [bulkNote, setBulkNote] = useState('');
  const [log, setLog] = useState([]);
  const [command, setCommand] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const detailHeadingRef = useRef(null);
  const searchRef = useRef(null);
  const commandRef = useRef(null);
  const logRef = useRef(null);
  const logSeq = useRef(0);
  const dataRef = useRef(null);
  const seqRef = useRef(0);
  const selectedRef = useRef(selected);
  const busyRef = useRef('');
  selectedRef.current = selected;
  busyRef.current = busy || (investigatingId ? 'investigate' : '');

  const api = createClient({
    getToken: () => token,
    onUnauthorized: () => {
      // Hide everything loaded with the rejected token and forget it.
      setNeedsToken(true); setData(null); dataRef.current = null;
      try { sessionStorage.removeItem('clearledger-token'); } catch { /* storage blocked */ }
    },
  });

  // Fetches state and config. Responses that arrive after a newer refresh started are
  // ignored, so a slow background check cannot overwrite a fresher result.
  async function refresh() {
    const seq = ++seqRef.current;
    const [state, cfg] = await Promise.all([api('state'), api('config')]);
    const prev = dataRef.current;
    const diff = diffStates(prev, state);
    if (seq !== seqRef.current) return { state, diff, prev, superseded: true };
    dataRef.current = state;
    setData(state);
    setConfig(cfg);
    setNeedsToken(false);
    setChecked({ at: new Date(), failed: false });
    const touched = [...diff.added, ...diff.changed];
    if (prev && touched.length) setUpdatedIds(s => new Set([...s, ...touched]));
    setSelected(old => (old && state.cases.some(c => c.id === old)) ? old : (state.cases.find(c => c.status === 'open')?.id || state.cases[0]?.id || null));
    // A bulk selection only ever holds payouts that are still open.
    setPicked(p => { const open = new Set(state.cases.filter(c => c.status === 'open').map(c => c.id)); const n = new Set([...p].filter(id => open.has(id))); return n.size === p.size ? p : n; });
    return { state, diff, prev, superseded: false };
  }

  function fail(e, op, retry, subject) {
    if (e instanceof ApiError && e.status === 401) { setProblem({ ...describeError(e, op) }); return; }
    setProblem({ ...describeError(e, op), retry, subject });
  }

  function load() {
    setProblem(null);
    refresh().catch(e => fail(e, 'load', load));
  }
  useEffect(load, []);

  // Stale-result guard without polling: check again when the user comes back to the tab.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== 'visible' || !dataRef.current || busyRef.current) return;
      if (checked && Date.now() - checked.at.getTime() < FOCUS_REFRESH_MIN_MS) return;
      refresh().then(r => {
        if (!r.superseded && r.diff.revisionChanged) {
          const what = describeDiff(r.diff);
          setNotice('The workspace changed while you were away' + (what ? ': ' + what : '') + '. You are seeing the current records.');
        }
      }).catch(() => setChecked(c => ({ at: c?.at || new Date(), failed: true })));
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => { document.removeEventListener('visibilitychange', onReturn); window.removeEventListener('focus', onReturn); };
  }, [checked, token]);

  // Case permalink (#case=<id>): bookmarkable within one browser, no server routing.
  useEffect(() => {
    if (!data) return;
    const target = selected ? '#case=' + encodeURIComponent(selected) : window.location.pathname + window.location.search;
    if (window.location.hash !== (selected ? target : '')) window.history.replaceState(null, '', target);
  }, [selected, data]);
  useEffect(() => {
    const onHash = () => { const id = caseFromHash(); if (id && data?.cases.some(c => c.id === id)) { setView('Reconciliation'); selectCase(id); } };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [data]);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    let cancelled = false;
    file.text().then(text => { if (!cancelled) setPreview(previewCSV(source, text)); }).catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [file, source]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  async function run(name, op, fn) {
    setBusy(name); setProblem(null); setNotice('');
    try { await fn(); }
    catch (e) { fail(e, op); }
    finally { setBusy(''); }
  }

  function selectCase(id, { focus = true } = {}) {
    // A payout keeps its "new evidence" marker while it is open (so the detail can say so)
    // and loses it once the reviewer moves on to another payout.
    const leaving = selectedRef.current;
    setSelected(id);
    setNote(''); setNoteFp(null);
    if (leaving !== id) setUpdatedIds(s => { if (!s.has(leaving)) return s; const n = new Set(s); n.delete(leaving); return n; });
    if (focus) requestAnimationFrame(() => detailHeadingRef.current?.focus());
  }

  const cases = data?.cases || [];
  const active = cases.find(c => c.id === selected);

  // Remember which evidence version the reviewer was reading when they started the note.
  function changeNote(text) {
    setNote(text);
    if (!text.trim()) setNoteFp(null);
    else if (!noteFp && active) setNoteFp(active.fingerprint);
  }
  const noteStale = !!(active && note.trim() && noteFp && noteFp !== active.fingerprint);

  async function investigate(caseId) {
    if (investigatingId) return;
    const payout = cases.find(c => c.id === caseId)?.payout || 'this payout';
    setInvestigatingId(caseId); setProblem(null); setNotice('');
    try {
      await withTimeout(
        signal => api('cases/' + caseId + '/investigate', { method: 'POST', signal }),
        null, INVESTIGATE_TIMEOUT_MS,
        'Investigation timed out. The server may still be working; it is safe to try again.',
      );
      await refresh();
      setNotice(selectedRef.current === caseId
        ? 'Draft suggestion ready for ' + payout + '. Check it against the records before deciding.'
        : 'Draft suggestion ready for ' + payout + '. Open that payout to read it.');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        await refresh().catch(() => {});
        setProblem({ title: payout + ' changed before the investigation finished.', detail: '', hint: 'The workspace has been refreshed. Run it again if the payout still needs review.', subject: null });
      } else {
        fail(e, 'investigate', () => investigate(caseId), payout);
      }
    } finally {
      setInvestigatingId(null);
    }
  }

  async function submitReview(text = note) {
    if (!active) return;
    const caseId = active.id, payout = active.payout;
    setBusy('review'); setProblem(null); setNotice('');
    try {
      await api('cases/' + caseId + '/review', { method: 'POST', body: JSON.stringify({ fingerprint: (text === note && noteFp) || active.fingerprint, note: text }) });
      setNote(''); setNoteFp(null);
      const { state } = await refresh();
      // Move the reviewer to the next open case in table order (wrapping to the first),
      // so a review queue can be worked without returning to the table after every note.
      const at = state.cases.findIndex(c => c.id === caseId);
      const next = state.cases.slice(at + 1).find(c => c.status === 'open') || state.cases.find(c => c.status === 'open');
      const recorded = 'Review recorded for ' + payout + '. Source amounts remain available in the evidence package.';
      if (next) { selectCase(next.id); setNotice(recorded + ' Moved to the next open case, ' + next.payout + '.'); }
      else setNotice(recorded + ' No cases currently need review.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await refresh().catch(() => {});
        setProblem({ title: "This case's evidence changed since you loaded it.", detail: '', hint: 'Your note is kept. Review the refreshed evidence, confirm it, then submit again.' });
      } else {
        fail(e, 'review', null, payout);
      }
    } finally {
      setBusy('');
    }
  }

  // Bulk review: one note, one POST per payout, each with the fingerprint the reviewer was
  // looking at, so every payout still gets its own review record and stale ones are refused.
  async function bulkReview() {
    const ids = [...picked];
    const text = bulkNote.trim();
    if (!ids.length || text.length < 10) return;
    setBusy('bulk'); setProblem(null); setNotice('');
    const done = [], changed = [];
    let failure = null;
    for (const id of ids) {
      const c = dataRef.current?.cases.find(x => x.id === id);
      if (!c || c.status !== 'open') { changed.push(c?.payout || id); continue; }
      try {
        await api('cases/' + id + '/review', { method: 'POST', body: JSON.stringify({ fingerprint: c.fingerprint, note: text }) });
        done.push(id);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 404)) changed.push(c.payout);
        else { failure = { e, payout: c.payout }; break; }
      }
    }
    await refresh().catch(() => {});
    setPicked(p => new Set([...p].filter(id => !done.includes(id))));
    if (done.length) setBulkNote('');
    if (failure) fail(failure.e, 'review', null, failure.payout);
    setNotice('Recorded this note as a review on ' + plural(done.length, 'payout', 'payouts') + '.'
      + (changed.length ? ' Skipped ' + plural(changed.length, 'payout', 'payouts') + ' whose records changed or that were no longer open: ' + changed.join(', ') + '.' : '')
      + (failure ? ' Stopped at ' + failure.payout + '; the rest stay selected.' : ''));
    setBusy('');
  }

  async function submitImport() {
    setBusy('import'); setProblem(null); setNotice('');
    try {
      const csv = await file.text();
      const key = await idempotencyKeyFor(source, csv);
      await api('import', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ source, csv }) });
      const { diff } = await refresh();
      const what = describeDiff(diff);
      setNotice(diff.revisionChanged
        ? 'Import complete. Reconciliation updated' + (what ? ': ' + what + '.' : '.')
        : 'Import complete. Reconciliation updated: no new records, everything in this file was already imported.');
      setFile(null); setPreview(null);
      setView('Reconciliation');
    } catch (e) {
      // Retrying the same file reuses the same content-derived idempotency key.
      fail(e, 'import', e instanceof ApiError && (e.status === 0 || e.status >= 500) ? submitImport : null);
    } finally {
      setBusy('');
    }
  }

  function saveBlob(content, type, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }

  async function download() {
    await run('export', 'export', async () => {
      const value = await api('export');
      saveBlob(JSON.stringify(value, null, 2), 'application/json', 'clearledger-evidence.json');
      setNotice('Evidence package downloaded.');
    });
  }

  async function downloadSummary() {
    await run('summary', 'export', async () => {
      // Derived from the cases already on screen, in server order. Cents stay integers;
      // the *_usd columns are a convenience for spreadsheets, not a second source of truth.
      const header = ['payout', 'status', 'kind', 'expected_cents', 'actual_cents', 'delta_cents', 'expected_usd', 'actual_usd', 'delta_usd', 'source_records'];
      const rows = cases.map(c => [c.payout, c.status, c.kind, c.expected_cents, c.actual_cents, c.delta_cents, (c.expected_cents / 100).toFixed(2), (c.actual_cents / 100).toFixed(2), (c.delta_cents / 100).toFixed(2), c.evidence.length]);
      saveBlob([header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'text/csv', 'clearledger-payout-summary.csv');
      setNotice('CSV summary downloaded. It is a derived view of revision ' + data.revision + '; the JSON evidence export remains the source of record.');
    });
  }

  async function checkNow() {
    await run('refresh', 'load', async () => {
      const r = await refresh();
      const what = describeDiff(r.diff);
      setNotice(r.diff.revisionChanged ? 'Workspace updated' + (what ? ': ' + what : '') + '.' : 'No changes. You are seeing the current records.');
    });
  }

  function printView(kind) {
    document.body.dataset.print = kind;
    window.print();
    delete document.body.dataset.print;
  }

  // Payouts that the audit log shows were reviewed at some point. An open case among them
  // was reopened by new evidence (see resetInfo in model.js).
  const everReviewed = useMemo(() => {
    const prefixes = new Set();
    for (const a of data?.audit || []) {
      if (a.action !== 'case.reviewed') continue;
      for (let i = a.detail.indexOf(': '); i !== -1; i = a.detail.indexOf(': ', i + 1)) prefixes.add(a.detail.slice(0, i));
    }
    return prefixes;
  }, [data]);

  const summary = useMemo(() => {
    const by = {};
    for (const k of Object.keys(kindLabels)) by[k] = { total: 0, open: 0, amount: 0 };
    for (const c of cases) {
      const s = by[c.kind] || (by[c.kind] = { total: 0, open: 0, amount: 0 });
      s.total++;
      if (c.status === 'open') s.open++;
      s.amount += c.kind === 'unexpected_deposit' ? c.actual_cents : c.kind === 'awaiting_deposit' ? c.expected_cents : c.delta_cents;
    }
    return {
      by,
      expected: cases.reduce((s, c) => s + c.expected_cents, 0),
      received: cases.reduce((s, c) => s + c.actual_cents, 0),
      open: cases.filter(c => c.status === 'open').length,
      matched: cases.filter(c => c.status === 'matched').length,
      reviewed: cases.filter(c => c.status === 'reviewed').length,
    };
  }, [data]);
  const flow = useMemo(() => bridge(cases), [data]);
  const progress = useMemo(() => closeProgress(cases), [data]);
  const asOf = useMemo(() => (data ? asOfDate(data.records) : null), [data]);
  const firstDate = useMemo(() => { let min = ''; for (const id in data?.records || {}) { const d = data.records[id].date; if (!min || d < min) min = d; } return min || null; }, [data]);
  const ageOf = c => (c.kind === 'awaiting_deposit' && data ? daysBetween(lastDate(c, data.records, 'processor'), asOf) : null);

  const q = deferredSearch.trim().toLowerCase();
  const qAmount = amountQuery(q);
  const matchesQuery = c => !q || c.payout.toLowerCase().includes(q)
    || c.evidence.some(id => id.toLowerCase().includes(q) || (data.records[id]?.description || '').toLowerCase().includes(q))
    || (qAmount !== null && (c.expected_cents === qAmount || c.actual_cents === qAmount || Math.abs(c.delta_cents) === qAmount));
  const visible = useMemo(() => {
    const filtered = cases.filter(c => (filter === 'all' || c.status === filter) && (!kindFilter || c.kind === kindFilter) && matchesQuery(c));
    // Client-side sort of already-fetched cases; the server order is kept when no column is chosen.
    return sort.key ? [...filtered].sort((a, b) => (a[sort.key] - b[sort.key]) * (sort.dir === 'asc' ? 1 : -1)) : filtered;
  }, [data, filter, kindFilter, q, sort]);
  const rows = showAll ? visible : visible.slice(0, ROW_LIMIT);
  const openVisible = visible.filter(c => c.status === 'open');
  const allOpenPicked = openVisible.length > 0 && openVisible.every(c => picked.has(c.id));

  function toggleSort(key) {
    setSort(s => s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : { key: null, dir: 'asc' });
  }
  function togglePick(id) { setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function pickAllOpen(on) { setPicked(p => { const n = new Set(p); for (const c of openVisible) { if (on) n.add(c.id); else n.delete(c.id); } return n; }); }
  const sortColumns = [['expected_cents', 'Expected net'], ['actual_cents', 'Bank received'], ['delta_cents', 'Difference']];
  const sortState = key => sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const loading = !needsToken && !data && !problem;
  const filtersActive = filter !== 'all' || kindFilter || q;

  const activity = data ? [...data.audit].reverse() : [];
  const activityCounts = activity.reduce((m, a) => { const g = activityGroup(a.action); m[g] = (m[g] || 0) + 1; return m; }, {});
  const payoutOf = detail => { const c = cases.find(x => detail.startsWith(x.payout + ': ')); return c || null; };

  // ---- Command line and keyboard ----------------------------------------------------------
  function print(text, kind = 'out') { setLog(l => [...l.slice(-(LOG_LIMIT - 1)), { id: ++logSeq.current, text, kind }]); }
  function move(step) {
    if (!visible.length) return print('No payouts in the current view.', 'err');
    const at = visible.findIndex(c => c.id === selected);
    const next = visible[Math.min(visible.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
    setView('Reconciliation');
    selectCase(next.id);
  }
  function findCase(text) {
    const t = text.trim().toLowerCase();
    if (!t) return { error: 'Name a payout, for example: open ' + (cases[0]?.payout || 'PO-1002') };
    const exact = cases.find(c => c.payout.toLowerCase() === t);
    if (exact) return { hit: exact };
    const some = cases.filter(c => c.payout.toLowerCase().includes(t));
    if (some.length === 1) return { hit: some[0] };
    return { error: some.length ? plural(some.length, 'payout matches', 'payouts match') + ' "' + text + '". Type more of the reference.' : 'No payout matches "' + text + '".' };
  }
  function runCommand(raw) {
    const line = raw.trim();
    if (!line) return;
    print(line, 'cmd');
    const [word, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    const w = word.toLowerCase();
    if (!data && !['help', 'clear'].includes(w)) return print('Connect to a workspace first.', 'err');
    switch (w) {
      case 'help': setHelpOpen(true); print('Commands: open, next, prev, filter, type, find, sort, investigate, review, select, go, refresh, csv, export, clear. The full list is open above.'); break;
      case 'open': { const r = findCase(arg); if (r.error) print(r.error, 'err'); else { setView('Reconciliation'); selectCase(r.hit.id); print(r.hit.payout + ' · ' + statusLabel(r.hit) + ' · difference ' + signedMoney(r.hit.delta_cents)); } break; }
      case 'next': case 'prev': move(w === 'next' ? 1 : -1); break;
      case 'filter': {
        const map = { all: 'all', open: 'open', review: 'open', matched: 'matched', reviewed: 'reviewed' };
        if (!map[arg.toLowerCase()]) { print('Use: filter all | open | matched | reviewed', 'err'); break; }
        setView('Reconciliation'); setFilter(map[arg.toLowerCase()]); print('Showing ' + arg.toLowerCase() + ' payouts.'); break;
      }
      case 'type': {
        const a = arg.toLowerCase();
        if (a === 'all') { setKindFilter(null); print('Showing every type.'); break; }
        if (!KIND_WORDS[a]) { print('Use: type awaiting | mismatch | multiple | unexpected | all', 'err'); break; }
        setView('Reconciliation'); setKindFilter(KIND_WORDS[a]); print('Showing ' + kindLabels[KIND_WORDS[a]].toLowerCase() + ' only.'); break;
      }
      case 'find': {
        setView('Reconciliation'); setSearch(arg);
        const lq = arg.trim().toLowerCase(), la = amountQuery(lq);
        const n = cases.filter(c => !lq || c.payout.toLowerCase().includes(lq) || c.evidence.some(id => id.toLowerCase().includes(lq) || (data.records[id]?.description || '').toLowerCase().includes(lq)) || (la !== null && (c.expected_cents === la || c.actual_cents === la || Math.abs(c.delta_cents) === la))).length;
        print(arg ? plural(n, 'payout matches', 'payouts match') + ' "' + arg + '"' + (la !== null ? ' (as text or as the amount ' + money(la) + ')' : '') + '.' : 'Search cleared.'); break;
      }
      case 'sort': {
        const [col, dir = 'asc'] = arg.toLowerCase().split(/\s+/);
        if (col === 'none') { setSort({ key: null, dir: 'asc' }); print('Server order restored.'); break; }
        if (!SORT_WORDS[col] || !['asc', 'desc'].includes(dir)) { print('Use: sort expected | received | difference | none [asc | desc]', 'err'); break; }
        setSort({ key: SORT_WORDS[col], dir }); print('Sorted by ' + col + ', ' + (dir === 'asc' ? 'ascending' : 'descending') + '.'); break;
      }
      case 'investigate':
        if (!active) print('Open a payout first.', 'err');
        else if (active.status !== 'open') print(active.payout + ' does not need review.', 'err');
        else if (investigatingId) print('Another investigation is running.', 'err');
        else { print('Investigating ' + active.payout + '. This can take up to 45 seconds with a local model.'); investigate(active.id); }
        break;
      case 'review':
        if (!active || active.status !== 'open') print('Open a payout that needs review first.', 'err');
        else if (arg.trim().length < 10 || arg.length > 1000) print('A review note needs 10 to 1,000 characters.', 'err');
        else if (noteStale) print("This payout's records changed after you started a note. Confirm them in the panel first.", 'err');
        else { print('Recording review for ' + active.payout + '.'); submitReview(arg.trim()); }
        break;
      case 'select':
        if (arg === 'open') { pickAllOpen(true); print(plural(openVisible.length, 'open payout', 'open payouts') + ' selected for a bulk review.'); }
        else if (arg === 'none') { setPicked(new Set()); print('Selection cleared.'); }
        else print('Use: select open | none', 'err');
        break;
      case 'go': {
        const target = VIEWS.find(([name, , slug]) => slug === arg.toLowerCase() || name.toLowerCase() === arg.toLowerCase());
        if (!target) print('Use: go reconcile | imports | activity | report', 'err'); else { setView(target[0]); print('Opened ' + target[0] + '.'); }
        break;
      }
      case 'refresh': print('Checking for updates.'); checkNow(); break;
      case 'csv': print('Preparing the CSV summary.'); downloadSummary(); break;
      case 'export': print('Preparing the evidence package.'); download(); break;
      case 'clear': setLog([]); break;
      default: print('Unknown command "' + word + '". Type help for the list.', 'err');
    }
  }

  // Single-key shortcuts, ignored while typing in a field. Latest handlers live in a ref so
  // the listener is bound once.
  const keys = useRef({});
  keys.current = { move, active, visible, investigate, togglePick, investigatingId, view };
  useEffect(() => {
    const onKey = e => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) {
        if (e.key === 'Escape' && t.id === 'cmd') { t.blur(); }
        return;
      }
      const k = keys.current;
      const act = {
        j: () => k.move(1), k: () => k.move(-1),
        '/': () => { setView('Reconciliation'); requestAnimationFrame(() => searchRef.current?.focus()); },
        ':': () => commandRef.current?.focus(),
        '?': () => setHelpOpen(h => !h),
        x: () => { if (k.active?.status === 'open') k.togglePick(k.active.id); },
        i: () => { if (k.active?.status === 'open' && !k.investigatingId) k.investigate(k.active.id); },
        n: () => { const el = document.getElementById('review-note'); if (el) el.focus(); },
        1: () => setView('Reconciliation'), 2: () => setView('Imports'), 3: () => setView('Activity'), 4: () => setView('Close report'),
        Escape: () => setHelpOpen(false),
      }[e.key];
      if (act) { e.preventDefault(); act(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const headings = {
    Reconciliation: ['Reconciliation', 'Compare expected processor payouts with what reached the bank, and decide what to do about each difference.'],
    Imports: ['Imports', 'Add processor activity and bank deposits in the documented CSV format.'],
    Activity: ['Activity', 'Imports, draft suggestions, failures, and your reviews, newest first.'],
    'Close report': ['Close report', 'Everything a client or reviewer needs for this close: totals, the bridge, open items, and your notes.'],
  };
  const slug = VIEWS.find(v => v[0] === view)[2];
  const storageLabel = config?.storage === 'postgres' ? 'postgres' : 'local';
  const maxTotal = Math.max(flow.expected, flow.received, 1);
  const maxDelta = Math.max(1, ...flow.rows.map(r => Math.abs(r.delta)));
  const kindAmount = (k, s) => (s.total === 0 ? 'None' : k === 'awaiting_deposit' ? money(s.amount) + ' not yet in bank records' : k === 'unexpected_deposit' ? money(s.amount) + ' without processor records' : k === 'amount_mismatch' ? signedMoney(s.amount) + ' net difference' : 'Pick the right deposit');

  return <div className="crt">
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="tube">
      <header className="statusbar">
        <span className="prompt">clearledger@{storageLabel}:~/{slug}$<span className="cursor" aria-hidden="true" /></span>
        <span className="sysitems">
          {data && <span className={summary.open ? 'sys review' : 'sys ok'}>SYS:{summary.open ? 'REVIEW' : 'OK'}</span>}
          {data && <span>REV {data.revision}</span>}
          {config && <span className="hideable">{configModeLabel(config.investigator)}</span>}
          {checked && <span className="hideable">{checked.failed ? 'CHECK FAILED ' : 'CHECKED '}{clock(checked.at)}</span>}
        </span>
      </header>
      <div className="frame">
        <aside className="sidebar">
          <a className="brand" href="/"><Logo size={34} /><span className="wordmark">clearledger</span></a>
          <dl className="workspace kv">
            <div><dt>workspace</dt><dd>single · USD</dd></div>
            <div><dt>storage</dt><dd>{config ? (config.storage === 'postgres' ? 'PostgreSQL' : 'local file') : '…'}</dd></div>
          </dl>
          <nav aria-label="Workspace sections">{VIEWS.map(([name, icon], i) =>
            <button key={name} className={view === name ? 'nav active' : 'nav'} aria-current={view === name ? 'page' : undefined} onClick={() => setView(name)} aria-keyshortcuts={String(i + 1)}>
              <span className="fkey" aria-hidden="true">{i + 1}</span><Icon name={icon} />{name}{name === 'Reconciliation' && summary.open > 0 && <span className="navcount" aria-label={summary.open + ' need review'}>{summary.open}</span>}
            </button>)}</nav>
          <div className="sidebarbottom">
            <p><span className="statusdot" aria-hidden="true" />{config?.storage === 'postgres' ? 'PostgreSQL workspace' : 'Local-first workspace'}</p>
            {config && <p className="sidemeta">Investigations: {configModeLabel(config.investigator)}</p>}
            <p className="sidemeta">Drafts are suggestions. You decide every outcome.</p>
            <button type="button" className="keysbutton" aria-expanded={helpOpen} aria-controls="help" onClick={() => setHelpOpen(h => !h)} aria-keyshortcuts="?"><Icon name="keys" />Keys and commands</button>
          </div>
        </aside>
        <main>
          <div className="content" id="main" tabIndex={-1}>
            <div className="pageheading">
              <div>
                <h1><span className="h1prompt" aria-hidden="true">~/{slug} $ </span>{headings[view][0]}</h1>
                <p className="subtitle">{headings[view][1]}</p>
              </div>
              <div className="headactions">
                <div>
                  <button className="secondary" onClick={checkNow} disabled={!data || !!busy}><Icon name="refresh" />{busy === 'refresh' ? 'Checking…' : 'Check for updates'}</button>
                  <button className="secondary" onClick={downloadSummary} disabled={!data || cases.length === 0 || !!busy}><Icon name="grid" />{busy === 'summary' ? 'Preparing…' : 'Download CSV summary'}</button>
                  <button className="secondary" onClick={download} disabled={!data || !!busy}><Icon name="download" />{busy === 'export' ? 'Preparing…' : 'Export evidence'}</button>
                </div>
                <small className="actionsnote">CSV is a derived summary. The JSON evidence export is the source of record.</small>
              </div>
            </div>

            {data && <p className="freshness">
              Revision {data.revision}{checked && <> &middot; {checked.failed ? <span className="warntext">couldn&rsquo;t check for updates, last checked {clock(checked.at)}</span> : 'checked ' + clock(checked.at)}</>}
            </p>}

            {problem && <div className="alert" role="alert">
              <Icon name="alert" />
              <div className="alertbody">
                <strong>{problem.subject ? problem.subject + ': ' : ''}{problem.title}</strong>
                {problem.detail && <p>{problem.detail}</p>}
                {problem.hint && <p>{problem.hint}</p>}
                {problem.retry && <button type="button" className="secondary" disabled={!!busy || !!investigatingId} onClick={() => { const r = problem.retry; setProblem(null); r(); }}>Try again</button>}
              </div>
              <button type="button" className="iconbutton" onClick={() => setProblem(null)} aria-label="Dismiss error"><Icon name="close" /></button>
            </div>}
            {notice && <div className="notice" role="status" key={notice}>{notice}</div>}
            {loading && <div className="loading" role="status"><span className="skeleton" /><span className="skeleton" /><span className="skeleton short" /><span className="visually-hidden">Loading workspace…</span></div>}

            {needsToken && <form className="tokenbox" onSubmit={e => { e.preventDefault(); try { sessionStorage.setItem('clearledger-token', token); } catch { /* storage blocked */ } run('connect', 'load', refresh); }}>
              <Logo size={96} className="big" />
              <label>Workspace access token<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} aria-describedby="token-hint" /></label>
              <button className="primary" disabled={!!busy || !token}>Connect</button>
              <small id="token-hint">Kept only in this browser tab until you close it.</small>
            </form>}

            {!needsToken && data && view === 'Reconciliation' && <>
              {cases.length === 0 ? <div className="empty">
                <Logo size={120} className="big" />
                <h2>Your first reconciliation starts here.</h2>
                <p>Load 107 payouts from the ReconRiver reconciliation dataset: 8 amount mismatches, 9 missing deposits, and 5 unexpected payments among 85 matches. The data is synthetic (CC BY 4.0), so no real accounts are involved.</p>
                <button className="primary" onClick={() => run('demo', 'demo', async () => { await api('demo', { method: 'POST' }); await refresh(); setNotice('ReconRiver dataset loaded: 107 synthetic payouts. No real accounts are connected.'); })} disabled={!!busy}>{busy === 'demo' ? 'Loading…' : 'Load ReconRiver dataset'}<Icon name="arrow" /></button>
                <button className="textbutton" onClick={() => setView('Imports')}>Or import your CSV files</button>
              </div> : <>
                <section className="summary stats" aria-label="Workspace summary">
                  <div className="readout">
                    <p className="sysline">RECON:{summary.open ? summary.open + ' OPEN' : 'CLEAR'}<span className="cursor" aria-hidden="true" /></p>
                    <dl className="kv totals">
                      <div><dt>payouts</dt><dd>{cases.length}</dd></div>
                      <div><dt>matched</dt><dd>{summary.matched}</dd></div>
                      <div><dt>to review</dt><dd className={summary.open ? 'hot' : ''}>{summary.open}</dd></div>
                      <div><dt>reviewed</dt><dd>{summary.reviewed}</dd></div>
                      <div><dt>explained</dt><dd><span className="meter" aria-hidden="true">{meter(progress.pct)}</span> {progress.explained} of {plural(progress.exceptions, 'exception', 'exceptions')} ({progress.pct}%)</dd></div>
                      {asOf && <div><dt>records</dt><dd>{firstDate} → {asOf}</dd></div>}
                    </dl>
                  </div>
                  <div className="bridge">
                    <h2 className="bridgetitle">Where the money went <small>processor net → bank received</small></h2>
                    <div className="bridgeend">
                      <span className="bl">Processor net expected</span>
                      <span className="track"><span className="bar total" style={{ '--w': (flow.expected / maxTotal * 100) + '%' }} /></span>
                      <strong className="bv">{money(flow.expected)}</strong>
                    </div>
                    <div className="kinds" role="group" aria-label="Filter by exception type">
                      {exceptionKinds.map(k => { const s = summary.by[k]; const row = flow.rows.find(r => r.kind === k); const w = Math.abs(row.delta) / maxDelta * 50;
                        return <button type="button" key={k} className={'kind k-' + k + (kindFilter === k ? ' selected' : '')} aria-pressed={kindFilter === k} disabled={s.total === 0} onClick={() => setKindFilter(f => f === k ? null : k)}>
                          <span className="kindname">{kindLabels[k]}</span>
                          <strong>{s.open}<small> open{s.total > s.open ? ' · ' + (s.total - s.open) + ' reviewed' : ''}</small></strong>
                          <span className="kindamount">{kindAmount(k, s)}</span>
                          <span className="track delta" aria-hidden="true"><span className={'bar ' + (row.delta < 0 ? 'neg' : 'pos')} style={{ '--w': w + '%' }} /></span>
                          <span className="bv">{signedMoney(row.delta)}</span>
                        </button>; })}
                    </div>
                    <div className="bridgeend">
                      <span className="bl">Bank deposits imported</span>
                      <span className="track"><span className="bar total" style={{ '--w': (flow.received / maxTotal * 100) + '%' }} /></span>
                      <strong className="bv">{money(flow.received)}</strong>
                    </div>
                    <p className="bridgenote">Each type&rsquo;s bar is its share of the largest difference, drawn from the centre line: left means less reached the bank. Expected plus the four differences equals received ({signedMoney(flow.gap)}).</p>
                  </div>
                </section>

                <div className="recongrid">
                  <section className="panel casepanel" aria-labelledby="payouts-heading">
                    <div className="panelheading"><h2 id="payouts-heading">Payouts</h2><span className="muted" aria-live="polite">{visible.length === cases.length ? cases.length + ' total' : visible.length + ' of ' + cases.length + ' shown'}</span></div>
                    <div className="filters">
                      <div className="tabs" role="group" aria-label="Filter payouts by status">{[['all', 'All'], ['open', 'Needs review'], ['matched', 'Matched'], ['reviewed', 'Reviewed']].map(([id, label]) =>
                        <button key={id} className={filter === id ? 'selected' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
                      <input ref={searchRef} type="search" aria-label="Search payouts" aria-keyshortcuts="/" placeholder="Search payout, record ID, description, or amount" value={search} onChange={e => setSearch(e.target.value)} />
                      {kindFilter && <p className="activefilter">Showing {kindLabels[kindFilter].toLowerCase()} only <button type="button" className="linkbutton" onClick={() => setKindFilter(null)}>Show all types</button></p>}
                    </div>
                    {picked.size > 0 && <form className="bulkbar" aria-label="Bulk review" onSubmit={e => { e.preventDefault(); bulkReview(); }}>
                      <p><strong>{plural(picked.size, 'payout', 'payouts')} selected.</strong> Each gets its own review record with this note.</p>
                      <label className="visually-hidden" htmlFor="bulk-note">Note for the selected payouts</label>
                      <textarea id="bulk-note" maxLength={1000} placeholder="What you checked for all of them, e.g. Deposits confirmed on the bank statement dated 2026-01-19." value={bulkNote} onChange={e => setBulkNote(e.target.value)} />
                      <div className="bulkactions">
                        <button className="primary" disabled={!!busy || bulkNote.trim().length < 10}>{busy === 'bulk' ? 'Recording…' : 'Apply note to ' + plural(picked.size, 'payout', 'payouts')}</button>
                        <button type="button" className="secondary" onClick={() => setPicked(new Set())} disabled={!!busy}>Clear selection</button>
                      </div>
                    </form>}
                    <div className="tablewrap"><table>
                      <caption className="visually-hidden">Payouts, expected and bank amounts, bank minus expected difference, and review status</caption>
                      <thead><tr>
                        <th scope="col" className="pick"><input type="checkbox" aria-label="Select every open payout shown" checked={allOpenPicked} disabled={!openVisible.length} onChange={e => pickAllOpen(e.target.checked)} /></th>
                        <th scope="col">Payout</th>{sortColumns.map(([key, label]) =>
                        <th key={key} scope="col" className="num" aria-sort={sortState(key)}>
                          <button type="button" className="sortbutton" onClick={() => toggleSort(key)} aria-label={label + (sort.key === key ? (sort.dir === 'asc' ? ', sorted ascending' : ', sorted descending') : ', not sorted')}>
                            {label}<span className="sortmark" aria-hidden="true"><Icon name={sort.key === key ? (sort.dir === 'asc' ? 'sortup' : 'sortdown') : 'sort'} /></span>
                          </button>
                        </th>)}<th scope="col">Status</th></tr></thead>
                      <tbody>{rows.map(c => { const age = ageOf(c); return <tr key={c.id} className={(selected === c.id ? 'selectedrow' : '') + (picked.has(c.id) ? ' pickedrow' : '')}>
                        <td className="pick">{c.status === 'open' && <input type="checkbox" aria-label={'Select for bulk review: ' + c.payout} checked={picked.has(c.id)} onChange={() => togglePick(c.id)} />}</td>
                        <td className="payoutcell"><button className="rowbutton" aria-current={selected === c.id ? 'true' : undefined} onClick={() => selectCase(c.id)}>{c.payout}</button><small>{c.evidence.length} source record{c.evidence.length === 1 ? '' : 's'}{age !== null && c.status === 'open' && <> &middot; {plural(age, 'day', 'days')} since last processor record</>}</small></td>
                        <td className="num">{money(c.expected_cents)}</td>
                        <td className="num">{money(c.actual_cents)}</td>
                        <td className={'num deltacell' + (c.delta_cents ? (c.delta_cents > 0 ? ' positive' : ' negative') : '')}>{signedMoney(c.delta_cents)}</td>
                        <td className="statuscell"><span className={'badge ' + c.status + ' k-' + c.kind}>{statusLabel(c)}</span>
                          {investigatingId === c.id && <span className="tag investigating">Investigating…</span>}
                          {updatedIds.has(c.id) && <span className="tag updated">New evidence</span>}
                          {c.status === 'open' && everReviewed.has(c.payout) && <span className="tag reopened">Reopened</span>}
                          {c.status === 'open' && c.proposal && <span className="tag drafted">Draft ready</span>}
                        </td>
                      </tr>; })}</tbody>
                    </table>
                    {visible.length === 0 && <div className="nothing"><p>No payouts match this filter.</p>{filtersActive && <button type="button" className="linkbutton" onClick={() => { setFilter('all'); setKindFilter(null); setSearch(''); }}>Clear filters</button>}</div>}
                    {!showAll && visible.length > ROW_LIMIT && <div className="nothing"><p>Showing the first {ROW_LIMIT} of {visible.length} payouts.</p><button type="button" className="secondary" onClick={() => setShowAll(true)}>Show all {visible.length}</button></div>}
                    </div>
                  </section>

                  {active && <CaseDetail
                    c={active} records={data.records} audit={data.audit} config={config} headingRef={detailHeadingRef} cases={cases} asOf={asOf}
                    updated={updatedIds.has(active.id)} investigatingId={investigatingId} onInvestigate={investigate}
                    busy={busy} note={note} setNote={changeNote} noteStale={noteStale}
                    onAcknowledge={() => setNoteFp(active.fingerprint)} onReview={() => submitReview()} onNotice={setNotice}
                    onOpenCase={id => selectCase(id)} onPrint={() => printView('case')}
                  />}
                </div>
              </>}
            </>}

            {!needsToken && view === 'Imports' && <div className="importgrid">
              <section className="panel importpanel">
                <h2>Import a CSV</h2>
                <p>Use one currency and stable record IDs. Importing the same records again won&rsquo;t duplicate them.</p>
                <label>Record source<select value={source} onChange={e => setSource(e.target.value)}><option value="processor">Processor activity</option><option value="bank">Bank deposits</option></select></label>
                <label className="filedrop"><Icon name="upload" /><strong>{file ? file.name : 'Choose a CSV file'}</strong><small>Up to 2 MB per import &middot; 10,000 records per workspace</small><input aria-label="Choose CSV file" type="file" accept=".csv,text/csv" onChange={e => setFile(e.target.files[0] || null)} /></label>

                {file && file.size > REQUEST_LIMIT_BYTES * 0.95 && <p className="banner warn" role="note">This file is {(file.size / 1024 / 1024).toFixed(1)} MB. The server accepts up to 2 MB per import, so it will probably be rejected. Split it into smaller files.</p>}

                {preview && <div className="csvpreview" aria-live="polite">
                  <p className="previewlabel">Format preview only &mdash; checks header, field shapes, and types. The server performs the authoritative validation, matching, and deduplication.</p>
                  {preview.errors.length > 0 ? <>
                    <p className="previewbad">{preview.validRows} of {preview.totalRows} row(s) look valid. {preview.errors.length >= 20 ? 'First 20 issues shown:' : 'Issues found:'}</p>
                    <ul className="previewerrors">{preview.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </> : <p className="previewgood"><Icon name="check" />{preview.validRows} row(s) match the expected format.</p>}
                  {preview.sample.length > 0 && <div className="previewscroll"><table className="previewtable"><caption className="visually-hidden">First rows of the selected file</caption><thead><tr><th scope="col">id</th><th scope="col">payout</th><th scope="col">date</th><th scope="col" className="num">gross</th><th scope="col" className="num">fee</th></tr></thead>
                    <tbody>{preview.sample.map((r, i) => <tr key={i}><td>{r.id}</td><td>{r.payout}</td><td>{r.date}</td><td className="num">{money(r.gross_cents)}</td><td className="num">{money(r.fee_cents)}</td></tr>)}</tbody></table></div>}
                </div>}

                <button className="primary" disabled={!file || !!busy} onClick={submitImport}>{busy === 'import' ? 'Importing…' : 'Import and reconcile'}<Icon name="arrow" /></button>
              </section>
              <section className="panel guide">
                <h2>Start with the right format</h2>
                <p>This release accepts one documented, normalized format. Native Stripe and bank export mapping is planned, not available yet.</p>
                <p className="samples"><a href="/samples/processor.csv" download>Download processor CSV</a><a href="/samples/bank.csv" download>Download bank CSV</a></p>
                <h3>Before you import</h3>
                <p>Amounts are integer cents. Processor refunds use negative gross amounts. Bank rows have a zero fee. Both files use the payout reference to link a payout to its deposit.</p>
                <h3>How payouts are labelled</h3>
                <dl className="glossary">
                  <div><dt>Matched</dt><dd>Exactly one bank deposit with the reference, for exactly the processor net.</dd></div>
                  <div><dt>Amount mismatch</dt><dd>One deposit, but a different amount from the processor net.</dd></div>
                  <div><dt>Awaiting deposit</dt><dd>Processor records, but no deposit with that reference in the imported bank records. Not called overdue: there is no expected settlement date.</dd></div>
                  <div><dt>Multiple deposits</dt><dd>More than one deposit uses the reference, so you decide which belong to the payout.</dd></div>
                  <div><dt>Unexpected deposit</dt><dd>A deposit whose reference appears in no imported processor records.</dd></div>
                </dl>
              </section>
            </div>}

            {!needsToken && data && view === 'Activity' && <section className="panel activity" aria-labelledby="activity-heading">
              <div className="panelheading"><h2 id="activity-heading">Activity history</h2><span className="muted">{data.audit.length} entries</span></div>
              <div className="filters"><div className="tabs" role="group" aria-label="Filter activity">{[['all', 'All'], ['imports', 'Imports'], ['drafts', 'Drafts'], ['failures', 'Failures'], ['reviews', 'Reviews']].map(([id, label]) =>
                <button key={id} className={activityFilter === id ? 'selected' : ''} aria-pressed={activityFilter === id} onClick={() => setActivityFilter(id)}>{label}{id !== 'all' && <span className="count">{activityCounts[id] || 0}</span>}</button>)}</div></div>
              <ol className="activitylist">{activity.filter(a => activityFilter === 'all' || activityGroup(a.action) === activityFilter).map((a, i) => { const c = payoutOf(a.detail); return <li className={'activityrow ' + activityGroup(a.action)} key={i}>
                <span className="activityicon" aria-hidden="true"><Icon name={a.action === 'investigation.failed' ? 'alert' : a.action.startsWith('import') ? 'upload' : a.action === 'case.reviewed' ? 'check' : a.action.startsWith('investigation') ? 'spark' : 'clock'} /></span>
                <div><strong>{activityLabel(a.action)}</strong><p>{a.detail}</p>{c && <button type="button" className="linkbutton" onClick={() => { setView('Reconciliation'); selectCase(c.id); }}>Open {c.payout}</button>}</div>
                <time dateTime={a.at}>{when(a.at)}</time>
              </li>; })}</ol>
              {!data.audit.length && <p className="nothing">Your first import will appear here.</p>}
              {data.audit.length > 0 && activityFilter !== 'all' && !activityCounts[activityFilter] && <p className="nothing">No {activityFilter} yet.</p>}
            </section>}

            {!needsToken && data && view === 'Close report' && <article className="report" aria-labelledby="report-heading">
              <header className="reporthead">
                <div>
                  <h2 id="report-heading">Payout reconciliation close</h2>
                  <p>Records dated {firstDate || 'none'} to {asOf || 'none'} &middot; revision {data.revision} &middot; prepared {when(new Date().toISOString())}</p>
                </div>
                <button type="button" className="primary" onClick={() => printView('report')}><Icon name="print" />Print close report</button>
              </header>
              <dl className="reportfigures">
                <div><dt>Processor net expected</dt><dd>{money(flow.expected)}</dd></div>
                <div><dt>Bank deposits imported</dt><dd>{money(flow.received)}</dd></div>
                <div><dt>Difference</dt><dd>{signedMoney(flow.gap)}</dd></div>
                <div><dt>Exceptions explained</dt><dd>{progress.explained} of {progress.exceptions}</dd></div>
              </dl>
              <h3>Bridge</h3>
              <table className="reporttable">
                <caption className="visually-hidden">From processor net expected to bank deposits imported</caption>
                <thead><tr><th scope="col">Line</th><th scope="col" className="num">Payouts</th><th scope="col" className="num">Still open</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Processor net expected</th><td className="num">{cases.length}</td><td className="num">—</td><td className="num">{money(flow.expected)}</td></tr>
                  {flow.rows.map(r => <tr key={r.kind}><th scope="row">{kindLabels[r.kind]}</th><td className="num">{r.cases}</td><td className="num">{r.open}</td><td className="num">{signedMoney(r.delta)}</td></tr>)}
                  <tr className="total"><th scope="row">Bank deposits imported</th><td className="num" /><td className="num" /><td className="num">{money(flow.received)}</td></tr>
                </tbody>
              </table>
              <h3>Still open ({summary.open})</h3>
              {summary.open ? <table className="reporttable">
                <caption className="visually-hidden">Payouts that still need review</caption>
                <thead><tr><th scope="col">Payout</th><th scope="col">Type</th><th scope="col" className="num">Difference</th><th scope="col">Notes</th></tr></thead>
                <tbody>{cases.filter(c => c.status === 'open').map(c => { const age = ageOf(c); return <tr key={c.id}><th scope="row">{c.payout}</th><td>{kindLabels[c.kind]}</td><td className="num">{signedMoney(c.delta_cents)}</td><td>{[age !== null ? plural(age, 'day', 'days') + ' since last processor record' : null, c.proposal ? 'Draft: ' + c.proposal.action.replaceAll('_', ' ') : null].filter(Boolean).join(' · ') || '—'}</td></tr>; })}</tbody>
              </table> : <p className="none">Nothing is open. Every exception has a recorded review.</p>}
              <h3>Reviewed ({summary.reviewed})</h3>
              {summary.reviewed ? <table className="reporttable">
                <caption className="visually-hidden">Reviewed payouts and the reviewer's notes</caption>
                <thead><tr><th scope="col">Payout</th><th scope="col">Type</th><th scope="col" className="num">Difference</th><th scope="col">Reviewer note</th></tr></thead>
                <tbody>{cases.filter(c => c.status === 'reviewed').map(c => <tr key={c.id}><th scope="row">{c.payout}</th><td>{kindLabels[c.kind]}</td><td className="num">{signedMoney(c.delta_cents)}</td><td>{c.review_note}</td></tr>)}</tbody>
              </table> : <p className="none">No reviews recorded yet.</p>}
              <p className="reportfoot">A review records that someone checked the payout; it does not change amounts or mark money as recovered. The JSON evidence export is the source of record. Ages count days inside the imported records, not days since today, and are not overdue claims.</p>
            </article>}

            <footer>Source records are preserved. Investigations are drafts. You decide the next action. The activity history is an application log, not a tamper-proof audit record.</footer>
          </div>

          {helpOpen && <section className="help" id="help" aria-labelledby="help-heading">
            <div className="panelheading"><h2 id="help-heading">Keys and commands</h2><button type="button" className="iconbutton" onClick={() => setHelpOpen(false)} aria-label="Close keys and commands"><Icon name="close" /></button></div>
            <div className="helpcols">
              <dl className="kv">
                <div><dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>next or previous payout in the list</dd></div>
                <div><dt><kbd>x</kbd></dt><dd>select the open payout for a bulk review</dd></div>
                <div><dt><kbd>i</kbd></dt><dd>investigate the open payout</dd></div>
                <div><dt><kbd>n</kbd></dt><dd>write the reviewer note</dd></div>
                <div><dt><kbd>Ctrl</kbd>+<kbd>Enter</kbd></dt><dd>record the review, then go to the next open payout</dd></div>
                <div><dt><kbd>/</kbd></dt><dd>search, including amounts like 2.00</dd></div>
                <div><dt><kbd>:</kbd></dt><dd>type a command</dd></div>
                <div><dt><kbd>1</kbd>–<kbd>4</kbd></dt><dd>switch section</dd></div>
              </dl>
              <dl className="kv">
                <div><dt>open PO-1002</dt><dd>open a payout by reference</dd></div>
                <div><dt>filter open</dt><dd>all, open, matched, reviewed</dd></div>
                <div><dt>type awaiting</dt><dd>awaiting, mismatch, multiple, unexpected, all</dd></div>
                <div><dt>find 2.00</dt><dd>text or exact amount</dd></div>
                <div><dt>sort difference desc</dt><dd>expected, received, difference, none</dd></div>
                <div><dt>review &lt;note&gt;</dt><dd>record a review on the open payout</dd></div>
                <div><dt>select open</dt><dd>select every open payout shown</dd></div>
                <div><dt>go report</dt><dd>reconcile, imports, activity, report</dd></div>
              </dl>
            </div>
          </section>}

          <div className="console">
            {log.length > 0 && <ol className="transcript" role="log" aria-label="Command output" ref={logRef}>
              {log.map(l => <li key={l.id} className={'line ' + l.kind}>{l.kind === 'cmd' && <span className="ps" aria-hidden="true">$ </span>}{l.text}</li>)}
            </ol>}
            <form className="commandline" onSubmit={e => { e.preventDefault(); const v = command; setCommand(''); runCommand(v); }}>
              <label htmlFor="cmd"><Icon name="terminal" /><span>clearledger:~$</span></label>
              <input id="cmd" ref={commandRef} value={command} onChange={e => setCommand(e.target.value)} autoComplete="off" spellCheck={false} aria-keyshortcuts=":" placeholder="type help, or press ? for keys" aria-describedby="cmd-hint" />
              <span id="cmd-hint" className="visually-hidden">Commands such as open, find, filter, investigate, and review. Press Enter to run.</span>
            </form>
          </div>
        </main>
      </div>
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
