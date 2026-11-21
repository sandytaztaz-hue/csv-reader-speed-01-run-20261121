// Fresh CSV reader, written from CSV_SPEC.md only.
// Three tiers: (1) clean single-line records split in bulk with
// String.split; (2) records with quotes parsed line-by-line with split(',')
// and piece merging (quoted fields spanning commas/newlines are rejoined);
// (3) a careful field-by-field parser for records with stray CRs inside
// fields or unterminated quotes. Tiers 1-2 never loop char-by-char.
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
  let slowSingleEmpty = false;
  let lineSingleEmpty = false;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  function stray() {
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
  }
  function junkErr() {
    errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Unquoted field. Returns [value, ending, added]: ending 0 = comma,
  // 1 = line break, 2 = end of text. `added` counts only characters
  // appended during this scan (not v0).
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
      stray();
      pos++;
    }
    return [value, 2, added];
  }

  // Quoted field. Returns [value, ending, added] with the same endings.
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
    const r = readUnquoted(value);
    if (r[2] > 0) junkErr();
    return r;
  }

  // Slow record: field by field.
  function parseRecordSlow() {
    const fields = [];
    let first = true;
    slowSingleEmpty = false;
    for (;;) {
      let r;
      let quoted = false;
      if (pos < len && text.charCodeAt(pos) === 34) {
        quoted = true;
        r = readQuoted();
      } else {
        r = readUnquoted('');
      }
      fields.push(r[0]);
      if (first && fields.length === 1 && !quoted && r[0] === '') slowSingleEmpty = true;
      else if (fields.length > 1) slowSingleEmpty = false;
      first = false;
      if (r[1] !== 0) return fields;
    }
  }


  // Line-based record parse. Returns fields, or null when the record needs
  // the slow parser (inner CR in a line, or a quote unterminated at EOF).
  // Caller rolls pos/line/errors back to the record start on null.
  function parseRecordLine(firstSeg, firstNl) {
    const fields = [];
    let inQuote = false;
    let qval = '';
    let firstWasQuoted = false;
    let isFirst = true;
    lineSingleEmpty = false;
    let seg = firstSeg;
    let nl = firstNl;
    let firstLine = true;
    for (;;) {
      if (!firstLine) {
        if (pos >= len) return null;
        nl = text.indexOf('\n', pos);
        const end = nl === -1 ? len : nl;
        let effEnd = end;
        if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) effEnd = end - 1;
        seg = text.slice(pos, effEnd);
        if (seg.indexOf('\r') !== -1) return null;
      }
      firstLine = false;
      const pieces = seg.split(',');
      for (let pi = 0; pi < pieces.length; pi++) {
        const p = pieces[pi];
        if (inQuote) {
          if (pi > 0) qval += ',';
          let k = p.indexOf('"', 0);
          let esc = false;
          while (k !== -1 && k + 1 < p.length && p.charCodeAt(k + 1) === 34) { esc = true; k = p.indexOf('"', k + 2); }
          if (k === -1) {
            qval += esc ? p.replaceAll('""', '"') : p;
          } else {
            let chunk = p.slice(0, k);
            if (esc) chunk = chunk.replaceAll('""', '"');
            qval += chunk;
            if (p.length - k - 1 > 0) {
              qval += p.slice(k + 1);
              junkErr();
            }
            fields.push(qval);
            qval = '';
            inQuote = false;
            isFirst = false;
          }
        } else if (p.length > 0 && p.charCodeAt(0) === 34) {
          if (isFirst) firstWasQuoted = true;
          let k = p.indexOf('"', 1);
          let esc = false;
          while (k !== -1 && k + 1 < p.length && p.charCodeAt(k + 1) === 34) { esc = true; k = p.indexOf('"', k + 2); }
          if (k === -1) {
            qval = p.slice(1);
            if (esc) qval = qval.replaceAll('""', '"');
            inQuote = true;
          } else {
            let val = p.slice(1, k);
            if (esc) val = val.replaceAll('""', '"');
            if (p.length - k - 1 > 0) {
              val += p.slice(k + 1);
              junkErr();
            }
            fields.push(val);
            isFirst = false;
          }
        } else {
          fields.push(p);
          isFirst = false;
        }
      }
      if (nl === -1) {
        pos = len;
        if (inQuote) return null;
        break;
      }
      pos = nl + 1;
      line++;
      if (inQuote) {
        qval += '\n';
        continue;
      }
      break;
    }
    lineSingleEmpty = fields.length === 1 && fields[0] === '' && !firstWasQuoted;
    return fields;
  }

  function emit(fields, skip) {
    if (skip) return;
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

    // Tier 1: clean single-line record.
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    let effEnd = end;
    if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) effEnd = end - 1;
    const seg = text.slice(pos, effEnd);
    const hasQuote = seg.indexOf('"') !== -1;
    const hasCR = seg.indexOf('\r') !== -1;
    if (!hasQuote && !hasCR) {
      const fields = seg.split(',');
      if (nl === -1) pos = len;
      else {
        pos = nl + 1;
        line++;
      }
      emit(fields, fields.length === 1 && fields[0] === '');
      continue;
    }

    // Tier 2: line-based quoted parse, with rollback to tier 3.
    // A stray CR inside the first line goes straight to tier 3.
    if (hasCR) {
      const fields = parseRecordSlow();
      emit(fields, slowSingleEmpty && fields.length === 1);
      continue;
    }
    const savePos = pos;
    const saveLine = line;
    const saveErr = errors.length;
    const lf = parseRecordLine(seg, nl);
    if (lf !== null) {
      emit(lf, lineSingleEmpty);
      continue;
    }
    pos = savePos;
    line = saveLine;
    errors.length = saveErr;
    const fields = parseRecordSlow();
    emit(fields, slowSingleEmpty && fields.length === 1);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows: rows, errors: errors };
}
