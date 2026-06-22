// Renders index.html to character-sheet.pdf using headless Chromium.
// printBackground keeps the grey panels and ruled lines; preferCSSPageSize
// honours the `@page { size: letter; margin: 0 }` rule so each .sheet maps to
// one US-Letter page.
import { chromium } from 'playwright';
import path from 'node:path';

const url = 'file://' + path.resolve('index.html');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({
  path: 'character-sheet.pdf',
  printBackground: true,
  preferCSSPageSize: true,
});
await browser.close();
