import React, { useState } from 'react';
import { Icon } from './Icon.jsx';
import {
  actionLabels, activityLabel, breakdown, caseHistory, checklists, clues, configModeLabel, daysBetween, explain,
  kindLabels, lastDate, modeLabel, money, resetInfo, signedMoney, when,
} from './model.js';

const LONG_DESCRIPTION = 160;

function Description({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="recdesc muted">No description</span>;
  if (text.length <= LONG_DESCRIPTION) return <span className="recdesc">{text}</span>;
  return <>
    <span className={'recdesc' + (open ? '' : ' clamped')}>{text}</span>
    <button type="button" className="linkbutton descmore" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Show less' : 'Show full description'}</button>
  </>;
}

function RecordRow({ id, record, cited, flash }) {
  if (!record) return <li className="record missing" id={'record-' + id}><div><strong className="recid">{id}</strong><span className="recdesc">This record is not in the loaded workspace. Check for updates.</span></div></li>;
  const net = record.gross_cents - record.fee_cents;
  return <li className={'record' + (flash ? ' flash' : '')} id={'record-' + id} tabIndex={-1}>
    <div className="recmain">
      <div className="recline"><strong className="recid">{record.id}</strong>{cited && <span className="tag cited">Cited by draft</span>}</div>
      <Description text={record.description} />
      <span className="recmeta">{record.date}{record.source === 'processor' && <> &middot; Gross {money(record.gross_cents)} &middot; Fee {money(record.fee_cents)}</>}</span>
    </div>
    <span className={'recamount' + (net < 0 ? ' negative' : '')}>{money(net)}</span>
  </li>;
}

export function CaseDetail({ c, records, audit, config, headingRef, updated, investigatingId, onInvestigate, busy, note, setNote, noteStale, onAcknowledge, onReview, onNotice, cases = [], asOf = null, onOpenCase, onPrint }) {
  const [flashId, setFlashId] = useState(null);
  const b = breakdown(c, records);
  const history = caseHistory(audit, c.payout);
  const { reviewReset, draftReset } = resetInfo(c, history);
  const cited = new Set(c.proposal?.evidence || []);
  const isOpen = c.status === 'open';
  const running = investigatingId === c.id;
  const hints = clues(c, records, cases);
  const lastProcessor = c.kind === 'awaiting_deposit' ? lastDate(c, records, 'processor') : null;
  const age = lastProcessor ? daysBetween(lastProcessor, asOf) : null;
  const canReview = !busy && !noteStale && note.trim().length >= 10;

  function showRecord(id) {
    const el = document.getElementById('record-' + id);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.focus({ preventScroll: true });
    setFlashId(id);
    setTimeout(() => setFlashId(f => (f === id ? null : f)), 1600);
  }

  async function copyIds() {
    const text = c.proposal.evidence.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onNotice('Copied ' + c.proposal.evidence.length + ' record ID' + (c.proposal.evidence.length === 1 ? '' : 's') + ' for ' + c.payout + '.');
    } catch {
      onNotice('Copying is blocked in this browser. The cited record IDs are: ' + c.proposal.evidence.join(', '));
    }
  }

  const figure = (label, value, empty) => <div><span>{label}</span><strong>{empty || money(value)}</strong></div>;

  return <section className="panel detail" aria-labelledby="case-heading">
    <header className="detailhead">
      <div>
        <h2 id="case-heading" ref={headingRef} tabIndex={-1}>{c.payout}</h2>
        <p className="kindline">{kindLabels[c.kind]}{c.status === 'reviewed' && ' · reviewed by you'}</p>
      </div>
      <div className="headtools">
        <span className={'badge ' + c.status}>{isOpen ? 'Needs review' : c.status === 'matched' ? 'Matched' : 'Reviewed'}</span>
        <button type="button" className="iconbutton" onClick={() => (onPrint ? onPrint() : window.print())} aria-label={'Print ' + c.payout}><Icon name="print" /></button>
      </div>
    </header>

    {updated && <p className="banner info" role="note">New evidence arrived for this payout since you last opened it. The figures below are current.</p>}
    {reviewReset && <div className="banner warn" role="note">
      <strong>Your earlier review no longer applies.</strong>
      <p>New records for {c.payout} arrived after it was reviewed, so the server reopened it. Earlier note: &ldquo;{reviewReset.text}&rdquo;</p>
    </div>}
    {!reviewReset && draftReset && <p className="banner warn" role="note">An earlier draft suggestion was discarded because this payout&rsquo;s records changed. Run the investigation again for a draft based on the current records.</p>}

    <div className="why">
      <h3>{c.kind === 'matched' ? 'Why it matched' : 'Why it needs review'}</h3>
      <p>{explain(c)}</p>
      {age !== null && <p className="agefact">Last processor record {lastProcessor}, {age === 1 ? '1 day' : age + ' days'} before the newest imported record ({asOf}). Counted inside the imported data, not from today, and not an overdue claim.</p>}
    </div>

    <div className="figures" role="group" aria-label="Amounts">
      {figure('Expected net', c.expected_cents, b.processor.length === 0 ? 'None' : null)}
      {figure('Bank received', c.actual_cents, b.bank.length === 0 ? 'None' : null)}
      <div className={'difference' + (c.delta_cents < 0 ? ' negative' : c.delta_cents > 0 ? ' positive' : '')}><span>Difference</span><strong>{signedMoney(c.delta_cents)}</strong></div>
    </div>

    <div className="records">
      <h3>Records behind this payout</h3>
      {!b.consistent && <p className="banner warn" role="note">These records don&rsquo;t add up to the server&rsquo;s totals. The totals above come from the server; check for updates, and report it if this persists.</p>}
      <h4>Processor <span className="count">{b.processor.length}</span></h4>
      {b.processor.length ? <>
        <ul className="recordlist">{c.evidence.filter(id => records[id]?.source === 'processor').map(id => <RecordRow key={id} id={id} record={records[id]} cited={cited.has(id)} flash={flashId === id} />)}</ul>
        <dl className="calc">
          <div><dt>Sales</dt><dd>{money(b.sales)}</dd></div>
          {b.refunds !== 0 && <div><dt>Refunds</dt><dd>{money(b.refunds)}</dd></div>}
          <div><dt>Fees</dt><dd>{money(-b.fees)}</dd></div>
          <div className="total"><dt>Expected net</dt><dd>{money(c.expected_cents)}</dd></div>
        </dl>
      </> : <p className="none">No processor records use reference {c.payout}.</p>}
      <h4>Bank <span className="count">{b.bank.length}</span></h4>
      {b.bank.length ? <>
        <ul className="recordlist">{c.evidence.filter(id => records[id]?.source === 'bank').map(id => <RecordRow key={id} id={id} record={records[id]} cited={cited.has(id)} flash={flashId === id} />)}</ul>
        <dl className="calc"><div className="total"><dt>Bank received</dt><dd>{money(c.actual_cents)}</dd></div></dl>
      </> : <p className="none">No bank deposit uses reference {c.payout} in the imported bank records.</p>}
      {b.missing > 0 && <ul className="recordlist">{c.evidence.filter(id => !records[id]).map(id => <RecordRow key={id} id={id} />)}</ul>}
    </div>

    {hints.length > 0 && <div className="clues">
      <h3>Clues in the records</h3>
      <ul>{hints.map((h, i) => <li key={i}><span>{h.text}</span>
        {h.record && records[h.record] && <button type="button" className="linkbutton" onClick={() => showRecord(h.record)} aria-label={'Go to record ' + h.record}>Go to record</button>}
        {h.caseId && onOpenCase && <button type="button" className="linkbutton" onClick={() => onOpenCase(h.caseId)}>Open that payout</button>}
      </li>)}</ul>
      <p className="fine">Exact arithmetic on the imported records, not an AI suggestion and not a conclusion.</p>
    </div>}

    {c.status === 'matched' && <div className="matchnote"><Icon name="check" /><p>Nothing to do. One bank deposit has this reference and the exact processor net.</p></div>}

    {isOpen && checklists[c.kind] && <div className="checklist">
      <h3>What to check</h3>
      <ol>{checklists[c.kind].map(item => <li key={item}>{item}</li>)}</ol>
      <p className="fine">A standard checklist for {kindLabels[c.kind].toLowerCase()} cases, not an AI suggestion.</p>
    </div>}

    {isOpen && <div className="draft">
      <div className="drafthead">
        <h3><Icon name="spark" /> Suggested next step</h3>
        <span className="mode" title="What this workspace is configured to use. Availability is checked when you run an investigation.">{configModeLabel(config?.investigator)}</span>
      </div>
      {c.proposal ? <div className="proposal">
        <p className="draftflag">Draft &middot; {modeLabel(c.proposal.mode)} &middot; nothing has been sent, paid, or changed</p>
        <strong className="draftaction">{actionLabels[c.proposal.action] || c.proposal.action}</strong>
        <p className="draftsummary">{c.proposal.summary}</p>
        <div className="citations">
          <span>Based on</span>
          {c.proposal.evidence.map(id => <button type="button" key={id} className="chip" onClick={() => showRecord(id)} aria-label={'Show record ' + id}>{id}</button>)}
          <button type="button" className="linkbutton" onClick={copyIds}>Copy record IDs</button>
        </div>
        <details><summary>Steps the investigator took</summary><ol>{c.proposal.trace.map((t, i) => <li key={i}>{t}</li>)}</ol></details>
      </div> : <p className="draftempty">{config?.investigator === 'rules'
        ? 'Run the checklist to draft a next step from these records. It does not change any amounts.'
        : 'Ask the local model to read these records and draft a next step. It cannot change amounts or contact anyone.'}</p>}
      <button className="primary full" disabled={investigatingId !== null} aria-busy={running} onClick={() => onInvestigate(c.id)}>
        <Icon name="spark" />{running ? 'Investigating…' : investigatingId ? 'Another investigation is running…' : c.proposal ? 'Run investigation again' : 'Investigate exception'}
      </button>
      {running && <p className="fine" role="status">Reading this payout&rsquo;s records. This can take up to 45 seconds with a local model.</p>}
    </div>}

    {isOpen && <div className="review">
      <h3><label htmlFor="review-note">Reviewer note</label></h3>
      <p className="fine" id="review-hint">What you checked and what happens next. 10 to 1,000 characters.</p>
      {noteStale && <div className="banner warn" role="alert">
        <strong>This payout&rsquo;s records changed after you started this note.</strong>
        <p>Your note is kept. Check the updated records above, then confirm before recording it.</p>
        <button type="button" className="secondary" onClick={onAcknowledge}>I&rsquo;ve checked the updated records</button>
      </div>}
      <textarea id="review-note" aria-describedby="review-hint review-meaning" maxLength={1000} placeholder="e.g. Processor statement shows a $5.00 dispute fee. Asked the processor for the dispute record." value={note} onChange={e => setNote(e.target.value)} aria-keyshortcuts="Control+Enter" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canReview) { e.preventDefault(); onReview(); } }} />
      <div className="reviewfoot">
        <span className="fine">{note.length}/1,000</span>
        <button className="secondary" disabled={!canReview} onClick={onReview}>{busy === 'review' ? 'Recording…' : 'Record review'}</button>
      </div>
      <p className="fine" id="review-meaning">Recording a review means you checked this payout. It does not mark the amounts as matching or the money as recovered.</p>
    </div>}

    {c.status === 'reviewed' && <div className="reviewed">
      <h3>Your review</h3>
      <blockquote>{c.review_note}</blockquote>
      <p className="fine">Reviewed means checked by you. The amounts above are unchanged and still show the difference.</p>
    </div>}

    <div className="history">
      <h3>History for this payout</h3>
      {history.length ? <ol>{[...history].reverse().map((h, i) => <li key={i} className={h.action === 'investigation.failed' ? 'failed' : ''}>
        <strong>{activityLabel(h.action)}</strong><span>{h.text}</span><time dateTime={h.at}>{when(h.at)}</time>
      </li>)}</ol> : <p className="none">No drafts or reviews yet. Imports appear in Activity.</p>}
    </div>
  </section>;
}
