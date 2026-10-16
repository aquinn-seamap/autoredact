/* AutoRedact source importers: turn .txt, .pdf, .eml and Outlook .msg files
   into plain text. Email attachments of a supported type become extra sources.
   Everything except PDF text extraction (pdf.js) also runs under Node. */
(function (root) {
  'use strict';

  const SUPPORTED = /\.(txt|pdf|eml|msg)$/i;
  const PDFJS_VERSION = '3.11.174';
  const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/`;
  const MAX_DEPTH = 3; // attachments inside attachments inside...

  // ---- text helpers ------------------------------------------------------

  function decodeBytes(bytes, charset) {
    const label = (charset || '').trim().toLowerCase().replace(/^"|"$/g, '');
    if (label) {
      try {
        return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'windows-1252' : label).decode(bytes);
      } catch (e) { /* unknown label: fall through */ }
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  const latin1ToBytes = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  };
  const bytesToLatin1 = (b) => {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return s;
  };
  const normaliseNewlines = (s) => s.replace(/\r\n?/g, '\n');

  const ENTITIES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', reg: '®', pound: '£',
    euro: '€', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    bull: '•', trade: '™', middot: '·', deg: '°', eacute: 'é', egrave: 'è', aacute: 'á', uuml: 'ü',
    ouml: 'ö', auml: 'ä', szlig: 'ß', ccedil: 'ç', times: '×', laquo: '«', raquo: '»', shy: '',
  };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(code); } catch (err) { return m; }
      }
      const v = ENTITIES[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function htmlToText(html) {
    let s = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(head|style|script|title|xml)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/(td|th)\s*>/gi, '\t')
      .replace(/<\/?(p|div|tr|table|h[1-6]|ul|ol|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    s = decodeEntities(s)
      .split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim()).join('\n')
      .replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  // ---- Compound File Binary (the container format of .msg) -------------

  const END = 0xFFFFFFFA; // sector ids at or above this are markers

  function readCfb(buf) {
    const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    if (buf.length < 512 || sig.some((b, i) => buf[i] !== b)) throw new Error('Not an Outlook .msg file');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const u32 = (o) => dv.getUint32(o, true);
    const ss = 1 << dv.getUint16(30, true);
    const mss = 1 << dv.getUint16(32, true);
    const numFat = u32(44);
    const dirStart = u32(48);
    const miniCutoff = u32(56);
    const miniFatStart = u32(60);
    let difat = u32(68);
    const offset = (s) => (s + 1) * ss;
    const perSector = ss / 4;

    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < numFat; i++) fatSectors.push(u32(76 + i * 4));
    for (let guard = 0; fatSectors.length < numFat && difat < END && guard < 100000; guard++) {
      const o = offset(difat);
      for (let i = 0; i < perSector - 1 && fatSectors.length < numFat; i++) fatSectors.push(u32(o + i * 4));
      difat = u32(o + (perSector - 1) * 4);
    }
    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((s, k) => {
      const o = offset(s);
      for (let i = 0; i < perSector && o + i * 4 + 4 <= buf.length; i++) fat[k * perSector + i] = u32(o + i * 4);
    });

    const chain = (start, table) => {
      const out = [];
      const seen = new Set();
      for (let s = start; s < END; s = table[s]) {
        if (s >= table.length || seen.has(s)) throw new Error('Damaged .msg file (bad sector chain)');
        seen.add(s);
        out.push(s);
      }
      return out;
    };
    const readChain = (start, size) => {
      const sectors = chain(start, fat);
      const out = new Uint8Array(sectors.length * ss);
      sectors.forEach((s, i) => out.set(buf.subarray(offset(s), offset(s) + ss), i * ss));
      return size === undefined ? out : out.subarray(0, size);
    };

    const dir = readChain(dirStart);
    const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const entries = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
      const nameLen = ddv.getUint16(o + 64, true);
      let name = '';
      for (let i = 0; i + 2 < nameLen && i < 64; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
      entries.push({
        name, type: dir[o + 66],
        left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true),
        start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true),
      });
    }
    const rootEntry = entries[0];
    const miniFat = miniFatStart < END ? new Uint32Array(readChain(miniFatStart).slice().buffer) : new Uint32Array(0);
    const miniStream = rootEntry.start < END ? readChain(rootEntry.start, rootEntry.size) : new Uint8Array(0);

    const readStream = (e) => {
      if (e.size === 0) return new Uint8Array(0);
      if (e.size >= miniCutoff) return readChain(e.start, e.size);
      const sectors = chain(e.start, miniFat);
      const out = new Uint8Array(sectors.length * mss);
      sectors.forEach((s, i) => out.set(miniStream.subarray(s * mss, s * mss + mss), i * mss));
      return out.subarray(0, e.size);
    };

    // Node API: names() lists children (upper-case), child(name) opens one, data() reads a stream.
    const makeNode = (index) => {
      const e = entries[index];
      const ids = new Map(); // child name -> entry index
      if (e.type === 1 || e.type === 5) {
        const stack = [e.child];
        const seen = new Set();
        while (stack.length) {
          const i = stack.pop();
          if (i >= entries.length || seen.has(i)) continue; // also stops at NOSTREAM (0xFFFFFFFF)
          seen.add(i);
          ids.set(entries[i].name.toUpperCase(), i);
          stack.push(entries[i].left, entries[i].right);
        }
      }
      return {
        name: e.name,
        names: () => [...ids.keys()],
        child: (name) => (ids.has(name.toUpperCase()) ? makeNode(ids.get(name.toUpperCase())) : null),
        data: () => (e.type === 2 ? readStream(e) : new Uint8Array(0)),
      };
    };
    return makeNode(0);
  }

  // ---- Outlook .msg ------------------------------------------------------

  const utf16 = (b) => new TextDecoder('utf-16le').decode(b);
  const stripNul = (s) => s.replace(/\0+$/, '');

  function msgString(storage, id, codepage) {
    const uni = storage.child(`__substg1.0_${id}001F`);
    if (uni) return stripNul(utf16(uni.data()));
    const ansi = storage.child(`__substg1.0_${id}001E`);
    if (ansi) return stripNul(decodeBytes(ansi.data(), codepage));
    return '';
  }

  function msgBinary(storage, id) {
    const s = storage.child(`__substg1.0_${id}0102`);
    return s ? s.data() : null;
  }

  /** Fixed-size properties (dates, integers) from __properties_version1.0. */
  function msgFixedProps(storage, headerSize) {
    const s = storage.child('__properties_version1.0');
    const out = {};
    if (!s) return out;
    const b = s.data();
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let o = headerSize; o + 16 <= b.length; o += 16) {
      const type = dv.getUint16(o, true);
      const id = dv.getUint16(o + 2, true).toString(16).toUpperCase().padStart(4, '0');
      if (type === 0x0003) out[id] = dv.getInt32(o + 8, true);
      else if (type === 0x0040) {
        const ft = dv.getBigUint64(o + 8, true);
        if (ft > 0n) out[id] = new Date(Number(ft / 10000n) - 11644473600000);
      }
    }
    return out;
  }

  const smtpOnly = (addr) => (addr && !addr.startsWith('/') && addr.includes('@') ? addr : '');
  const person = (name, addr) => (name && addr && name !== addr ? `${name} <${addr}>` : name || addr || '');

  function parseMsgStorage(storage, propsHeaderSize) {
    const fixed = msgFixedProps(storage, propsHeaderSize);
    const codepage = fixed['3FFD'] ? `windows-${fixed['3FFD']}` : '';
    const str = (id) => msgString(storage, id, codepage);

    const recipients = { 1: [], 2: [], 3: [] };
    for (const name of storage.names()) {
      if (!name.startsWith('__RECIP_VERSION1.0_')) continue;
      const r = storage.child(name);
      const rf = msgFixedProps(r, 8);
      const addr = smtpOnly(msgString(r, '39FE', codepage)) || smtpOnly(msgString(r, '3003', codepage));
      const entry = person(msgString(r, '3001', codepage), addr);
      if (entry) (recipients[rf['0C15']] || recipients[1]).push(entry);
    }

    let body = str('1000');
    if (!body.trim()) {
      const htmlBin = msgBinary(storage, '1013');
      const html = htmlBin ? decodeBytes(htmlBin, codepage) : str('1013');
      if (html) body = htmlToText(html);
    }
    if (!body.trim()) {
      const rtf = msgBinary(storage, '1009');
      if (rtf) body = rtfToText(bytesToLatin1(decompressRtf(rtf)));
    }

    const attachments = [];
    for (const name of storage.names()) {
      if (!name.startsWith('__ATTACH_VERSION1.0_')) continue;
      const a = storage.child(name);
      const fileName = msgString(a, '3707', codepage) || msgString(a, '3704', codepage) || msgString(a, '3001', codepage) || 'attachment';
      const embedded = a.child('__substg1.0_3701000D');
      if (embedded) {
        attachments.push({ name: /\.msg$/i.test(fileName) ? fileName : fileName + '.msg', email: parseMsgStorage(embedded, 24) });
      } else {
        attachments.push({ name: fileName, data: msgBinary(a, '3701') });
      }
    }

    const fromAddr = smtpOnly(str('5D01')) || smtpOnly(str('0C1F')) || smtpOnly(str('0065'));
    return {
      from: person(str('0C1A') || str('0042'), fromAddr),
      to: recipients[1].join('; ') || str('0E04'),
      cc: recipients[2].join('; ') || str('0E03'),
      bcc: recipients[3].join('; '),
      date: fixed['0039'] || fixed['0E06'] || null,
      subject: str('0037'),
      body,
      attachments,
    };
  }

  function parseMsg(bytes) {
    return parseMsgStorage(readCfb(bytes), 32);
  }

  // ---- compressed RTF (older Outlook messages may only have this body) --

  const RTF_PREBUF = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern ' +
    '\\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n' +
    '\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

  function decompressRtf(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const compSize = dv.getUint32(0, true);
    const rawSize = dv.getUint32(4, true);
    const magic = dv.getUint32(8, true);
    if (magic === 0x414C454D) return data.subarray(16, 16 + rawSize); // "MELA": stored uncompressed
    if (magic !== 0x75465A4C) throw new Error('Unknown compressed RTF format');
    const dict = new Uint8Array(4096);
    for (let i = 0; i < RTF_PREBUF.length; i++) dict[i] = RTF_PREBUF.charCodeAt(i);
    let wp = RTF_PREBUF.length;
    const out = [];
    let pos = 16;
    const end = Math.min(data.length, compSize + 4);
    while (pos < end) {
      const flags = data[pos++];
      for (let bit = 0; bit < 8 && pos < end; bit++) {
        if (flags & (1 << bit)) {
          const ref = (data[pos] << 8) | data[pos + 1];
          pos += 2;
          const off = ref >> 4;
          const len = (ref & 0xF) + 2;
          if (off === wp) return Uint8Array.from(out);
          for (let i = 0; i < len; i++) {
            const c = dict[(off + i) & 0xFFF];
            out.push(c);
            dict[wp] = c;
            wp = (wp + 1) & 0xFFF;
          }
        } else {
          const c = data[pos++];
          out.push(c);
          dict[wp] = c;
          wp = (wp + 1) & 0xFFF;
        }
      }
    }
    return Uint8Array.from(out);
  }

  const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer',
    'headerl', 'headerr', 'footerl', 'footerr', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
    'xmlnstbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'object', 'filetbl']);

  /** Plain text from RTF. Handles HTML encapsulated in RTF (\fromhtml), which Outlook uses. */
  function rtfToText(rtf) {
    const fromHtml = /\\fromhtml1?\b/.test(rtf.slice(0, 2000));
    const out = [];
    const stack = [];
    let state = { skip: false, htmltag: false };
    let htmlrtf = false;
    let ucSkip = 1;
    let pendingSkip = 0;
    let bytes = [];
    const flushBytes = () => {
      if (bytes.length) { out.push(decodeBytes(Uint8Array.from(bytes), 'windows-1252')); bytes = []; }
    };
    const emit = (s) => {
      if (state.skip) return;
      if (fromHtml && htmlrtf && !state.htmltag) return;
      flushBytes();
      out.push(s);
    };
    let i = 0;
    let groupStart = false;
    while (i < rtf.length) {
      const ch = rtf[i];
      if (ch === '{') {
        stack.push(state);
        state = Object.assign({}, state);
        groupStart = true;
        i++;
        continue;
      }
      if (ch === '}') {
        state = stack.pop() || { skip: false, htmltag: false };
        groupStart = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        const next = rtf[i + 1];
        if (next === '\'') {
          const code = parseInt(rtf.substr(i + 2, 2), 16);
          i += 4;
          if (pendingSkip) { pendingSkip--; continue; }
          if (!state.skip && !(fromHtml && htmlrtf && !state.htmltag)) bytes.push(code);
          continue;
        }
        if (next === '*') {
          if (groupStart && !(fromHtml && /^\\\*\\htmltag/.test(rtf.substr(i, 12)))) state.skip = true;
          i += 2;
          continue;
        }
        if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; groupStart = false; continue; }
        if (next === '\n' || next === '\r') { emit('\n'); i += 2; continue; }
        if (next === '~') { emit(' '); i += 2; continue; }
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
        if (!m) { i += 2; continue; }
        i += m[0].length;
        const word = m[1];
        const arg = m[2] === undefined ? null : parseInt(m[2], 10);
        const wasGroupStart = groupStart;
        groupStart = false;
        if (wasGroupStart && RTF_SKIP.has(word)) { state.skip = true; continue; }
        if (word === 'htmltag') { state.htmltag = true; continue; }
        if (word === 'htmlrtf') { htmlrtf = arg !== 0; continue; }
        if (word === 'uc') { ucSkip = arg || 0; continue; }
        if (word === 'u') {
          emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
          pendingSkip = ucSkip;
          continue;
        }
        if (fromHtml && !state.htmltag) continue; // formatting only
        if (word === 'par' || word === 'line') emit('\n');
        else if (word === 'tab') emit('\t');
        else if (word === 'emdash') emit('—');
        else if (word === 'endash') emit('–');
        else if (word === 'bullet') emit('•');
        continue;
      }
      groupStart = false;
      if (ch === '\r' || ch === '\n') { i++; continue; }
      if (pendingSkip) { pendingSkip--; i++; continue; }
      emit(ch);
      i++;
    }
    flushBytes();
    const text = out.join('');
    return fromHtml ? htmlToText(text) : text.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---- .eml (MIME) -------------------------------------------------------

  function decodeQP(s) {
    return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }

  function decodeBase64(s) {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
    const padded = clean + '==='.slice((clean.length + 3) % 4);
    if (typeof atob === 'function') return atob(padded.length % 4 ? clean : padded);
    return Buffer.from(clean, 'base64').toString('latin1');
  }

  /** Decode =?charset?B|Q?...?= words. Input is a latin1 "byte string". */
  function decodeHeader(raw) {
    let s = raw.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1');
    const parts = [];
    let last = 0;
    s.replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, text, idx) => {
      parts.push(decodeBytes(latin1ToBytes(s.slice(last, idx))));
      const bin = enc.toUpperCase() === 'B' ? decodeBase64(text) : decodeQP(text.replace(/_/g, ' '));
      parts.push(decodeBytes(latin1ToBytes(bin), charset));
      last = idx + m.length;
      return m;
    });
    parts.push(decodeBytes(latin1ToBytes(s.slice(last))));
    return parts.join('').trim();
  }

  function parseHeaderBlock(text) {
    const headers = {};
    for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
      const m = /^([^:\s]+):\s*(.*)$/.exec(line);
      if (m) (headers[m[1].toLowerCase()] = headers[m[1].toLowerCase()] || []).push(m[2]);
    }
    return headers;
  }

  /** "text/plain; charset=utf-8; name*=UTF-8''r%C3%A9sum%C3%A9.pdf" -> {value, params} */
  function parseParams(value) {
    const out = { value: '', params: {} };
    const parts = (value || '').match(/(?:[^;"]+|"(?:\\.|[^"])*")+/g) || [''];
    out.value = parts[0].trim().toLowerCase();
    const cont = {};
    for (const p of parts.slice(1)) {
      const m = /^\s*([^=\s]+)\s*=\s*(.*)\s*$/.exec(p);
      if (!m) continue;
      let [, key, val] = m;
      key = key.toLowerCase();
      if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
      const ext = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
      if (!ext) continue;
      const [, base, index, encoded] = ext;
      (cont[base] = cont[base] || []).push({ index: Number(index || 0), val, encoded: !!encoded });
    }
    for (const [key, pieces] of Object.entries(cont)) {
      pieces.sort((a, b) => a.index - b.index);
      let charset = '';
      let bytes = '';
      pieces.forEach((piece, i) => {
        let v = piece.val;
        if (piece.encoded) {
          if (i === 0) {
            const m = /^([^']*)'[^']*'(.*)$/.exec(v);
            if (m) { charset = m[1]; v = m[2]; }
          }
          v = v.replace(/%([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16)));
        }
        bytes += v;
      });
      out.params[key] = pieces.some((p) => p.encoded) ? decodeBytes(latin1ToBytes(bytes), charset) : decodeHeader(bytes);
    }
    return out;
  }

  function parseMimePart(raw, depth) {
    const sep = /\r?\n\r?\n/.exec(raw);
    const headers = parseHeaderBlock(sep ? raw.slice(0, sep.index) : raw);
    const body = sep ? raw.slice(sep.index + sep[0].length) : '';
    const h = (name) => (headers[name] ? headers[name][0] : '');
    const type = parseParams(h('content-type') || 'text/plain');
    const disp = parseParams(h('content-disposition'));
    const part = { headers, h, type: type.value || 'text/plain', params: type.params, disposition: disp.value,
      filename: disp.params.filename || type.params.name || '', parts: [] };

    if (part.type.startsWith('multipart/') && type.params.boundary && depth < 20) {
      const marker = '--' + type.params.boundary;
      let current = null;
      for (const line of body.split(/\r?\n/)) {
        if (line.startsWith(marker)) {
          if (current) part.parts.push(parseMimePart(current.join('\r\n'), depth + 1));
          current = line.slice(marker.length).startsWith('--') ? null : [];
          if (!current) break;
        } else if (current) {
          current.push(line);
        }
      }
      if (current && current.length) part.parts.push(parseMimePart(current.join('\r\n'), depth + 1));
      return part;
    }
    const cte = h('content-transfer-encoding').trim().toLowerCase();
    const bin = cte === 'base64' ? decodeBase64(body) : cte === 'quoted-printable' ? decodeQP(body) : body;
    part.bytes = latin1ToBytes(bin);
    return part;
  }

  function parseEml(bytes) {
    const top = parseMimePart(bytesToLatin1(bytes), 0);
    let plain = null;
    let html = null;
    const attachments = [];
    const walk = (p) => {
      if (p.parts.length) { p.parts.forEach(walk); return; }
      const isAttachment = p.disposition === 'attachment' || (p.filename && !p.type.startsWith('text/'));
      if (p.type === 'message/rfc822') {
        attachments.push({ name: (p.filename || 'attached message').replace(/(\.eml)?$/i, '.eml'), data: p.bytes });
      } else if (!isAttachment && p.type === 'text/plain' && plain === null) {
        plain = decodeBytes(p.bytes, p.params.charset);
      } else if (!isAttachment && p.type === 'text/html' && html === null) {
        html = decodeBytes(p.bytes, p.params.charset);
      } else if (p.filename || isAttachment) {
        attachments.push({ name: p.filename || 'attachment', data: p.bytes });
      }
    };
    walk(top);
    const hd = (name) => decodeHeader(top.h(name));
    const dateRaw = hd('date');
    const date = dateRaw && !isNaN(Date.parse(dateRaw)) ? new Date(dateRaw) : dateRaw || null;
    return {
      from: hd('from'), to: hd('to'), cc: hd('cc'), bcc: hd('bcc'), date, subject: hd('subject'),
      body: plain !== null && plain.trim() ? normaliseNewlines(plain) : html ? htmlToText(html) : '',
      attachments,
    };
  }

  // ---- email -> text ---------------------------------------------------

  function formatDate(d) {
    if (!(d instanceof Date)) return d || '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function emailToText(email) {
    const lines = [];
    const add = (label, value) => { if (value) lines.push(`${label}: ${value}`); };
    add('From', email.from);
    add('To', email.to);
    add('Cc', email.cc);
    add('Bcc', email.bcc);
    add('Date', formatDate(email.date));
    add('Subject', email.subject);
    lines.push('------------------------------');
    let text = lines.join('\n') + '\n' + normaliseNewlines(email.body || '').trim();
    if (email.attachments.length) text += '\n\nAttachments: ' + email.attachments.map((a) => a.name).join(', ');
    return text;
  }

  // ---- PDF (browser only) ----------------------------------------------

  let pdfjsPromise = null;
  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PDFJS_BASE + 'pdf.min.js';
        s.onload = () => {
          root.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
          resolve(root.pdfjsLib);
        };
        s.onerror = () => { pdfjsPromise = null; reject(new Error('Could not load the PDF reader (pdf.js). Check your connection.')); };
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  async function pdfToText(bytes) {
    const lib = await loadPdfJs();
    let doc;
    try {
      doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new Error('The PDF is password-protected');
      throw e;
    }
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let s = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        s += item.str;
        if (item.hasEOL) s += '\n';
      }
      pages.push(s.replace(/[ \t]+\n/g, '\n').trim());
    }
    await doc.destroy();
    return { text: pages.filter(Boolean).join('\n\n'), pages: doc.numPages };
  }

  // ---- entry point -----------------------------------------------------

  const baseName = (name) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'attachment';

  /**
   * Extract text from one file. Returns a list of sources:
   * [{path, text, kind, note}] — more than one when an email has attachments.
   */
  async function extract(bytes, path, depth = 0) {
    const ext = (/\.([a-z0-9]+)$/i.exec(path) || [])[1];
    const kind = (ext || '').toLowerCase();
    if (kind === 'txt') {
      return [{ path, kind, text: normaliseNewlines(decodeBytes(bytes)) }];
    }
    if (kind === 'pdf') {
      const { text, pages } = await pdfToText(bytes);
      const note = text.trim() ? `Text extracted from ${pages} PDF page(s); the original layout is not kept.`
        : 'No text found. It may be a scanned PDF, which needs OCR (not supported).';
      return [{ path, kind, text, note }];
    }
    if (kind === 'eml' || kind === 'msg') {
      const email = kind === 'eml' ? parseEml(bytes) : parseMsg(bytes);
      return emailSources(email, path, kind, depth);
    }
    throw new Error('Unsupported file type');
  }

  async function emailSources(email, path, kind, depth) {
    const out = [{ path, kind, text: emailToText(email), note: email.attachments.length ? `${email.attachments.length} attachment(s)` : '' }];
    if (depth >= MAX_DEPTH) return out;
    const folder = path.replace(/\.([^./]+)$/, '_$1') + '/'; // "Plan.msg" -> "Plan_msg/"
    for (const a of email.attachments) {
      const attPath = folder + baseName(a.name);
      try {
        if (a.email) out.push(...await emailSources(a.email, attPath, 'msg', depth + 1));
        else if (a.data && SUPPORTED.test(a.name)) out.push(...await extract(a.data, attPath, depth + 1));
      } catch (e) {
        out.push({ path: attPath, kind: 'error', text: '', error: e.message || String(e) });
      }
    }
    return out;
  }

  const api = {
    SUPPORTED, extract, parseEml, parseMsg, readCfb, emailToText, htmlToText, rtfToText, decompressRtf,
    decodeHeader, parseParams, RTF_PREBUF,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoRedactSources = api;
})(typeof self !== 'undefined' ? self : this);
