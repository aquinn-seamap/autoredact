# AutoRedact (web edition)

Redact names, email addresses and other sensitive text from text files, PDFs and emails, and save the
results as PDFs. Everything runs in the browser: files are read locally and never uploaded anywhere.

**Features**

- Sources: `.txt`, `.pdf` (text is extracted with pdf.js), Outlook `.msg` and `.eml` emails.
  Emails become a From/To/Cc/Date/Subject header plus the body. Attachments that are themselves
  txt, pdf, eml or msg files (including attached Outlook messages) are imported as separate sources.
- Drop in files or whole folders; each source shows its match count.
- Live preview with highlighted matches, previous/next navigation, and "add selection as word".
- Word and phrase rules (not case-sensitive) and regex patterns, with ready-made common patterns.
- Three modes: highlight (review), black box, or `[REDACTED]`. The removal modes keep the original
  text out of the PDF entirely.
- Optional image-only `_IMG.pdf` copy with no selectable text.
- Download each PDF, everything as a `.zip`, or a CSV report of every match.
- Rules load and save as `redactions.json`, the same format the desktop Python tool uses.

## Publish on GitHub Pages

1. Create a new repository on GitHub, for example `autoredact`.
2. Upload the **contents** of this `website` folder to the root of the repository
   (`index.html`, `styles.css`, the `js` folder, and optionally `tests` and this README).
   On github.com: *Add file → Upload files*, drag the files in, then *Commit changes*.
3. Open *Settings → Pages*. Under *Build and deployment*, choose *Deploy from a branch*,
   pick `main` and `/ (root)`, then *Save*.
4. After a minute the site is live at `https://<your-username>.github.io/autoredact/`.

## Run locally

Open `index.html` directly in a browser, or serve the folder:

```
python -m http.server 8765 --directory website
```

## Notes

- jsPDF and JSZip load from cdnjs, so the page needs an internet connection the first time.
  pdf.js loads only when the first PDF is added.
- PDF sources are converted to text, so the redacted output is reflowed text rather than the
  original page layout. Scanned PDFs with no text layer would need OCR, which is not supported.
- To use an Outlook email, save it as a `.msg` file (File > Save As) or drag it out of Outlook into a
  folder first, then add that file.
- PDFs use the built-in Helvetica font, which covers Western European characters. Curly quotes
  and dashes become plain ASCII, and other characters (for example Greek or CJK) appear as `?`.
- Regex patterns use JavaScript syntax. The Python forms `(?P<name>...)`, `(?P=name)` and a
  leading `(?i)` are converted automatically.

## Tests

```
node --test website/tests/redact.test.js website/tests/sources.test.js
```

The `.msg` fixtures in `tests/fixtures` are synthetic files built with the `cfb` npm package.
