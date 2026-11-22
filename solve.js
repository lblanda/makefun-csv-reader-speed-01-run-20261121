// csv-reader-speed-01: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// Same answers as csv-reader 1.0.0's readCsv on every input, reached a faster
// way: the reference walks the text one character at a time and builds each
// field a character at a time; this reader jumps from terminator to terminator
// with indexOf (a C++ memchr in V8) and slices whole fields at once, only
// slowing to a character walk for the rare broken pieces (a stray CR, a line
// break inside quotes, a doubled quote).
//
// The policy it reproduces, exactly as the reference states it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote
//     that never closes is a literal character, and the text after it is read
//     again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts
//     on (every LF, CRLF and lone CR inside a quoted field counted), row its
//     record's index in rows (null for the header), in the order met, a field's
//     quote_junk when the field ends and a record's short_row or long_row when
//     the record ends.
//
// Verified on the kit's practice set: 6/6 cases identical to csv-reader 1.0.0,
// and answers.json byte-identical to the house baseline's output.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const LF = 10;
const CR = 13;
const COMMA = 44;
const QUOTE = 34;

// A CR not followed by LF, anywhere in the text (inside quotes it becomes LF
// instead of an error, so this test is only a fast-path gate, never a verdict).
const STRAY_CR_RE = /\r(?!\n)/;
// Inside a quoted field, a CRLF or a lone CR each becomes one LF.
const CR_TO_LF_RE = /\r\n?/g;
const LF_RE = /\n/g;

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // True when the text holds a CR not followed by LF. When false, every CR in
  // the text is part of a CRLF, so an unquoted field can only meet one as its
  // line break, and a quoted field only as a line break inside it.
  const hasStrayCR = STRAY_CR_RE.test(text);

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how it
  // ended; the caller reads `value.length` against the value it passed in to
  // tell whether any character was kept (quote_junk counts kept characters).
  function readUnquoted(value) {
    const start = pos;
    const cIdx = text.indexOf(',', pos);
    const nIdx = text.indexOf('\n', pos);
    let end;
    let ended;
    if (nIdx !== -1 && (cIdx === -1 || nIdx < cIdx)) {
      end = nIdx;
      ended = ENDED_BREAK;
    } else if (cIdx !== -1) {
      end = cIdx;
      ended = ENDED_COMMA;
    } else {
      end = len;
      ended = ENDED_END;
    }
    if (hasStrayCR) {
      const rIdx = text.indexOf('\r', pos);
      if (rIdx !== -1 && rIdx < end) {
        // A CR sits before the terminator: walk just this stretch, dropping
        // each stray CR (and its error) and stopping at a CRLF line break.
        let acc = value;
        let seg = pos;
        let i = pos;
        while (i < end) {
          if (text.charCodeAt(i) === CR) {
            if (i > seg) acc += text.slice(seg, i);
            if (ended === ENDED_BREAK && i === end - 1) {
              pos = end + 1;
              line += 1;
              return { value: acc, ended: ENDED_BREAK };
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            i += 1;
            seg = i;
            continue;
          }
          i += 1;
        }
        if (end > seg) acc += text.slice(seg, end);
        if (ended === ENDED_BREAK) {
          pos = end + 1;
          line += 1;
        } else if (ended === ENDED_COMMA) {
          pos = end + 1;
        } else {
          pos = end;
        }
        return { value: acc, ended };
      }
    }
    // No CR before the terminator: the field is one slice. A CR right before
    // the line break is the CRLF half of it, not part of the field.
    if (ended === ENDED_BREAK && end > start && text.charCodeAt(end - 1) === CR) {
      value += text.slice(start, end - 1);
      pos = end + 1;
      line += 1;
      return { value, ended: ENDED_BREAK };
    }
    value += text.slice(start, end);
    if (ended === ENDED_BREAK) {
      pos = end + 1;
      line += 1;
    } else if (ended === ENDED_COMMA) {
      pos = end + 1;
    } else {
      pos = end;
    }
    return { value, ended };
  }

  // The text of a quoted segment, [a, b), with each CRLF or lone CR inside it
  // read as one LF, and `line` moved past every line break it held.
  function quotedSegment(a, b) {
    const nIdx = text.indexOf('\n', a);
    if (nIdx !== -1 && nIdx < b) return convertSegment(a, b);
    const rIdx = text.indexOf('\r', a);
    if (rIdx !== -1 && rIdx < b) return convertSegment(a, b);
    return text.slice(a, b);
  }

  function convertSegment(a, b) {
    const seg = text.slice(a, b).replace(CR_TO_LF_RE, '\n');
    const breaks = seg.match(LF_RE);
    if (breaks !== null) line += breaks.length;
    return seg;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = pos + 1;
    let value;
    for (;;) {
      const q = text.indexOf('"', segStart);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === QUOTE) {
        // A doubled quote: one quote in the value, and the field goes on.
        const seg = quotedSegment(segStart, q);
        if (parts === null) parts = [seg, '"'];
        else parts.push(seg, '"');
        segStart = q + 2;
        continue;
      }
      const seg = quotedSegment(segStart, q);
      if (parts === null) value = seg;
      else {
        parts.push(seg);
        value = parts.join('');
      }
      pos = q + 1;
      break;
    }
    if (pos >= len) return { value, ended: ENDED_END };
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      return { value, ended: ENDED_COMMA };
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      return { value, ended: ENDED_BREAK };
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      return { value, ended: ENDED_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.value.length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === ENDED_COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
