// Run with: node --test website/tests
const test = require('node:test');
const assert = require('node:assert');
const AR = require('../js/redact.js');

const make = (words = [], patterns = [], partial = true) => new AR.Redactor({ words, patterns }, partial);
const texts = (ms) => ms.map((m) => m.text);
const measure = (s) => s.length * 6; // fixed-width stand-in for font metrics

test('partial vs exact matching', () => {
  assert.deepStrictEqual(texts(make(['thi']).findMatches('this thi within')), ['thi', 'thi', 'thi']);
  assert.deepStrictEqual(texts(make(['thi'], [], false).findMatches('this thi within')), ['thi']);
  assert.deepStrictEqual(texts(make(['zoë'], [], false).findMatches('Zoë zoëy')), ['Zoë']);
});

test('case-insensitive phrase across a line break', () => {
  const ms = make(['John Doe']).findMatches('Hi JOHN\nDOE here');
  assert.deepStrictEqual(texts(ms), ['JOHN\nDOE']);
  assert.strictEqual(ms[0].line, 1);
});

test('overlapping matches merge', () => {
  const ms = make(['John Doe', 'Doe Smith']).findMatches('John Doe Smith');
  assert.strictEqual(ms.length, 1);
  assert.strictEqual(ms[0].text, 'John Doe Smith');
  assert.deepStrictEqual(ms[0].rules.sort(), ['Doe Smith', 'John Doe']);
});

test('patterns: invalid, zero-width, python syntax', () => {
  assert.throws(() => make([], ['(unclosed']));
  assert.ok(AR.validatePattern('(unclosed'));
  assert.strictEqual(AR.validatePattern('\\d{3}\\-\\d'), null); // fine without the u flag
  assert.deepStrictEqual(make([], ['\\b']).findMatches('some words'), []);
  assert.deepStrictEqual(texts(make([], ['(?P<a>ab)(?P=a)']).findMatches('xababx')), ['abab']);
  assert.deepStrictEqual(texts(make([], ['(?i)secret']).findMatches('SECRET')), ['SECRET']);
});

test('every common pattern compiles and the samples match', () => {
  for (const p of Object.values(AR.COMMON_PATTERNS)) assert.strictEqual(AR.validatePattern(p), null, p);
  const r = make([], Object.values(AR.COMMON_PATTERNS));
  const found = texts(r.findMatches('mail a.b@example.co.uk, NI AB 12 34 56 C, SW1A 1AA, 07700 900123'));
  assert.deepStrictEqual(found, ['a.b@example.co.uk', 'AB 12 34 56 C', 'SW1A 1AA', '07700 900123']);
});

test('removal modes keep the original text out of the layout', () => {
  const text = 'The topsecret plan';
  const ms = make(['topsecret']).findMatches(text);
  for (const mode of ['blackout', 'replace']) {
    const model = AR.layout(text, ms, { mode }, measure);
    const all = model.pages.flatMap((p) => p.lines.flatMap((l) => l.items.map((i) => i.text))).join('');
    assert.ok(!all.includes('topsecret'), mode);
    assert.ok(all.includes('plan'));
  }
  const hl = AR.layout(text, ms, { mode: 'highlight' }, measure);
  assert.deepStrictEqual(hl.pages[0].lines[0].items.map((i) => [i.text, i.red]),
    [['The ', false], ['topsecret', true], [' plan', false]]);
});

test('wrapping, paragraphs, line breaks and pagination', () => {
  const words = Array.from({ length: 400 }, (_, i) => 'word' + i).join(' ');
  const model = AR.layout(words + '\n\nSecond para', [], {}, measure);
  const maxRight = 612 - 72;
  for (const p of model.pages) for (const l of p.lines) for (const it of l.items) assert.ok(it.x + it.w <= maxRight + 0.01);
  assert.ok(model.pages.length >= 1);
  const lastLine = model.pages.at(-1).lines.at(-1);
  assert.strictEqual(lastLine.items[0].text, 'Second para');

  const joined = AR.layout('a\nb', [], {}, measure);
  assert.strictEqual(joined.pages[0].lines.length, 1);
  const kept = AR.layout('a\nb', [], { keepLineBreaks: true }, measure);
  assert.strictEqual(kept.pages[0].lines.length, 2);

  const long = AR.layout(Array(3000).fill('line').join('\n'), [], { keepLineBreaks: true }, measure);
  assert.ok(long.pages.length > 40);
  const huge = AR.layout('x'.repeat(500), [], {}, measure); // one word wider than the page
  assert.ok(huge.pages[0].lines.length > 1);
});

test('decoding, output names, csv', () => {
  assert.strictEqual(AR.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0xa3])), 'café\n£');
  assert.strictEqual(AR.decodeText(Buffer.from('﻿hi\r\n', 'utf8')), 'hi\n');
  assert.deepStrictEqual(AR.outputNames('sub/my.txt.notes.txt'), { pdf: 'sub/my.txt.notes.pdf', img: 'sub/my.txt.notes_IMG.pdf' });
  const csv = AR.csvReport([{ path: 'a.txt', matches: make(['x, y']).findMatches('x, y') }]);
  assert.ok(csv.includes('"x, y"'));
  assert.strictEqual(AR.toPdfSafe('“hi” — ok…'), '"hi" - ok...');
});
