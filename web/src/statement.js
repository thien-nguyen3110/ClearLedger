// Bank statement conversion for the import screen: ISO 20022 camt.052/053/054 XML and BAI2
// files become the documented bank CSV (id,payout,currency,date,gross_cents,fee_cents,
// description) inside this browser. Only booked credits are kept, because the CSV's bank rows
// are deposits. The converted CSV then goes through the same format preview and the same
// server validation as a hand-made file; nothing here decides what the server accepts.

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

function pickReference(fields, family, choice, pattern) {
  const order = choice === 'auto' ? AUTO_ORDER[family] : [choice];
  let value = '';
  for (const name of order) {
    const v = (fields[name] || '').trim();
    if (v && v.toUpperCase() !== 'NOTPROVIDED') { value = v; break; }
  }
  if (pattern && value) {
    const m = value.match(pattern);
    value = m ? m[0] : '';
  }
  return value;
}

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

export function convertCamt(xml, { referenceField = 'auto', pattern = null, parseXml } = {}) {
  const parse = parseXml || (s => new DOMParser().parseFromString(s, 'application/xml'));
  const doc = parse(String(xml).replace(/^﻿/, ''));
  if (!doc || doc.getElementsByTagName('parsererror').length) return { error: 'This file is not well-formed XML.' };
  const entries = [...doc.getElementsByTagNameNS('*', 'Ntry')];
  if (!entries.length) return { error: 'No statement entries (Ntry) were found in this file.' };

  const rows = [];
  const skipped = { debits: 0, pending: 0, unreadable: 0 };
  entries.forEach((ntry, n) => {
    if (text(ntry, 'CdtDbtInd') !== 'CRDT') { skipped.debits++; return; }
    const status = text(ntry, 'Sts');
    if (status && status !== 'BOOK') { skipped.pending++; return; }
    const date = (text(ntry, 'BookgDt', 'Dt') || text(ntry, 'BookgDt', 'DtTm') || text(ntry, 'ValDt', 'Dt') || text(ntry, 'ValDt', 'DtTm')).slice(0, 10);
    const entryRef = text(ntry, 'AcctSvcrRef') || text(ntry, 'NtryRef');
    const entryInfo = text(ntry, 'AddtlNtryInf');
    const txs = kids(child(ntry, 'NtryDtls'), 'TxDtls');
    // A batch-booked entry lists each transaction with its own amount; split it so every
    // payout keeps its own deposit row. Otherwise the entry itself is one deposit.
    const split = txs.length > 1 && txs.every(tx => text(tx, 'AmtDtls', 'TxAmt', 'Amt') || text(tx, 'Amt'));
    const parts = split ? txs : [txs[0] || null];
    parts.forEach((tx, k) => {
      const amtEl = split ? (child(tx, 'AmtDtls', 'TxAmt', 'Amt') || child(tx, 'Amt')) : child(ntry, 'Amt');
      const cents = amtEl ? decimalToCents(amtEl.textContent) : null;
      if (cents === null) { skipped.unreadable++; return; }
      const fields = {
        EndToEndId: text(tx, 'Refs', 'EndToEndId'),
        Ustrd: tx ? kids(child(tx, 'RmtInf'), 'Ustrd').map(u => u.textContent.trim()).join(' ') : '',
        AcctSvcrRef: text(tx, 'Refs', 'AcctSvcrRef') || entryRef,
        AddtlNtryInf: text(tx, 'AddtlTxInf') || entryInfo,
      };
      const base = entryRef || 'camt-' + (n + 1);
      rows.push({
        id: split ? base + '-' + (k + 1) : base,
        payout: pickReference(fields, 'camt', referenceField, pattern),
        currency: amtEl.getAttribute('Ccy') || '',
        date,
        gross_cents: cents,
        description: clean(fields.AddtlNtryInf || fields.Ustrd || 'Statement credit'),
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

export function convertBai2(content, { referenceField = 'auto', pattern = null } = {}) {
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
  const skipped = { debits: 0, pending: 0, unreadable: 0 };
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
      // 100-399 are credits, 400-699 debits; 9xx codes are bank-specific and not assumed.
      if (!(type >= 100 && type <= 399)) { skipped.debits++; continue; }
      const funds = f[3] || '';
      const at = 4 + fundsExtras(funds, f, 4);
      const bankRef = (f[at] || '').replace(/\/$/, '');
      const customerRef = (f[at + 1] || '').replace(/\/$/, '');
      const txText = f.slice(at + 2).join(',').replace(/\/$/, '');
      const amount = (f[2] || '').trim();
      // BAI2 amounts are unsigned whole numbers with two implied decimals for USD: cents.
      if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) { skipped.unreadable++; continue; }
      const fields = { bankRef, customerRef, text: txText };
      rows.push({
        id: bankRef || 'bai2-' + n,
        payout: pickReference(fields, 'bai2', referenceField, pattern),
        currency: accountCurrency || groupCurrency,
        date: groupDate,
        gross_cents: Number(amount),
        description: clean(txText || 'BAI2 credit ' + type),
      });
    }
  }
  if (!rows.length && !skipped.debits && !skipped.unreadable) return { error: 'No transaction detail (16) records were found in this BAI2 file.' };
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
export function prepareImport(content, { referenceField = 'auto', pattern = '', parseXml } = {}) {
  const format = detectFormat(content);
  if (format === 'csv') return { format, converted: false, csv: content };
  if (format === 'xml') return { format, converted: false, error: 'This XML file is not an ISO 20022 camt.052, camt.053, or camt.054 statement.' };
  const compiled = compilePattern(pattern);
  if (compiled.error) return { format, converted: true, error: compiled.error };
  const family = formatFamily(format);
  const result = family === 'camt'
    ? convertCamt(content, { referenceField, pattern: compiled.pattern, parseXml })
    : convertBai2(content, { referenceField, pattern: compiled.pattern });
  if (result.error) return { format, converted: true, error: result.error };
  return { format, converted: true, csv: rowsToCSV(result.rows), rows: result.rows.length, skipped: result.skipped };
}
