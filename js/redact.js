/* AutoRedact engine: matching, page layout and drawing. No DOM access here,
   so it also runs under Node for the tests in website/tests. */
(function (root) {
  'use strict';

  const COMMON_PATTERNS = {
    'Email address': '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
    'US Social Security number': '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    'UK National Insurance number': '\\b[A-CEGHJ-PR-TW-Z]{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?[A-D]\\b',
    'UK postcode': '\\b[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}\\b',
    'UK phone number': '(?<!\\w)(?:\\+44\\s?|0)(?:\\d\\s?){9,10}(?!\\w)',
    'IBAN': '\\b[A-Z]{2}\\d{2}(?:\\s?[A-Z0-9]{4}){2,7}(?:\\s?[A-Z0-9]{1,3})?\\b',
    'Credit card number': '\\b(?:\\d[ -]?){13,16}\\b',
    'IPv4 address': '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
    'Date (YYYY-MM-DD)': '\\b\\d{4}-\\d{2}-\\d{2}\\b',
  };

  const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

  // ---- patterns ----------------------------------------------------------

  // Accept the Python syntax used by redactions.json files from the desktop tool.
  function translatePattern(pattern) {
    let source = pattern;
    let flags = '';
    const inline = /^\(\?([aiLmsux]+)\)/.exec(source);
    if (inline) {
      for (const f of 'ims') if (inline[1].includes(f)) flags += f;
      source = source.slice(inline[0].length);
    }
    source = source.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
    return { source, flags };
  }

  function compilePattern(pattern) {
    const t = translatePattern(pattern);
    try {
      return new RegExp(t.source, 'gu' + t.flags);
    } catch (e) {
      return new RegExp(t.source, 'g' + t.flags); // throws if truly invalid
    }
  }

  function validatePattern(pattern) {
    if (!pattern) return 'Pattern is empty';
    try {
      compilePattern(pattern);
      return null;
    } catch (e) {
      return e.message.replace(/^Invalid regular expression: /, '');
    }
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function cleanRules(data) {
    data = data || {};
    return {
      words: (data.words || []).map(String).filter((w) => w.trim()),
      patterns: (data.patterns || []).map(String).filter((p) => p),
    };
  }

  function withoutInvalid(rules) {
    return { words: rules.words.slice(), patterns: rules.patterns.filter((p) => !validatePattern(p)) };
  }

  // ---- matching ----------------------------------------------------------

  function bisectLeft(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  class Redactor {
    /** Throws an Error if a pattern does not compile. */
    constructor(rules, partialMatch) {
      this.compiled = [];
      for (const raw of rules.words || []) {
        const word = String(raw).trim();
        if (!word) continue;
        // Spaces in a phrase match any whitespace, including line breaks.
        let pat = word.split(/\s+/).map(escapeRegExp).join('\\s+');
        if (!partialMatch) pat = '(?<![\\p{L}\\p{N}_])' + pat + '(?![\\p{L}\\p{N}_])';
        this.compiled.push([word, new RegExp(pat, 'giu')]);
      }
      for (const p of rules.patterns || []) {
        let re;
        try {
          re = compilePattern(p);
        } catch (e) {
          throw new Error(`Invalid pattern ${p}: ${e.message}`);
        }
        this.compiled.push([p, re]);
      }
    }

    /** Matches sorted by position, overlapping matches merged. */
    findMatches(text) {
      const spans = [];
      for (const [label, re] of this.compiled) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          if (m[0].length) spans.push([m.index, m.index + m[0].length, label]);
        }
      }
      if (!spans.length) return [];
      spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

      const merged = [];
      let [cs, ce, cl] = spans[0];
      let rules = [cl];
      for (let i = 1; i < spans.length; i++) {
        const [s, e, l] = spans[i];
        if (s < ce) {
          ce = Math.max(ce, e);
          if (!rules.includes(l)) rules.push(l);
        } else {
          merged.push([cs, ce, rules]);
          cs = s; ce = e; rules = [l];
        }
      }
      merged.push([cs, ce, rules]);

      const newlines = [];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) newlines.push(i);
      return merged.map(([s, e, r]) => ({
        start: s, end: e, text: text.slice(s, e), line: bisectLeft(newlines, s) + 1, rules: r,
      }));
    }
  }

  // ---- layout ------------------------------------------------------------

  // The PDF uses the built-in Helvetica font, which only covers Windows-1252.
  const PUNCTUATION = {
    '‘': "'", '’': "'", '‚': "'", '‛': "'",
    '“': '"', '”': '"', '„': '"', '′': "'", '″': '"',
    '–': '-', '—': '-', '―': '-', '−': '-', '‐': '-', '‑': '-',
    '…': '...', '•': '*', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
    ' ': ' ', ' ': ' ', '€': 'EUR', '™': '(TM)', '​': '', '﻿': '',
  };

  function toPdfSafe(s) {
    let out = '';
    for (const ch of s) {
      if (ch in PUNCTUATION) out += PUNCTUATION[ch];
      else if (ch === '\t') out += ' ';
      else if (ch === '\n' || ch === ' ') out += ch;
      else {
        const code = ch.codePointAt(0);
        out += code < 0x20 || (code >= 0x7F && code < 0xA0) ? '' : code > 0xFF ? '?' : ch;
      }
    }
    return out;
  }

  const PARAGRAPH_BREAK = /\n(?:[ \t]*\n)+/g;

  /** Split text into paragraphs of {text, red} pieces, applying the redaction mode. */
  function buildParagraphs(text, matches, mode) {
    const ranges = [];
    let pos = 0;
    PARAGRAPH_BREAK.lastIndex = 0;
    for (const brk of text.matchAll(PARAGRAPH_BREAK)) {
      ranges.push([pos, brk.index]);
      pos = brk.index + brk[0].length;
    }
    ranges.push([pos, text.length]);

    const starts = matches.map((m) => m.start);
    const paragraphs = [];
    for (const [ps, pe] of ranges) {
      if (!text.slice(ps, pe).trim()) continue;
      const pieces = [];
      let cursor = ps;
      let i = Math.max(bisectLeft(starts, ps + 1) - 1, 0);
      for (; i < matches.length && matches[i].start < pe; i++) {
        const s = Math.max(matches[i].start, ps), e = Math.min(matches[i].end, pe);
        if (e <= s) continue;
        if (s > cursor) pieces.push({ text: text.slice(cursor, s), red: false });
        const seg = text.slice(s, e);
        // Removal modes never let the original characters into the layout.
        const shown = mode === 'replace' ? '[REDACTED]' : mode === 'blackout' ? seg.replace(/\S/g, 'X') : seg;
        pieces.push({ text: shown, red: true });
        cursor = e;
      }
      if (cursor < pe) pieces.push({ text: text.slice(cursor, pe), red: false });
      paragraphs.push(pieces);
    }
    return paragraphs;
  }

  /**
   * Lay the text out into pages of lines. measure(str) returns the width in
   * points at opts.fontSize. Coordinates are points from the top-left corner.
   */
  function layout(text, matches, opts, measure) {
    const o = Object.assign({ mode: 'highlight', pageSize: 'letter', keepLineBreaks: false,
      fontSize: 11, leading: 14, margin: 72, paragraphSpace: 12 }, opts);
    const [pageW, pageH] = PAGE_SIZES[o.pageSize] || PAGE_SIZES.letter;
    const maxW = pageW - 2 * o.margin;
    const widthCache = new Map();
    const width = (s) => {
      let w = widthCache.get(s);
      if (w === undefined) { w = measure(s); widthCache.set(s, w); }
      return w;
    };
    const spaceW = width(' ');

    const lines = []; // {items, paragraphEnd}
    let items = [];
    let x = 0;
    const pushLine = (force) => {
      if (items.length || force) lines.push({ items, paragraphEnd: false });
      items = [];
      x = 0;
    };
    const place = (str, red) => {
      const w = width(str);
      const last = items[items.length - 1];
      if (last && last.red === red) { last.text += str; last.w += w; }
      else items.push({ text: str, red, x, w });
      x += w;
    };

    for (const pieces of buildParagraphs(text, matches, o.mode)) {
      let word = [];
      let pendingSpace = null;

      const flushWord = () => {
        if (!word.length) return;
        const wordW = word.reduce((sum, c) => sum + width(c.text), 0);
        if (items.length && x + (pendingSpace ? spaceW : 0) + wordW > maxW) {
          pushLine();
          pendingSpace = null;
        }
        if (pendingSpace && items.length) place(' ', pendingSpace.red);
        pendingSpace = null;
        if (wordW <= maxW - x) {
          for (const c of word) place(c.text, c.red);
        } else {
          // Longer than a whole line: break between characters.
          for (const c of word) {
            for (const ch of c.text) {
              if (items.length && x + width(ch) > maxW) pushLine();
              place(ch, c.red);
            }
          }
        }
        word = [];
      };

      for (const piece of pieces) {
        let t = toPdfSafe(piece.text);
        if (!o.keepLineBreaks) t = t.replace(/\n/g, ' ');
        for (const tok of t.split(/(\n|[^\S\n]+)/)) {
          if (!tok) continue;
          if (tok === '\n') {
            flushWord();
            pushLine(true);
            pendingSpace = null;
          } else if (!tok.trim()) {
            flushWord();
            pendingSpace = pendingSpace ? { red: pendingSpace.red && piece.red } : { red: piece.red };
          } else {
            word.push({ text: tok, red: piece.red });
          }
        }
      }
      flushWord();
      pushLine();
      if (lines.length) lines[lines.length - 1].paragraphEnd = true;
    }

    // Paginate.
    const pages = [];
    let page = null;
    let y = 0;
    for (const line of lines) {
      if (!page || y + o.leading > pageH - o.margin) {
        page = { lines: [] };
        pages.push(page);
        y = o.margin;
      }
      page.lines.push({
        y: y + o.fontSize,
        items: line.items.map((it) => ({ text: it.text, red: it.red, x: o.margin + it.x, w: it.w })),
      });
      y += o.leading;
      if (line.paragraphEnd) y += o.paragraphSpace;
    }
    if (!pages.length) pages.push({ lines: [] });
    return { pages, pageW, pageH, fontSize: o.fontSize, mode: o.mode, highlightColor: o.highlightColor || '#FFFF00' };
  }

  function redColors(model) {
    if (model.mode === 'replace') return { fill: '#000000', text: '#FFFFFF' };
    if (model.mode === 'blackout') return { fill: '#000000', text: null }; // no text drawn at all
    return { fill: model.highlightColor, text: '#000000' };
  }

  // ---- drawing -----------------------------------------------------------

  /** Draw a layout model into a jsPDF document (unit: pt). */
  function drawPdf(doc, model) {
    const fs = model.fontSize;
    const red = redColors(model);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(fs);
    model.pages.forEach((page, i) => {
      if (i > 0) doc.addPage([model.pageW, model.pageH]);
      for (const line of page.lines) {
        for (const it of line.items) {
          if (it.red) {
            doc.setFillColor(red.fill);
            doc.rect(it.x, line.y - fs * 0.82, it.w, fs * 1.08, 'F');
            if (red.text) {
              doc.setTextColor(red.text);
              doc.text(it.text, it.x, line.y);
            }
          } else {
            doc.setTextColor('#000000');
            doc.text(it.text, it.x, line.y);
          }
        }
      }
    });
  }

  /** Draw one page of a layout model onto a canvas 2D context at the given dpi. */
  function drawCanvasPage(ctx, model, pageIndex, dpi) {
    const s = dpi / 72;
    const fs = model.fontSize;
    const red = redColors(model);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, model.pageW * s, model.pageH * s);
    ctx.font = `${fs * s}px Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    for (const line of model.pages[pageIndex].lines) {
      for (const it of line.items) {
        if (it.red) {
          ctx.fillStyle = red.fill;
          ctx.fillRect(it.x * s, (line.y - fs * 0.82) * s, it.w * s, fs * 1.08 * s);
          if (!red.text) continue;
          ctx.fillStyle = red.text;
        } else {
          ctx.fillStyle = '#000000';
        }
        ctx.fillText(it.text, it.x * s, line.y * s);
      }
    }
  }

  // ---- files -------------------------------------------------------------

  /** Decode a text file as UTF-8 (BOM optional), falling back to Windows-1252. */
  function decodeText(buffer) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (e) {
      text = new TextDecoder('windows-1252').decode(buffer);
    }
    return text.replace(/\r\n?/g, '\n');
  }

  function outputNames(relPath) {
    const base = relPath.replace(/\.txt$/i, '');
    return { pdf: base + '.pdf', img: base + '_IMG.pdf' };
  }

  function csvReport(results) {
    const q = (v) => {
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [['file', 'line', 'start', 'end', 'matched_text', 'rules']];
    for (const r of results) {
      for (const m of r.matches) rows.push([r.path, m.line, m.start, m.end, m.text, m.rules.join(' | ')]);
    }
    return rows.map((row) => row.map(q).join(',')).join('\r\n') + '\r\n';
  }

  const api = {
    COMMON_PATTERNS, PAGE_SIZES, Redactor, validatePattern, compilePattern, cleanRules, withoutInvalid,
    toPdfSafe, buildParagraphs, layout, drawPdf, drawCanvasPage, decodeText, outputNames, csvReport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoRedact = api;
})(typeof self !== 'undefined' ? self : this);
