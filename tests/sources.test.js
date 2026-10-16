// Run with: node --test website/tests/sources.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../js/sources.js');

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));

test('.eml: headers, quoted-printable body, attachments', async () => {
  const email = S.parseEml(fixture('sample.eml'));
  assert.strictEqual(email.from, 'John Doé <john.doe@example.com>');
  assert.strictEqual(email.to, '"Jane Roe" <jane.roe@example.com>, rick@example.org');
  assert.strictEqual(email.cc, 'Sébastien <seb@example.fr>');
  assert.strictEqual(email.subject, 'Quarterly plan – Confidential');
  assert.strictEqual(email.date.toISOString(), '2026-05-05T13:41:56.000Z');
  assert.match(email.body, /numbers for Zoë are below\. This line is long enough to be soft-wrapped/);
  assert.ok(!email.body.includes('HTML version'));
  assert.deepStrictEqual(email.attachments.map((a) => a.name), ['résumé notes.txt', 'logo.png']);

  const sources = await S.extract(fixture('sample.eml'), 'mail/sample.eml');
  assert.deepStrictEqual(sources.map((s) => s.path), ['mail/sample.eml', 'mail/sample_eml/résumé notes.txt']);
  assert.match(sources[0].text, /^From: John Doé <john\.doe@example\.com>\nTo: /);
  assert.match(sources[0].text, /Attachments: résumé notes\.txt, logo\.png$/);
  assert.strictEqual(sources[1].text, 'Attachment: call John Doe on 555.');
});

test('.msg: properties, recipients, date, long body, attachments, embedded message', async () => {
  const email = S.parseMsg(fixture('sample.msg'));
  assert.strictEqual(email.subject, 'Quarterly plan – Zoë');
  assert.strictEqual(email.from, 'John Doe <john.doe@example.com>');
  assert.strictEqual(email.to, 'Jane Roe <jane.roe@example.com>');
  assert.strictEqual(email.cc, 'Rick Moe <rick@example.org>');
  assert.strictEqual(email.date.toISOString(), '2026-05-05T13:41:00.000Z');
  assert.ok(email.body.length > 4096, 'long body is read from regular sectors');
  assert.match(email.body, /SSN 123-45-6789/);
  assert.match(email.body, /END OF BODY$/);

  const sources = await S.extract(fixture('sample.msg'), 'Plan.msg');
  assert.deepStrictEqual(sources.map((s) => s.path), ['Plan.msg', 'Plan_msg/notes.txt', 'Plan_msg/Forwarded.msg']);
  assert.match(sources[0].text, /Attachments: notes\.txt, image\.png, Forwarded\.msg/);
  assert.strictEqual(sources[1].text, 'Attachment text: call John Doe on 555.');
  assert.match(sources[2].text, /^From: Inner Sender <inner@example\.com>\nSubject: Inner message\n-+\nInner body mentions John Doe\.$/);
});

test('.msg: HTML-only and compressed-RTF-only bodies', () => {
  assert.strictEqual(S.parseMsg(fixture('html-only.msg')).body, 'Dear John Doe,\n\nLine two\nLine three & more');
  assert.strictEqual(S.parseMsg(fixture('rtf-only.msg')).body, 'hello world');
});

test('RTF with encapsulated HTML', () => {
  const rtf = '{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag19 <html>}{\\*\\htmltag64 <p>}\\htmlrtf {\\htmlrtf0 Hi John Doe\\htmlrtf }\\htmlrtf0 {\\*\\htmltag72 </p>}{\\*\\htmltag64 <p>}Caf\\\'e9 \\u8364? 5{\\*\\htmltag72 </p>}}';
  assert.strictEqual(S.rtfToText(rtf), 'Hi John Doe\n\nCafé € 5');
  assert.strictEqual(S.rtfToText('{\\rtf1{\\fonttbl{\\f0 Arial;}}Line one\\par Line two}'), 'Line one\nLine two');
});

test('header and parameter decoding', () => {
  assert.strictEqual(S.decodeHeader('=?utf-8?q?caf=C3=A9?= =?utf-8?q?_ok?='), 'café ok');
  assert.strictEqual(S.parseParams('attachment; filename*0*=UTF-8\'\'a%C3%A9; filename*1=b.pdf').params.filename, 'aéb.pdf');
  assert.strictEqual(S.htmlToText('<ul><li>One</li><li>Two &lt;3</li></ul>'), '• One\n• Two <3');
});

test('rejects files that are not what they claim', async () => {
  await assert.rejects(S.extract(new TextEncoder().encode('hello'), 'fake.msg'), /Not an Outlook \.msg file/);
  await assert.rejects(S.extract(new Uint8Array(1), 'x.docx'), /Unsupported/);
});
