// Bank statement conversion for the import screen: ISO 20022 camt.052/053/054 XML and BAI2
// files become the documented bank CSV (id,payout,currency,date,gross_cents,fee_cents,
// description) inside this browser. The output follows the same conventions as the curated
// ReconRiver bank file: booked credits are positive, booked debits keep a negative amount
// (a refund payout settles as a bank debit), fees are zero, dates are UTC calendar dates, and
// descriptions start with "Bank credit" or "Bank debit". The converted CSV then goes through
// the same format preview and server validation as a hand-made file; nothing here decides
// what the server accepts.

export const CSV_HEADER = ['id', 'payout', 'currency', 'date', 'gross_cents', 'fee_cents', 'description'];

export const FORMAT_LABELS = {
  csv: 'CSV',
  camt052: 'ISO 20022 camt.052 account report',
  camt053: 'ISO 20022 camt.053 bank statement',
  camt054: 'ISO 20022 camt.054 credit notification',
  bai2: 'BAI2 cash management file',
};

// Which statement field carries the payout reference. "auto" takes the first non-empty one
// in the listed order; banks differ, so the reviewer can pick a field and a pattern.
export const REFERENCE_FIELDS = {
  camt: [['auto', 'Automatic'], ['EndToEndId', 'End-to-end ID'], ['Ustrd', 'Remittance information'], ['AcctSvcrRef', 'Bank reference'], ['AddtlNtryInf', 'Entry description']],
  bai2: [['auto', 'Automatic'], ['customerRef', 'Customer reference'], ['bankRef', 'Bank reference'], ['text', 'Transaction text']],
};
export const AUTO_HINTS = {
  camt: 'Automatic uses the end-to-end ID, then the remittance text, then the entry description.',
  bai2: 'Automatic uses the customer reference, then the transaction text.',
};
const AUTO_ORDER = { camt: ['EndToEndId', 'Ustrd', 'AddtlNtryInf'], bai2: ['customerRef', 'text'] };
const CAMT_ROOTS = { BkToCstmrAcctRpt: 'camt052', BkToCstmrStmt: 'camt053', BkToCstmrDbtCdtNtfctn: 'camt054' };

export const formatFamily = format => (format?.startsWith('camt') ? 'camt' : format === 'bai2' ? 'bai2' : null);

export function detectFormat(text) {
  const head = String(text).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<')) {
    for (const [root, format] of Object.entries(CAMT_ROOTS)) if (head.includes(root)) return format;
    return 'xml';
  }
  if (/^01,/.test(head)) return 'bai2';
  return 'csv';
}

// Decimal text ("1234.5") -> integer cents, parsed as text so no float rounding can occur.
function decimalToCents(text) {
  const t = String(text).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

// Returns the payout reference, or null when a pattern is set and nothing matches it: the
// pattern says what a payout reference looks like, so such an entry is not a payout movement
// (interest, a transfer, an account fee) and is skipped rather than imported as a bad row.
// With a pattern, each field is searched in order and the first match wins, so a bank code in
// the end-to-end ID does not hide the payout ID written in the remittance text.
function pickReference(fields, family, choice, pattern) {
  const order = choice === 'auto' ? AUTO_ORDER[family] : [choice];
  for (const name of order) {
    const v = (fields[name] || '').trim();
    if (!v || v.toUpperCase() === 'NOTPROVIDED') continue;
    if (!pattern) return v;
    const m = v.match(pattern);
    if (m) return m[0];
  }
  return pattern ? null : '';
}

// Booking dates are plain dates. A date-time with a zone becomes its UTC calendar date, the
// convention the import contract uses; one without a zone keeps its written date.
export function utcDate(value) {
  const v = String(value || '').trim();
  if (/T.*(Z|[+-]\d\d:?\d\d)$/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return v.slice(0, 10);
}

const describe = (cents, info) => (cents < 0 ? 'Bank debit' : 'Bank credit') + (info ? ' · ' + info : '');
const emptySkips = () => ({ debits: 0, pending: 0, unreadable: 0, unreferenced: 0, unclassified: 0 });

// Compiles the optional "reference looks like" pattern; a bad pattern is a user error, not a crash.
export function compilePattern(text) {
  const t = String(text || '').trim();
  if (!t) return { pattern: null, error: null };
  try {
    return { pattern: new RegExp(t, 'i'), error: null };
  } catch {
    return { pattern: null, error: 'The reference pattern is not a valid regular expression.' };
  }
}

const clean = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 1000);

// --- ISO 20022 camt.05x -------------------------------------------------------------------

const kids = (el, name) => (el ? [...el.children].filter(k => k.localName === name) : []);
const child = (el, ...path) => path.reduce((e, n) => (e ? kids(e, n)[0] : null), el);
const text = (el, ...path) => child(el, ...path)?.textContent.trim() || '';

export function convertCamt(xml, { referenceField = 'auto', pattern = null, includeDebits = true, parseXml } = {}) {
  const parse = parseXml || (s => new DOMParser().parseFromString(s, 'application/xml'));
  const doc = parse(String(xml).replace(/^﻿/, ''));
  if (!doc || doc.getElementsByTagName('parsererror').length) return { error: 'This file is not well-formed XML.' };
  const entries = [...doc.getElementsByTagNameNS('*', 'Ntry')];
  if (!entries.length) return { error: 'No statement entries (Ntry) were found in this file.' };

  const rows = [];
  const skipped = emptySkips();
  entries.forEach((ntry, n) => {
    const status = text(ntry, 'Sts');
    if (status && status !== 'BOOK') { skipped.pending++; return; }
    const entrySign = text(ntry, 'CdtDbtInd');
    const date = utcDate(text(ntry, 'BookgDt', 'Dt') || text(ntry, 'BookgDt', 'DtTm') || text(ntry, 'ValDt', 'Dt') || text(ntry, 'ValDt', 'DtTm'));
    const entryRef = text(ntry, 'AcctSvcrRef') || text(ntry, 'NtryRef');
    const entryInfo = text(ntry, 'AddtlNtryInf');
    const txs = kids(child(ntry, 'NtryDtls'), 'TxDtls');
    // A batch-booked entry lists each transaction with its own amount; split it so every
    // payout keeps its own bank row. Otherwise the entry itself is one bank row.
    const split = txs.length > 1 && txs.every(tx => text(tx, 'AmtDtls', 'TxAmt', 'Amt') || text(tx, 'Amt'));
    const parts = split ? txs : [txs[0] || null];
    parts.forEach((tx, k) => {
      const sign = (split && text(tx, 'CdtDbtInd')) || entrySign;
      if (sign !== 'CRDT' && sign !== 'DBIT') { skipped.unclassified++; return; }
      if (sign === 'DBIT' && !includeDebits) { skipped.debits++; return; }
      const amtEl = split ? (child(tx, 'AmtDtls', 'TxAmt', 'Amt') || child(tx, 'Amt')) : child(ntry, 'Amt');
      const cents = amtEl ? decimalToCents(amtEl.textContent) : null;
      if (cents === null) { skipped.unreadable++; return; }
      const fields = {
        EndToEndId: text(tx, 'Refs', 'EndToEndId'),
        Ustrd: tx ? kids(child(tx, 'RmtInf'), 'Ustrd').map(u => u.textContent.trim()).join(' ') : '',
        AcctSvcrRef: text(tx, 'Refs', 'AcctSvcrRef') || entryRef,
        AddtlNtryInf: text(tx, 'AddtlTxInf') || entryInfo,
      };
      const payout = pickReference(fields, 'camt', referenceField, pattern);
      if (payout === null) { skipped.unreferenced++; return; }
      const signed = sign === 'DBIT' ? -cents : cents;
      const base = entryRef || 'camt-' + (n + 1);
      rows.push({
        id: split ? base + '-' + (k + 1) : base,
        payout,
        currency: amtEl.getAttribute('Ccy') || '',
        date,
        gross_cents: signed,
        description: clean(describe(signed, fields.AddtlNtryInf || fields.Ustrd)),
      });
    });
  });
  return { rows, skipped };
}

// --- BAI2 ---------------------------------------------------------------------------------

// Number of funds-availability fields that follow the funds type in a 16 record.
function fundsExtras(type, fields, at) {
  if (type === 'V') return 2;
  if (type === 'S') return 3;
  if (type === 'D') { const n = Number(fields[at]); return Number.isInteger(n) ? 1 + 2 * n : 1; }
  return 0;
}

export function convertBai2(content, { referenceField = 'auto', pattern = null, includeDebits = true } = {}) {
  const lines = String(content).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('01,')) return { error: 'This is not a BAI2 file: it must start with a 01 file header.' };

  // Join each record with its 88 continuations first, so field positions are reliable.
  const records = [];
  for (const line of lines) {
    if (line.startsWith('88,') && records.length) {
      // A "/" ends a complete field, so the continuation starts the next field; without it,
      // the continuation carries on the 16 record's free-text field.
      const prev = records[records.length - 1];
      const joiner = prev.code === '16' && !prev.text.endsWith('/') ? ' ' : ',';
      prev.text = prev.text.replace(/\/$/, '') + joiner + line.slice(3).replace(/\/$/, '');
    } else {
      records.push({ code: line.slice(0, 2), text: line });
    }
  }

  const rows = [];
  const skipped = emptySkips();
  let groupDate = '', groupCurrency = 'USD', accountCurrency = '', n = 0;
  for (const rec of records) {
    if (rec.code === '02') {
      const f = rec.text.replace(/\/$/, '').split(',');
      const d = f[4] || '';
      groupDate = /^\d{6}$/.test(d) ? '20' + d.slice(0, 2) + '-' + d.slice(2, 4) + '-' + d.slice(4, 6) : '';
      groupCurrency = f[6] || 'USD';
    } else if (rec.code === '03') {
      accountCurrency = rec.text.replace(/\/$/, '').split(',')[2] || '';
    } else if (rec.code === '16') {
      n++;
      const f = rec.text.split(',');
      const type = Number(f[1]);
      // 100-399 are credits and 400-699 debits. Other codes (loan detail, bank-specific 9xx)
      // have no agreed direction, so they are counted and left out rather than guessed.
      const credit = type >= 100 && type <= 399, debit = type >= 400 && type <= 699;
      if (!credit && !debit) { skipped.unclassified++; continue; }
      if (debit && !includeDebits) { skipped.debits++; continue; }
      const funds = f[3] || '';
      const at = 4 + fundsExtras(funds, f, 4);
      const bankRef = (f[at] || '').replace(/\/$/, '');
      const customerRef = (f[at + 1] || '').replace(/\/$/, '');
      const txText = f.slice(at + 2).join(',').replace(/\/$/, '');
      const amount = (f[2] || '').trim();
      // BAI2 amounts are unsigned whole numbers with two implied decimals for USD: cents.
      if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) { skipped.unreadable++; continue; }
      const payout = pickReference({ bankRef, customerRef, text: txText }, 'bai2', referenceField, pattern);
      if (payout === null) { skipped.unreferenced++; continue; }
      const signed = debit ? -Number(amount) : Number(amount);
      rows.push({
        id: bankRef || 'bai2-' + n,
        payout,
        currency: accountCurrency || groupCurrency,
        date: groupDate,
        gross_cents: signed,
        description: clean(describe(signed, txText)),
      });
    }
  }
  if (!n) return { error: 'No transaction detail (16) records were found in this BAI2 file.' };
  return { rows, skipped };
}

// --- Shared -------------------------------------------------------------------------------

// Plain RFC 4180 quoting. Not csvCell: that adds a spreadsheet-safety apostrophe, which
// would change the data the server receives.
const quote = v => (/[",\r\n]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v);
export function rowsToCSV(rows) {
  return [CSV_HEADER.join(','), ...rows.map(r => [r.id, r.payout, r.currency, r.date, String(r.gross_cents), '0', r.description].map(v => quote(String(v))).join(','))].join('\n') + '\n';
}

// One entry point for the import screen: CSV passes through untouched; statements convert.
export function prepareImport(content, { referenceField = 'auto', pattern = '', includeDebits = true, parseXml } = {}) {
  const format = detectFormat(content);
  if (format === 'csv') return { format, converted: false, csv: content };
  if (format === 'xml') return { format, converted: false, error: 'This XML file is not an ISO 20022 camt.052, camt.053, or camt.054 statement.' };
  const compiled = compilePattern(pattern);
  if (compiled.error) return { format, converted: true, error: compiled.error };
  const options = { referenceField, pattern: compiled.pattern, includeDebits, parseXml };
  const result = formatFamily(format) === 'camt' ? convertCamt(content, options) : convertBai2(content, options);
  if (result.error) return { format, converted: true, error: result.error };
  if (!result.rows.length) return { format, converted: true, skipped: result.skipped, error: 'Nothing in this statement can be imported: ' + skipSummary(result.skipped) + '.' };
  const debits = result.rows.filter(r => r.gross_cents < 0).length;
  return { format, converted: true, csv: rowsToCSV(result.rows), credits: result.rows.length - debits, debits, skipped: result.skipped };
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
// "2 debits skipped, 1 pending entry skipped" for the import banner and errors.
export function skipSummary(skipped) {
  const parts = [];
  if (skipped.debits) parts.push(plural(skipped.debits, 'debit', 'debits') + ' skipped');
  if (skipped.unreferenced) parts.push(plural(skipped.unreferenced, 'entry', 'entries') + ' without a matching reference skipped');
  if (skipped.pending) parts.push(plural(skipped.pending, 'pending entry', 'pending entries') + ' skipped');
  if (skipped.unclassified) parts.push(plural(skipped.unclassified, 'entry', 'entries') + ' with no credit or debit direction skipped');
  if (skipped.unreadable) parts.push(plural(skipped.unreadable, 'entry', 'entries') + ' with an unreadable amount skipped');
  return parts.join(', ') || 'no entries';
}
