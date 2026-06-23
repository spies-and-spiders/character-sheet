// Renders index.html to a form-fillable character-sheet.pdf.
//
// Chromium's page.pdf() can only emit a flat, static PDF — it never produces
// interactive AcroForm fields. So we render the visual layout with Chromium as
// before, then read the on-page geometry of every element marked with a
// `data-ff` attribute and overlay matching AcroForm widgets with pdf-lib.
//
// Because the field rectangles are derived from the rendered DOM rather than
// hand-placed coordinates, they stay in sync with the layout automatically.
import { chromium } from 'playwright';
import { PDFDocument, TextAlignment } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';

const PDF_PATH = 'character-sheet.pdf';
const url = 'file://' + path.resolve('index.html');

// US-Letter: 816x1056 CSS px (96 dpi) maps to 612x792 PDF pt (72 dpi).
const SCALE = 72 / 96;
const PAGE_HEIGHT_PT = 792;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

// 1. Visual layout: one .sheet per US-Letter page.
await page.pdf({
  path: PDF_PATH,
  printBackground: true,
  preferCSSPageSize: true,
});

// 1b. PNG preview per page, straight from the rendered DOM. These match the
//     printed design exactly and avoid the form-field rendering quirks that
//     PDF rasterisers (e.g. poppler) introduce.
const sheets = await page.$$('.sheet');
for (let i = 0; i < sheets.length; i++) {
  await sheets[i].screenshot({ path: `character-sheet-page-${i + 1}.png` });
}

// 2. Collect field geometry, expressed relative to each sheet's top-left so it
//    is independent of how the sheets are stacked on screen.
const fields = await page.evaluate(() => {
  const sheets = [...document.querySelectorAll('.sheet')];
  const out = [];
  sheets.forEach((sheet, pageIndex) => {
    const sb = sheet.getBoundingClientRect();
    sheet.querySelectorAll('[data-ff]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const it = parseFloat(el.dataset.ffIt || 0);
      const ib = parseFloat(el.dataset.ffIb || 0);
      let x = r.left - sb.left;
      let y = r.top - sb.top;
      let w = r.width;
      let h = r.height;
      // Thin underline elements: grow the field upward from the line.
      if (el.dataset.ffH) {
        const bottom = y + h;
        h = parseFloat(el.dataset.ffH);
        y = bottom - h;
      }
      // Reserve space for an in-box caption/label.
      y += it;
      h -= it + ib;
      // Ruled writing areas: capture the line pitch (px) so multi-line text can
      // be sized to sit on the rules rather than auto-shrinking as it fills.
      let pitch = null;
      if (el.classList.contains('on-hit')) pitch = 24;
      else if (el.classList.contains('ruled19')) pitch = 20;
      else if (el.classList.contains('ruled')) pitch = 22;
      out.push({ page: pageIndex, name: el.dataset.ff, type: el.dataset.ffType || 'text', align: el.dataset.ffAlign, x, y, w, h, pitch });
    });
  });
  return out;
});

await browser.close();

// 3. Overlay AcroForm widgets.
const pdf = await PDFDocument.load(fs.readFileSync(PDF_PATH));
const form = pdf.getForm();
const pages = pdf.getPages();

for (const f of fields) {
  const target = pages[f.page];
  const x = f.x * SCALE;
  const width = f.w * SCALE;
  const height = f.h * SCALE;
  // PDF origin is bottom-left; flip the y axis.
  const y = PAGE_HEIGHT_PT - (f.y + f.h) * SCALE;

  // pdf-lib defaults widgets to an opaque white background + black border, which
  // hides the ruled lines, write-on underlines and captions underneath. Passing
  // the keys explicitly as `undefined` keeps the widgets fully transparent so the
  // static design shows through and only the user's typed text appears.
  const transparent = { borderWidth: 0, backgroundColor: undefined, borderColor: undefined };

  if (f.type === 'check') {
    const size = Math.min(width, height);
    const cb = form.createCheckBox(f.name);
    cb.addToPage(target, { x: x + (width - size) / 2, y: y + (height - size) / 2, width: size, height: size, ...transparent });
  } else {
    const tf = form.createTextField(f.name);
    if (f.type === 'area') tf.enableMultiline();
    tf.addToPage(target, { x, y, width, height, ...transparent });
    // Size the text to the line it sits on (the /DA only exists post-addToPage).
    if (f.type === 'area') {
      // Ruled areas: size so the line-height (~1.15x for Helvetica) tracks the
      // rule pitch. Plain boxes: a readable default.
      tf.setFontSize(f.pitch ? Math.round((f.pitch * SCALE) / 1.15) : 11);
    } else {
      // Auto-size: the viewer scales the text to fill the field height.
      tf.acroField.setFontSize(0);
    }
    if (f.align === 'center') tf.setAlignment(TextAlignment.Center);
  }
}

fs.writeFileSync(PDF_PATH, await pdf.save());
console.log(`Wrote ${PDF_PATH} with ${fields.length} fillable fields.`);
