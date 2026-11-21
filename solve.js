// CSV reader v3 — written fresh from CSV_SPEC.md + the v3 design brief.
// Three tiers: (1) clean single-line records split in bulk; (2) quoted
// records parsed field-by-field straight from the text with indexOf scans
// (the hot path — no split/merge, no segment slicing); (3) a careful
// field-by-field parser for stray CRs, unterminated quotes and quote junk.
// Tiers 1-2 never loop character-by-character over the common path.
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const rows = [];
  const errors = [];
  let columns = null;
  let width = 0;
  let widthSet = false;
  let pos = 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Unquoted field starting at pos, initial value v0 ('' normally, '"'
  // only for the unterminated-quote re-read). Returns [value, ending,
  // added]: ending 0 = comma, 1 = line break, 2 = end of text. `added`
  // counts only characters appended during this scan (not v0).
  function readUnquoted(v0) {
    let value = v0;
    let added = 0;
    while (pos < len) {
      const c1 = text.indexOf(',', pos);
      const c2 = text.indexOf('\n', pos);
      const c3 = text.indexOf('\r', pos);
      let next = len;
      if (c1 !== -1 && c1 < next) next = c1;
      if (c2 !== -1 && c2 < next) next = c2;
      if (c3 !== -1 && c3 < next) next = c3;
      if (next > pos) {
        value += text.slice(pos, next);
        added += next - pos;
        pos = next;
      }
      if (pos >= len) break;
      const ch = text.charCodeAt(pos);
      if (ch === 44) {
        pos++;
        return [value, 0, added];
      }
      if (ch === 10) {
        pos++;
        line++;
        return [value, 1, added];
      }
      if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
        return [value, 1, added];
      }
      // CR not followed by LF: stray, drop it, keep scanning.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos++;
    }
    return [value, 2, added];
  }

  // Quoted field (opening '"' at pos). Returns [value, ending, added]
  // with the same endings. On unterminated quote it resets pos/line to
  // just after the opening quote and re-reads as unquoted with v0 '"'.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos++;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const n1 = text.indexOf('\n', pos);
      const n2 = text.indexOf('\r', pos);
      let bad = -1;
      if (n1 !== -1 && n1 < q) bad = n1;
      if (n2 !== -1 && n2 < q && (bad === -1 || n2 < bad)) bad = n2;
      if (bad === -1) {
        if (q > pos) value += text.slice(pos, q);
        pos = q;
        if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
          value += '"';
          pos = q + 2;
          continue;
        }
        pos = q + 1;
        break;
      }
      // Newline(s) before the closing quote: walk [pos, q), turning every
      // CR, LF and CRLF into one LF and counting lines.
      let i = pos;
      while (i < q) {
        const ch = text.charCodeAt(i);
        if (ch === 13) {
          value += '\n';
          line++;
          i += (i + 1 < q && text.charCodeAt(i + 1) === 10) ? 2 : 1;
        } else if (ch === 10) {
          value += '\n';
          line++;
          i++;
        } else {
          let j = i + 1;
          while (j < q) {
            const c = text.charCodeAt(j);
            if (c === 13 || c === 10) break;
            j++;
          }
          value += text.slice(i, j);
          i = j;
        }
      }
      pos = q;
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      break;
    }
    if (pos >= len) return [value, 2, 0];
    const ch = text.charCodeAt(pos);
    if (ch === 44) {
      pos++;
      return [value, 0, 0];
    }
    if (ch === 10) {
      pos++;
      line++;
      return [value, 1, 0];
    }
    if (ch === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      return [value, 1, 0];
    }
    // Junk after the closing quote: read it as unquoted; quote_junk only
    // if that read actually added characters (stray_cr inside junk is
    // pushed first, by the junk read itself).
    const r = readUnquoted(value);
    if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return r;
  }

  // Tier 3: slow record, field by field. Returns {fields, firstQuoted}.
  function parseRecordSlow() {
    const fields = [];
    let firstQuoted = false;
    let first = true;
    for (;;) {
      let r;
      let quoted = false;
      if (pos < len && text.charCodeAt(pos) === 34) {
        quoted = true;
        r = readQuoted();
      } else {
        r = readUnquoted('');
      }
      if (first) firstQuoted = quoted;
      first = false;
      fields.push(r[0]);
      if (r[1] !== 0) break;
    }
    return { fields: fields, firstQuoted: firstQuoted };
  }

  // Count line breaks inside a quoted span: each LF counts 1, each lone
  // CR (not followed by LF) counts 1, a CRLF counts 1 via its LF.
  function countLinesInSpan(raw) {
    let n = 0;
    let i = raw.indexOf('\n');
    while (i !== -1) {
      n++;
      i = raw.indexOf('\n', i + 1);
    }
    let j = raw.indexOf('\r');
    while (j !== -1) {
      if (raw.charCodeAt(j + 1) !== 10) n++;
      j = raw.indexOf('\r', j + 1);
    }
    return n;
  }

  // Tier 2: parse one record field-by-field directly from `text` at pos.
  // Returns {fields, firstQuoted}, or null when the record needs Tier 3
  // (unterminated quote, junk after a closing quote, or a stray CR inside
  // an unquoted field). Pushes no errors itself; on null the caller rolls
  // pos/line back to the record start and runs Tier 3.
  function parseRecordTier2() {
    const fields = [];
    let firstQuoted = false;
    let first = true;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        // Quoted field: find the closing quote, skipping "" escapes.
        let q = pos + 1;
        let hasEsc = false;
        let close = -1;
        for (;;) {
          close = text.indexOf('"', q);
          if (close === -1) return null;
          if (close + 1 < len && text.charCodeAt(close + 1) === 34) {
            hasEsc = true;
            q = close + 2;
            continue;
          }
          break;
        }
        const raw = text.slice(pos + 1, close);
        let value;
        if (raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) {
          line += countLinesInSpan(raw);
          value = raw.replace(/\r\n?/g, '\n');
          if (hasEsc) value = value.replaceAll('""', '"');
        } else {
          value = hasEsc ? raw.replaceAll('""', '"') : raw;
        }
        if (first) firstQuoted = true;
        first = false;
        pos = close + 1;
        if (pos >= len) {
          fields.push(value);
          return { fields: fields, firstQuoted: firstQuoted };
        }
        const d = text.charCodeAt(pos);
        if (d === 44) {
          fields.push(value);
          pos++;
          continue;
        }
        if (d === 10) {
          fields.push(value);
          pos++;
          line++;
          return { fields: fields, firstQuoted: firstQuoted };
        }
        if (d === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          fields.push(value);
          pos += 2;
          line++;
          return { fields: fields, firstQuoted: firstQuoted };
        }
        return null; // junk after the closing quote
      }
      // Unquoted field: next ',' vs next '\n', whichever is nearer.
      const c = text.indexOf(',', pos);
      const n = text.indexOf('\n', pos);
      let end2;
      let isComma;
      if (c !== -1 && (n === -1 || c < n)) {
        end2 = c;
        isComma = true;
      } else if (n !== -1) {
        end2 = n;
        isComma = false;
      } else {
        end2 = len;
        isComma = false;
      }
      let value;
      if (!isComma && n !== -1 && end2 > pos && text.charCodeAt(end2 - 1) === 13) {
        value = text.slice(pos, end2 - 1); // CRLF line ending, not a stray CR
      } else {
        value = text.slice(pos, end2);
      }
      if (value.indexOf('\r') !== -1) return null; // stray CR -> Tier 3
      fields.push(value);
      first = false;
      if (isComma) {
        pos = end2 + 1;
        continue;
      }
      if (n !== -1) {
        pos = end2 + 1;
        line++;
      } else {
        pos = len;
      }
      return { fields: fields, firstQuoted: firstQuoted };
    }
  }

  function emit(fields, skip) {
    if (skip) return;
    if (widthSet && !(header && columns === null) && fields.length === width) {
      rows.push(fields);
      return;
    }
    if (!widthSet) {
      width = fields.length;
      widthSet = true;
    }
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: extra });
      fields.length = width;
    }
    rows.push(fields);
  }

  for (;;) {
    // Skip empty lines: LF, or CRLF. A lone CR is NOT skipped here.
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) {
        pos++;
        line++;
      } else if (ch === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;
    recordLine = line;
    recordRow = (header && columns === null) ? null : rows.length;

    // Inspect the first line: is there a quote in it? (A quote means the
    // record needs Tier 2; a stray CR inside a quoted field is NOT stray —
    // Tier 2 normalises it — so no separate CR scan is needed here.)
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const qPos = text.indexOf('"', pos);
    const hasQuote = qPos !== -1 && qPos < end;

    if (!hasQuote) {
      // No quote in this line: Tier 1 if the line holds no stray CR,
      // else Tier 3. The only legitimate CR is the CRLF ending, already
      // excluded from seg, so any CR left in seg is stray.
      let effEnd = end;
      if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) effEnd = end - 1;
      const seg = text.slice(pos, effEnd);
      if (seg.indexOf('\r') === -1) {
        // Tier 1: clean single-line record, split in bulk.
        const fields = seg.split(',');
        if (nl === -1) pos = len;
        else {
          pos = nl + 1;
          line++;
        }
        emit(fields, fields.length === 1 && fields[0] === '');
        continue;
      }
      const s = parseRecordSlow();
      emit(s.fields, s.fields.length === 1 && s.fields[0] === '' && !s.firstQuoted);
      continue;
    }

    // Tier 2: quoted record, indexOf field scan. Roll back to Tier 3 on null.
    const savePos = pos;
    const saveLine = line;
    const t2 = parseRecordTier2();
    if (t2 !== null) {
      emit(t2.fields, t2.fields.length === 1 && t2.fields[0] === '' && !t2.firstQuoted);
      continue;
    }
    pos = savePos;
    line = saveLine;
    const s = parseRecordSlow();
    emit(s.fields, s.fields.length === 1 && s.fields[0] === '' && !s.firstQuoted);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows: rows, errors: errors };
}
