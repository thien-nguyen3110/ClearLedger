// RFC 4180 CSV parsing for the import preview. This is a format check only: the server
// (backend/domain.go parseCSV) remains the authoritative parser and validator.

// Parses CSV text into an array of rows (arrays of strings). Handles quoted fields,
// embedded commas and newlines, and doubled-quote escaping ("" -> "). Does not treat a
// bare comma inside a quoted field as a delimiter, which a naive `line.split(',')` would.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // ignore; paired \n below ends the row
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

const REQUIRED_HEADER = ['id', 'payout', 'currency', 'date', 'gross_cents', 'fee_cents', 'description'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ERRORS_SHOWN = 20;

// Mirrors the server's validation rules (backend/domain.go parseCSV) closely enough to
// give the user useful early feedback. It never decides what the server will accept.
export function previewCSV(source, text) {
  const rows = parseCSV(text);
  if (rows.length === 0) {
    return { header: null, validRows: 0, totalRows: 0, errors: ['CSV header missing'], sample: [] };
  }
  const [header, ...dataRows] = rows;
  const errors = [];
  if (header.join(',') !== REQUIRED_HEADER.join(',')) {
    errors.push('CSV header must be ' + REQUIRED_HEADER.join(','));
    return { header, validRows: 0, totalRows: dataRows.length, errors, sample: [] };
  }
  let validRows = 0;
  const sample = [];
  dataRows.forEach((row, idx) => {
    const line = idx + 2;
    const push = msg => { if (errors.length < MAX_ERRORS_SHOWN) errors.push('Row ' + line + ': ' + msg); };
    if (row.length !== REQUIRED_HEADER.length) {
      push('expected ' + REQUIRED_HEADER.length + ' fields, found ' + row.length);
      return;
    }
    const [id, payout, currency, date, gross, fee, description] = row.map(v => v.trim());
    let ok = true;
    if (!id || !payout || id.length > 100 || payout.length > 100) { push('id and payout are required, max 100 characters'); ok = false; }
    if (currency !== 'USD') { push('this release supports USD only'); ok = false; }
    if (!DATE_RE.test(date)) { push('date must be YYYY-MM-DD'); ok = false; }
    const grossNum = Number(gross);
    if (!/^-?\d+$/.test(gross) || !Number.isSafeInteger(grossNum)) { push('invalid gross integer cents'); ok = false; }
    const feeNum = Number(fee);
    if (!/^\d+$/.test(fee) || !Number.isSafeInteger(feeNum)) { push('invalid fee integer cents'); ok = false; }
    else if (source === 'bank' && feeNum !== 0) { push('bank fee_cents must be 0'); ok = false; }
    if (description.length > 1000) { push('description too long'); ok = false; }
    if (ok) {
      validRows++;
      if (sample.length < 5) sample.push({ id, payout, date, gross_cents: grossNum, fee_cents: feeNum, description });
    }
  });
  return { header, validRows, totalRows: dataRows.length, errors, sample };
}
