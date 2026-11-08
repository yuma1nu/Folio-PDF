import { _electron as electron } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = path.resolve('test-results');
const profile = path.join(dir, `integration-${Date.now()}`);
const input = path.join(dir, 'drawing.pdf');
const extracted = path.join(dir, 'extract.pdf'), combined = path.join(dir, 'combined.pdf'), printed = path.join(dir, 'printed.pdf');
const env = { ...process.env, FOLIO_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
let app = await electron.launch({ args: ['.'], env });
const errors = [];
async function waitFor(page, fn) { const end = Date.now()+30000; while (Date.now()<end) { if (await page.evaluate(fn)) return; await page.waitForTimeout(100); } throw new Error(`Timeout: ${fn}`); }
try {
  let page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('.home');
  await page.evaluate(file => window.folio.open([file]), input);
  await page.waitForSelector('.pdfViewer .page canvas');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }, extracted);
  await page.evaluate(async () => { const s = await window.folio.snapshot(); await window.folio.save(s.active, [s.docs[0].pages[1].id, s.docs[0].pages[3].id]); });
  const part = await PDFDocument.load(await readFile(extracted)); assert.equal(part.getPageCount(),2);
  await page.waitForSelector('.pdfViewer .page canvas');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, combined);
  await page.evaluate(files => window.folio.merge(files), [extracted, input]);
  const merged = await PDFDocument.load(await readFile(combined)); assert.equal(merged.getPageCount(), 7); assert.equal(merged.getPage(2).getWidth(),2384);
  console.log('extraction + ordered merge OK');
  // Print the 2-page extraction. Stub only the physical-printer handoff and capture Chromium output.
  await page.evaluate(async () => { const s = await window.folio.snapshot(); const doc = s.docs.find(d => d.name === 'extract.pdf'); await window.folio.activate(doc.id); });
  await page.waitForSelector('.pdfViewer .page canvas');
  await app.evaluate(({ app }, file) => {
    app.on('web-contents-created', (_event, contents) => {
      contents.print = function(options, callback) {
        if (options.silent !== false) throw new Error('Print must show dialog');
        this.printToPDF({ printBackground: true, preferCSSPageSize: true }).then(bytes => { process.getBuiltinModule('node:fs').writeFileSync(file,bytes); callback(true, ''); }).catch(e => callback(false,e.message));
      };
    });
  }, printed);
  await page.evaluate(() => { new MutationObserver(()=> { const text=document.querySelector('[role=status]')?.textContent; if(text) console.log('STATUS',text); }).observe(document.body,{childList:true,subtree:true}); });
  page.on('console', m=>{if(m.text().startsWith('STATUS'))console.log(m.text());});
  await page.getByRole('button', { name: '印刷 (Ctrl+P)', exact:true }).click();
  await page.getByRole('status').filter({hasText:'プリンターに送信しました'}).waitFor({timeout:30000}).catch(async e=>{console.log('Print UI:',await page.locator('body').innerText());throw e;});
  const printPdf = await PDFDocument.load(await readFile(printed)); assert.equal(printPdf.getPageCount(),2);
  assert.ok(Math.abs(printPdf.getPage(0).getWidth()-595)<2);
  console.log('print pipeline + page size OK');
  await page.evaluate(async () => { const s=await window.folio.snapshot(); await window.folio.view(s.active,{page:2,scale:'1.5',left:12,top:950}); await window.folio.settings({theme:'dark'}); });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.folio.closeWindow()).catch(e => { if (!String(e).includes('closed')) throw e; });
  await app.close().catch(()=>{});
  app = await electron.launch({args:['.'], env}); page = await app.firstWindow();
  await waitFor(page, async () => (await window.folio.snapshot()).docs.length === 3);
  const restored = await page.evaluate(() => window.folio.snapshot());
  assert.equal(restored.settings.theme,'dark'); assert.equal(restored.docs.find(d=>d.id===restored.active).name,'extract.pdf');
  await page.waitForSelector('.pdfViewer .page canvas', {timeout:30000});
  await page.screenshot({path:path.join(dir,'restored-dark.png')});
  console.log('session + theme restoration OK');
  assert.deepEqual(errors,[]);
  console.log('INTEGRATION PASS');
} finally { await app.evaluate(({app})=>app.exit(0)).catch(()=>{}); }
