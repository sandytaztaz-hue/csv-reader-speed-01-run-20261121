// csv-reader-speed-01-run-20261121 — a fast drop-in for csv-reader 1.0.0.
//
// Written from CSV_SPEC.md only. The behaviour contract (quoting, stray CRs,
// unterminated quotes, quote junk, short/long rows, blank-line skipping, BOM
// handling, line/row bookkeeping) is implemented exactly as specified there.
//
// Speed: the common path never loops character-by-character in JS. It jumps
// with String.indexOf to the next delimiter and slices fields in bulk;
// concatenation and line counting happen only on the rare paths (a stray CR,
// "" escapes, or a newline inside a quoted field).

// Field endings.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;

  let pos = 0; // next character index (0-based)
  let line = 1; // 1-based line of pos
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1; // drop a leading BOM

  let columns = null;
  const rows = [];
  const errors = [];
  let width = -1; // unset until the first kept record

  // Line/row of the record currently being parsed; errors raised while
  // parsing its fields are stamped with these.
  let curLine = 1;
  let curRow = null;

  function pushError(code, extra) {
    const e = { code, line: curLine, row: curRow };
    if (code === 'short_row') e.fields = extra;
    else if (code === 'long_row') e.extra = extra;
    errors.push(e);
  }

  // --- Unquoted field -------------------------------------------------------
  // Starts at pos, initial value v0. Returns { value, end, quoted, added }
  // where added = characters appended during THIS scan (not counting v0).
  function unquotedField(v0) {
    let value = v0;
    let added = 0;
    let p = pos;
    for (;;) {
      const ci = text.indexOf(',', p);
      const ni = text.indexOf('\n', p);
      const ri = text.indexOf('\r', p);
      let m = -1;
      let kind = 0; // 0 = end of text, 1 = comma, 2 = LF, 3 = CR
      if (ci !== -1) { m = ci; kind = 1; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; kind = 2; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; kind = 3; }
      if (m === -1) {
        const piece = text.slice(p);
        if (piece.length !== 0) { value += piece; added += piece.length; }
        pos = len;
        return { value, end: END, quoted: false, added };
      }
      if (kind === 1) {
        if (m !== p) { value += text.slice(p, m); added += m - p; }
        pos = m + 1;
        return { value, end: COMMA, quoted: false, added };
      }
      if (kind === 2) {
        if (m !== p) { value += text.slice(p, m); added += m - p; }
        pos = m + 1;
        line++;
        return { value, end: LINE_BREAK, quoted: false, added };
      }
      // kind === 3: a CR.
      if (text.charCodeAt(m + 1) === 10) {
        // CRLF: one line break.
        if (m !== p) { value += text.slice(p, m); added += m - p; }
        pos = m + 2;
        line++;
        return { value, end: LINE_BREAK, quoted: false, added };
      }
      // Lone CR outside quotes: an error, dropped, scanning continues.
      pushError('stray_cr');
      if (m !== p) { value += text.slice(p, m); added += m - p; }
      p = m + 1;
    }
  }

  // --- Quoted field ---------------------------------------------------------
  // Opening '"' is at pos. Returns { value, end, quoted } (quoted is true
  // except on the unterminated re-read path, which re-reads as unquoted).
  function quotedField() {
    const open = pos;
    const openLine = line;
    pos++;
    const start = pos;
    let cur = pos;
    const segs = [];
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // Unterminated: rewind and re-read as unquoted, opening quote literal.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return unquotedField('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // "" escape: keep one quote, keep scanning.
        segs.push(text.slice(cur, q + 1));
        cur = q + 2;
        continue;
      }
      // Closing quote at q.
      segs.push(text.slice(cur, q));
      close = q;
      break;
    }
    // The raw span text[start..close) may still hold CRLF / lone CRs: inside
    // quotes each of those is one LF in the value, and one line counted.
    let value;
    const ni = text.indexOf('\n', start);
    const ri = text.indexOf('\r', start);
    const hasBreak = (ni !== -1 && ni < close) || (ri !== -1 && ri < close);
    if (segs.length === 1) {
      value = segs[0];
    } else {
      value = segs.join('');
    }
    if (hasBreak) {
      line += countBreaks(start, close);
      value = value.replace(/\r\n?/g, '\n');
    }
    pos = close + 1;
    if (pos >= len) return { value, end: END, quoted: true };
    const c = text.charCodeAt(pos);
    if (c === 44) { // ','
      pos++;
      return { value, end: COMMA, quoted: true };
    }
    if (c === 10) { // LF
      pos++;
      line++;
      return { value, end: LINE_BREAK, quoted: true };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { // CRLF
      pos += 2;
      line++;
      return { value, end: LINE_BREAK, quoted: true };
    }
    // Junk after the closing quote: read it as an unquoted field on top of
    // the quoted value. Any stray_cr errors inside the junk are pushed by
    // that read, before quote_junk below.
    const junk = unquotedField(value);
    if (junk.added > 0) pushError('quote_junk');
    return { value: junk.value, end: junk.end, quoted: true };
  }

  // Count line breaks in text[a..b): every LF, every CRLF as one, every lone
  // CR as one. Only called for quoted spans already known to hold CR/LF
  // (or escapes), i.e. after the closing quote is confirmed.
  function countBreaks(a, b) {
    let n = 0;
    let i = a;
    for (;;) {
      const ni = text.indexOf('\n', i);
      if (ni === -1 || ni >= b) break;
      n++;
      i = ni + 1;
    }
    i = a;
    for (;;) {
      const ri = text.indexOf('\r', i);
      if (ri === -1 || ri >= b) break;
      if (text.charCodeAt(ri + 1) !== 10) n++;
      i = ri + 1;
    }
    return n;
  }

  function parseField() {
    if (text.charCodeAt(pos) === 34) return quotedField();
    return unquotedField('');
  }

  // --- Main loop ------------------------------------------------------------
  for (;;) {
    // 1. Skip empty lines (LF, or CRLF). A lone CR is NOT skipped here.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    // 2. End of text?
    if (pos >= len) break;

    // 3. Stamp this record's line/row for its errors.
    curLine = line;
    curRow = (header && columns === null) ? null : rows.length;

    // 4. Parse fields, one at a time.
    const fields = [];
    let firstQuoted = false;
    let end;
    do {
      const f = parseField();
      if (fields.length === 0) firstQuoted = f.quoted;
      fields.push(f.value);
      end = f.end;
    } while (end === COMMA);

    // 5. A lone unquoted empty field is not a record at all.
    if (fields.length === 1 && fields[0] === '' && !firstQuoted) {
      continue; // errors already pushed (e.g. stray_cr) stay
    }

    // 6. Width comes from the first kept record.
    if (width === -1) width = fields.length;

    // 7. Header record: becomes columns, never a row, never short/long.
    if (header && columns === null) {
      columns = fields;
      continue;
    }

    // 8/9. Short / long rows (pushed when the record ends, after all its
    // field-level errors).
    if (fields.length < width) {
      pushError('short_row', fields.length);
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      pushError('long_row', fields.slice(width));
      fields.length = width;
    }

    // 10. Keep the row.
    rows.push(fields);
  }

  // 11. Header with no record at all reads as [].
  if (header && columns === null) columns = [];

  return { columns, rows, errors };
}
