/* AutoRedact web UI. Uses the engine in redact.js plus jsPDF and JSZip. */
(function () {
  'use strict';

  const AR = window.AutoRedact;
  const $ = (id) => document.getElementById(id);

  const STORAGE_KEY = 'autoredact.settings.v1';
  const PREVIEW_CHAR_LIMIT = 400000;
  const PREVIEW_HIGHLIGHT_LIMIT = 10000;
  const FONT_SIZE = 11;
  const DEFAULT_RULES = {
    words: ['John Doe', 'Confidential'],
    patterns: [AR.COMMON_PATTERNS['Email address'], AR.COMMON_PATTERNS['US Social Security number']],
  };
  const SAMPLE = {
    path: 'sample-report.txt',
    text: [
      'Project Report: SecretProject',
      'Date: 2026-05-05',
      'Prepared by: John Doe <john.doe@example.com>',
      '',
      'This is a Confidential document regarding the expansion of our facilities.',
      'For any inquiries, please contact john.doe@example.com or call 555-01-9999.',
      '',
      'We must ensure that SecretProject remains a top priority. If John Doe is',
      'unavailable, please talk to the supervisor. R&D costs are < £2m.',
      '',
      'Employee SSN on file: 123-45-6789',
    ].join('\n'),
  };

  const state = {
    files: [],          // {id, path, text, count, result}
    currentId: null,
    rules: { words: [], patterns: [] },
    partial: false,
    running: false,
    cancel: false,
    results: [],
    outputUrls: [],
  };
  let nextId = 1;
  let previewMarks = [];
  let currentMark = -1;
  let selectedText = '';

  // ------------------------------------------------------------ storage

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    state.rules = AR.cleanRules(saved.rules || DEFAULT_RULES);
    state.partial = !!saved.partial;
    const o = saved.options || {};
    if (o.mode) $('mode').value = o.mode;
    if (o.color) $('color').value = o.color;
    if (o.pageSize) $('pageSize').value = o.pageSize;
    if (o.dpi) $('dpi').value = String(o.dpi);
    $('keepBreaks').checked = !!o.keepBreaks;
    $('imagePdf').checked = o.imagePdf !== false;
    $('partial').checked = state.partial;
    if (saved.theme) document.documentElement.dataset.theme = saved.theme;
  }

  function saveSettings() {
    const data = {
      rules: state.rules,
      partial: state.partial,
      options: {
        mode: $('mode').value, color: $('color').value, pageSize: $('pageSize').value,
        dpi: Number($('dpi').value), keepBreaks: $('keepBreaks').checked, imagePdf: $('imagePdf').checked,
      },
      theme: document.documentElement.dataset.theme || null,
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
  }

  // ------------------------------------------------------------ helpers

  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const current = () => state.files.find((f) => f.id === state.currentId) || null;

  function log(msg) {
    const el = $('log');
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function buildRedactor() {
    return new AR.Redactor(AR.withoutInvalid(state.rules), state.partial);
  }

  let refreshTimer = null;
  function rulesChanged() {
    saveSettings();
    renderTester();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshMatches, 250);
  }

  function refreshMatches() {
    const r = buildRedactor();
    for (const f of state.files) f.count = r.findMatches(f.text).length;
    renderFileList();
    renderPreview(true);
  }

  // ------------------------------------------------------------ files

  async function addFiles(entries) {
    const txt = entries.filter((e) => /\.txt$/i.test(e.path));
    const skipped = entries.length - txt.length;
    if (!txt.length) {
      log(skipped ? `No .txt files among the ${skipped} item(s) added.` : 'No files added.');
      return;
    }
    const r = buildRedactor();
    for (const { file, path } of txt) {
      const text = AR.decodeText(await file.arrayBuffer());
      addText(path, text, r);
    }
    log(`Added ${txt.length} file(s)` + (skipped ? `, skipped ${skipped} non-.txt file(s).` : '.'));
    renderFileList();
    renderPreview();
  }

  function addText(path, text, redactor) {
    const existing = state.files.find((f) => f.path === path);
    const count = (redactor || buildRedactor()).findMatches(text).length;
    if (existing) {
      Object.assign(existing, { text, count, result: null });
    } else {
      const f = { id: nextId++, path, text, count, checked: true, result: null };
      state.files.push(f);
      state.files.sort((a, b) => a.path.localeCompare(b.path));
      if (!state.currentId) state.currentId = f.id;
    }
  }

  async function filesFromDrop(dataTransfer) {
    // Entries must be collected before the first await.
    const entries = [...dataTransfer.items]
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, path: prefix + file.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e, prefix + entry.name + '/');
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }

  function renderFileList() {
    const ul = $('fileList');
    ul.textContent = '';
    let total = 0;
    for (const f of state.files) {
      total += f.count;
      const li = document.createElement('li');
      li.className = f.id === state.currentId ? 'current' : '';
      li.title = f.path;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = f.checked;
      cb.setAttribute('aria-label', 'Include ' + f.path);
      cb.addEventListener('click', (ev) => ev.stopPropagation());
      cb.addEventListener('change', () => { f.checked = cb.checked; });
      const status = document.createElement('span');
      status.className = 'status' + (f.result ? (f.result.error ? ' err' : ' ok') : '');
      status.textContent = f.result ? (f.result.error ? '✗' : '✓') : '';
      if (f.result && f.result.error) status.title = f.result.error;
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.path;
      const badge = document.createElement('span');
      badge.className = 'badge' + (f.count ? ' hit' : '');
      badge.textContent = f.count;
      badge.title = `${f.count} match(es)`;
      li.append(cb, status, name, badge);
      li.addEventListener('click', () => {
        state.currentId = f.id;
        renderFileList();
        renderPreview();
        renderOutput();
      });
      ul.appendChild(li);
    }
    $('filesSummary').textContent = state.files.length
      ? `${state.files.length} file(s), ${total} match(es)`
      : 'No files yet.';
  }

  // ------------------------------------------------------------ preview

  function renderPreview(keepScroll) {
    const pre = $('preview');
    const f = current();
    const scroll = keepScroll ? pre.scrollTop : 0;
    previewMarks = [];
    currentMark = -1;
    if (!f) {
      pre.textContent = '';
      $('previewInfo').textContent = 'Add a file to preview it.';
      return;
    }
    const truncated = f.text.length > PREVIEW_CHAR_LIMIT;
    const shown = truncated ? f.text.slice(0, PREVIEW_CHAR_LIMIT) : f.text;
    const matches = buildRedactor().findMatches(shown);
    const parts = [];
    let cursor = 0;
    for (const m of matches.slice(0, PREVIEW_HIGHLIGHT_LIMIT)) {
      parts.push(escapeHtml(shown.slice(cursor, m.start)));
      parts.push(`<mark title="Matched by: ${escapeHtml(m.rules.join(', '))}">${escapeHtml(m.text)}</mark>`);
      cursor = m.end;
    }
    parts.push(escapeHtml(shown.slice(cursor)));
    pre.innerHTML = parts.join('');
    pre.scrollTop = scroll;
    previewMarks = [...pre.querySelectorAll('mark')];

    let info = `${matches.length} match(es) in ${f.path}`;
    if (matches.length > PREVIEW_HIGHLIGHT_LIMIT) info += ` (first ${PREVIEW_HIGHLIGHT_LIMIT.toLocaleString()} highlighted)`;
    if (truncated) info += ` — showing the first ${PREVIEW_CHAR_LIMIT.toLocaleString()} of ${f.text.length.toLocaleString()} characters`;
    if (Object.keys(invalidPatterns()).length) info += ' — invalid patterns are being ignored';
    $('previewInfo').textContent = info;
  }

  function jump(direction) {
    if (!previewMarks.length) return;
    if (currentMark >= 0) previewMarks[currentMark].classList.remove('current');
    const n = previewMarks.length;
    currentMark = currentMark < 0 ? (direction > 0 ? 0 : n - 1) : (currentMark + direction + n) % n;
    const mark = previewMarks[currentMark];
    mark.classList.add('current');
    mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('previewInfo').textContent = `Match ${currentMark + 1} of ${previewMarks.length}`;
  }

  // ------------------------------------------------------------ rules

  function invalidPatterns() {
    const out = {};
    for (const p of state.rules.patterns) {
      const err = AR.validatePattern(p);
      if (err) out[p] = err;
    }
    return out;
  }

  function renderRuleList(kind) {
    const ul = $(kind === 'words' ? 'wordList' : 'patternList');
    ul.textContent = '';
    state.rules[kind].forEach((value, index) => {
      const li = document.createElement('li');
      const input = document.createElement('input');
      input.value = value;
      input.spellcheck = false;
      input.setAttribute('aria-label', kind === 'words' ? 'Word' : 'Pattern');
      const err = document.createElement('div');
      err.className = 'err';
      const validate = () => {
        const e = kind === 'patterns' ? AR.validatePattern(input.value) : null;
        li.classList.toggle('invalid', !!e);
        err.textContent = e ? 'Invalid: ' + e : '';
        err.hidden = !e;
      };
      input.addEventListener('input', () => {
        state.rules[kind][index] = input.value;
        validate();
        rulesChanged();
      });
      input.addEventListener('change', () => {
        if (!input.value.trim()) {
          state.rules[kind].splice(index, 1);
          renderRuleList(kind);
          rulesChanged();
        }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove ' + value);
      remove.addEventListener('click', () => {
        state.rules[kind].splice(index, 1);
        renderRuleList(kind);
        rulesChanged();
      });
      li.append(input, remove, err);
      validate();
      ul.appendChild(li);
    });
  }

  function addRule(kind, value) {
    value = kind === 'words' ? value.split(/\s+/).join(' ').trim() : value;
    if (!value || state.rules[kind].includes(value)) return false;
    state.rules[kind].push(value);
    renderRuleList(kind);
    rulesChanged();
    return true;
  }

  function setRules(rules) {
    state.rules = AR.cleanRules(rules);
    renderRuleList('words');
    renderRuleList('patterns');
    rulesChanged();
  }

  function renderTester() {
    const text = $('tester').value;
    const out = $('testerResult');
    if (!text) { out.textContent = ''; return; }
    const ms = buildRedactor().findMatches(text);
    if (!ms.length) { out.innerHTML = '<i class="muted">No matches</i>'; return; }
    let html = `${ms.length} match(es): `;
    let cursor = 0;
    for (const m of ms) {
      html += escapeHtml(text.slice(cursor, m.start)) + `<mark>${escapeHtml(m.text)}</mark>`;
      cursor = m.end;
    }
    out.innerHTML = html + escapeHtml(text.slice(cursor));
  }

  // ------------------------------------------------------------ options

  function updateMode() {
    const mode = $('mode').value;
    const w = $('modeWarning');
    if (mode === 'highlight') {
      w.className = 'notice warn';
      w.textContent = 'Review mode: matched text stays readable and is not removed.';
    } else {
      w.className = 'notice ok';
      w.textContent = 'Matched text is removed from the PDF.';
    }
    $('color').disabled = mode !== 'highlight';
    $('dpi').disabled = !$('imagePdf').checked;
    $('preview').style.setProperty('--hl', $('color').value);
  }

  // ------------------------------------------------------------ run

  async function rasterise(model, dpi, onPage) {
    const { jsPDF } = window.jspdf;
    const s = dpi / 72;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(model.pageW * s);
    canvas.height = Math.round(model.pageH * s);
    const ctx = canvas.getContext('2d');
    const out = new jsPDF({ unit: 'pt', format: [model.pageW, model.pageH], compress: true });
    for (let i = 0; i < model.pages.length; i++) {
      if (state.cancel) throw new Error('Cancelled');
      if (i > 0) out.addPage([model.pageW, model.pageH]);
      AR.drawCanvasPage(ctx, model, i, dpi);
      out.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, model.pageW, model.pageH, undefined, 'FAST');
      onPage(i + 1, model.pages.length);
      if (i % 3 === 2) await tick();
    }
    return out.output('blob');
  }

  async function redactFile(f, redactor, opts) {
    const { jsPDF } = window.jspdf;
    const matches = redactor.findMatches(f.text);
    const doc = new jsPDF({ unit: 'pt', format: opts.pageSize, compress: true });
    doc.setProperties({ title: 'Redacted document', creator: 'AutoRedact' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(FONT_SIZE);
    const model = AR.layout(f.text, matches, opts, (str) => doc.getTextWidth(str));
    AR.drawPdf(doc, model);
    const pdf = doc.output('blob');
    let img = null;
    if (opts.imagePdf) img = await rasterise(model, opts.dpi, opts.onPage);
    return { path: f.path, matches, pdf, img, model, pages: model.pages.length };
  }

  async function run() {
    if (state.running) return;
    if (!window.jspdf) {
      alert('The PDF library failed to load. Check your internet connection and reload the page.');
      return;
    }
    const files = state.files.filter((f) => f.checked);
    if (!files.length) { alert('Add some .txt files and tick at least one.'); return; }
    if (Object.keys(invalidPatterns()).length) { alert('Some regex patterns are invalid (shown in red). Fix or remove them first.'); return; }
    if (!state.rules.words.length && !state.rules.patterns.length &&
        !confirm('There are no rules, so nothing will be redacted. Continue?')) return;

    state.running = true;
    state.cancel = false;
    setRunning(true);
    const redactor = buildRedactor();
    const progress = $('progress');
    progress.max = files.length;
    progress.value = 0;
    const opts = {
      mode: $('mode').value,
      highlightColor: $('color').value,
      pageSize: $('pageSize').value,
      keepLineBreaks: $('keepBreaks').checked,
      imagePdf: $('imagePdf').checked,
      dpi: Number($('dpi').value),
    };
    log(`Redacting ${files.length} file(s) [${$('mode').selectedOptions[0].text}]`);
    const results = [];
    for (let i = 0; i < files.length && !state.cancel; i++) {
      const f = files[i];
      opts.onPage = (page, pages) => { progress.value = i + page / pages; };
      await tick();
      try {
        f.result = await redactFile(f, redactor, opts);
        const r = f.result;
        log(`  ✓ ${f.path}: ${r.matches.length} match(es), ${r.pages} page(s)`);
      } catch (e) {
        if (state.cancel) break;
        f.result = { path: f.path, matches: [], error: e.message || String(e) };
        log(`  ✗ ${f.path}: ${f.result.error}`);
      }
      results.push(f.result);
      progress.value = i + 1;
      renderFileList();
      if (f.id === state.currentId) renderOutput();
    }
    const failed = results.filter((r) => r.error).length;
    log(`${state.cancel ? 'Cancelled' : 'Finished'}: ${results.length - failed} succeeded, ${failed} failed.`);
    state.results = results;
    state.running = false;
    setRunning(false);
    renderOutput();
    if (results.length && !failed && !state.cancel) showTab('output');
  }

  function setRunning(running) {
    $('runBtn').disabled = running;
    $('cancelBtn').disabled = !running;
    const done = state.results.some((r) => !r.error);
    $('downloadZip').disabled = running || !done;
    $('downloadCsv').disabled = running || !done;
  }

  async function downloadZip() {
    const ok = state.results.filter((r) => !r.error);
    if (!ok.length) return;
    if (!window.JSZip) { alert('The ZIP library failed to load.'); return; }
    const zip = new window.JSZip();
    for (const r of ok) {
      const names = AR.outputNames(r.path);
      zip.file(names.pdf, r.pdf);
      if (r.img) zip.file(names.img, r.img);
    }
    zip.file('redaction_report.csv', AR.csvReport(ok));
    download(await zip.generateAsync({ type: 'blob' }), 'redacted.zip');
  }

  // ------------------------------------------------------------ output tab

  function showTab(which) {
    const preview = which === 'preview';
    $('tabPreview').setAttribute('aria-selected', String(preview));
    $('tabOutput').setAttribute('aria-selected', String(!preview));
    $('previewPane').hidden = !preview;
    $('outputPane').hidden = preview;
    if (!preview) renderOutput();
  }

  const PAGES_PER_BATCH = 5;
  const VIEW_DPI = 110;

  // Pages are drawn from the same layout used for the PDFs, so this works
  // in browsers without a built-in PDF viewer (e.g. on phones).
  function renderOutput() {
    if ($('outputPane').hidden) return;
    const f = current();
    const r = f && f.result;
    const pagesEl = $('pages');
    state.outputUrls.forEach((u) => URL.revokeObjectURL(u));
    state.outputUrls = [];
    pagesEl.textContent = '';

    if (!r || r.error) {
      $('outputActions').hidden = true;
      $('outputInfo').textContent = '';
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = !f ? 'Add a file first.' : r ? `This file failed: ${r.error}` : 'Run the redaction to see the pages here.';
      pagesEl.appendChild(p);
      return;
    }

    const names = AR.outputNames(f.path);
    const link = (id, blob, name) => {
      const a = $(id);
      a.hidden = !blob;
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      state.outputUrls.push(url);
      a.href = url;
      if (name) a.download = name.split('/').pop();
    };
    link('openPdf', r.pdf);
    link('downloadPdf', r.pdf, names.pdf);
    link('downloadImg', r.img, names.img);
    $('outputActions').hidden = false;
    const size = (b) => (b.size / 1024).toFixed(0) + ' KB';
    $('outputInfo').textContent = `${names.pdf.split('/').pop()} — ${r.pages} page(s), ${size(r.pdf)}` +
      (r.img ? ` · image PDF ${size(r.img)}` : '');

    let shown = 0;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn';
    const showBatch = () => {
      more.remove();
      const end = Math.min(shown + PAGES_PER_BATCH, r.model.pages.length);
      const s = VIEW_DPI / 72;
      for (; shown < end; shown++) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(r.model.pageW * s);
        canvas.height = Math.round(r.model.pageH * s);
        AR.drawCanvasPage(canvas.getContext('2d'), r.model, shown, VIEW_DPI);
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Page ${shown + 1}`);
        const label = document.createElement('p');
        label.className = 'page-label';
        label.textContent = `Page ${shown + 1} of ${r.model.pages.length}`;
        pagesEl.append(canvas, label);
      }
      if (shown < r.model.pages.length) {
        more.textContent = `Show more pages (${r.model.pages.length - shown} left)`;
        pagesEl.appendChild(more);
      }
    };
    more.addEventListener('click', showBatch);
    showBatch();
  }

  // ------------------------------------------------------------ wiring

  function wire() {
    $('fileInput').addEventListener('change', async (e) => {
      await addFiles([...e.target.files].map((file) => ({ file, path: file.name })));
      e.target.value = '';
    });
    $('folderInput').addEventListener('change', async (e) => {
      await addFiles([...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
      e.target.value = '';
    });
    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
      e.preventDefault();
      if (t === 'drop' || !e.relatedTarget) dz.classList.remove('over');
    }));
    document.addEventListener('drop', async (e) => {
      if (e.dataTransfer) await addFiles(await filesFromDrop(e.dataTransfer));
    });
    $('loadSample').addEventListener('click', () => {
      addText(SAMPLE.path, SAMPLE.text);
      state.currentId = state.files.find((f) => f.path === SAMPLE.path).id;
      renderFileList();
      renderPreview();
      log('Loaded the sample file.');
    });
    $('checkAll').addEventListener('click', () => { state.files.forEach((f) => { f.checked = true; }); renderFileList(); });
    $('checkNone').addEventListener('click', () => { state.files.forEach((f) => { f.checked = false; }); renderFileList(); });
    $('clearFiles').addEventListener('click', () => {
      if (state.running) return;
      state.files = [];
      state.currentId = null;
      state.results = [];
      setRunning(false);
      renderFileList();
      renderPreview();
      renderOutput();
    });

    $('tabPreview').addEventListener('click', () => showTab('preview'));
    $('tabOutput').addEventListener('click', () => showTab('output'));
    $('prevMatch').addEventListener('click', () => jump(-1));
    $('nextMatch').addEventListener('click', () => jump(1));

    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      const inPreview = sel && sel.rangeCount && $('preview').contains(sel.anchorNode) && $('preview').contains(sel.focusNode);
      const text = inPreview ? sel.toString().split(/\s+/).join(' ').trim() : '';
      if (text || !document.activeElement || document.activeElement.id !== 'addSelection') {
        selectedText = text.slice(0, 200);
      }
      $('addSelection').disabled = !selectedText;
    });
    $('addSelection').addEventListener('click', () => {
      if (selectedText && addRule('words', selectedText)) log(`Added word rule: ${selectedText}`);
    });

    $('addWordForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (addRule('words', $('newWord').value)) $('newWord').value = '';
    });
    $('addPatternForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('newPattern').value;
      const err = AR.validatePattern(v);
      if (err) { $('newPattern').setCustomValidity(err); $('newPattern').reportValidity(); return; }
      if (addRule('patterns', v)) $('newPattern').value = '';
    });
    $('newPattern').addEventListener('input', () => $('newPattern').setCustomValidity(''));
    const common = $('commonPatterns');
    for (const [name, pattern] of Object.entries(AR.COMMON_PATTERNS)) {
      const opt = document.createElement('option');
      opt.value = pattern;
      opt.textContent = name;
      opt.title = pattern;
      common.appendChild(opt);
    }
    common.addEventListener('change', () => {
      if (common.value) addRule('patterns', common.value);
      common.value = '';
    });
    $('partial').addEventListener('change', () => { state.partial = $('partial').checked; rulesChanged(); });
    $('tester').addEventListener('input', renderTester);

    for (const id of ['mode', 'color', 'pageSize', 'dpi', 'keepBreaks', 'imagePdf']) {
      $(id).addEventListener('change', () => { updateMode(); saveSettings(); });
    }
    $('color').addEventListener('input', updateMode);

    $('rulesFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        setRules(JSON.parse(await file.text()));
        log(`Loaded rules from ${file.name}`);
      } catch (err) {
        alert(`Could not read ${file.name}: ${err.message}`);
      }
    });
    $('saveRules').addEventListener('click', () => {
      const json = JSON.stringify(AR.cleanRules(state.rules), null, 2) + '\n';
      download(new Blob([json], { type: 'application/json' }), 'redactions.json');
    });
    $('themeToggle').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      saveSettings();
    });

    $('runBtn').addEventListener('click', run);
    $('cancelBtn').addEventListener('click', () => {
      state.cancel = true;
      $('cancelBtn').disabled = true;
      log('Cancelling…');
    });
    $('downloadZip').addEventListener('click', downloadZip);
    $('downloadCsv').addEventListener('click', () => {
      const ok = state.results.filter((r) => !r.error);
      download(new Blob([AR.csvReport(ok)], { type: 'text/csv' }), 'redaction_report.csv');
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.running) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  loadSettings();
  wire();
  renderRuleList('words');
  renderRuleList('patterns');
  updateMode();
  renderFileList();
  renderPreview();
  if (!window.jspdf) log('Warning: the PDF library did not load, so redaction is unavailable. Check your connection.');
})();
