import { _electron as electron } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output = path.resolve('test-results'); await mkdir(output, { recursive: true });
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
for (const [width, height] of [[1191, 842], [595, 842], [420, 595], [842, 595]]) {
  const p = pdf.addPage([width, height]); p.drawText(`${width} x ${height}`, { x: 35, y: height - 50, size: 18, font });
  p.drawLine({ start: { x: width / 2, y: 20 }, end: { x: width / 2, y: height - 20 }, thickness: 1 });
}
const fixture = path.join(output, 'mixed-page-sizes.pdf'); await writeFile(fixture, await pdf.save());
const env = { ...process.env, FOLIO_USER_DATA: path.join(output, `alignment-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const packaged = process.argv.includes('--packaged');
const app = await electron.launch(packaged ? { executablePath: path.resolve(pkg.build.directories.output, 'win-unpacked/Folio PDF.exe'), args: [fixture], env } : { args: ['.', fixture], env });
try {
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('.pdfViewer .page canvas');
  await page.waitForFunction(() => document.querySelectorAll('.pdfViewer > .page').length === 4);
  const results = [];
  for (const zoom of ['25', '100', '200', '400', '1600', '50']) {
    await page.getByRole('combobox', { name: '表示倍率' }).selectOption(zoom);
    const geometry = await page.locator('.pdfViewer').evaluate(viewer => {
      const bounds = viewer.getBoundingClientRect();
      const pages = [...viewer.children].filter(p => p.classList.contains('page')).map(p => { const r = p.getBoundingClientRect(); return { center: r.left + r.width / 2 - bounds.left, width: r.width, left: r.left - bounds.left }; });
      const container=viewer.parentElement;
      return { width: bounds.width, pages, viewportCenter:container.scrollLeft+container.clientWidth/2 };
    });
    results.push({ zoom, ...geometry });
    const centers = geometry.pages.map(p => p.center);
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, JSON.stringify({ zoom, ...geometry }));
    assert.ok(geometry.pages.every(p => p.left >= -1 && p.left + p.width <= geometry.width + 1));
    assert.ok(Math.abs(geometry.viewportCenter-geometry.width/2)<=2, JSON.stringify({ zoom, ...geometry }));
  }
  await page.getByRole('combobox', { name: '表示倍率' }).selectOption('100');
  await page.getByRole('spinbutton', { name: 'ページ番号' }).fill('2');
  await page.getByRole('spinbutton', { name: 'ページ番号' }).press('Enter');
  const navigated=await page.locator('.viewer-container').evaluate(c=>{const p=c.querySelectorAll('.pdfViewer > .page')[1].getBoundingClientRect(),r=c.getBoundingClientRect();return {center:p.left+p.width/2,viewport:r.left+c.clientWidth/2};});
  assert.ok(Math.abs(navigated.center-navigated.viewport)<=2,JSON.stringify(navigated));
  await page.screenshot({ path: path.join(output, 'mixed-pages-centered.png') });
  // Resizing the side panel and rotating the widest page must retain a common centerline.
  await page.getByRole('button', { name: 'サイドバーの切り替え', exact: true }).click();
  await page.evaluate(async () => { const s = await window.folio.snapshot(); await window.folio.edit(s.active, { type: 'rotate', ids: [s.docs[0].pages[0].id], delta: 90 }); });
  await page.waitForTimeout(300);
  await page.getByRole('combobox', { name: '表示倍率' }).selectOption('200');
  await page.waitForFunction(() => { const pages = [...document.querySelectorAll('.pdfViewer > .page')]; const centers = pages.map(p => { const r=p.getBoundingClientRect(); return r.left+r.width/2; }); return centers.length===4 && Math.max(...centers)-Math.min(...centers)<=1; });
  assert.deepEqual(errors, []); console.log('ALIGNMENT PASS', JSON.stringify(results.map(r => ({ zoom: r.zoom, width: r.width, centers: r.pages.map(p => p.center) }))));
} finally { await app.evaluate(({ app }) => app.exit(0)); }
