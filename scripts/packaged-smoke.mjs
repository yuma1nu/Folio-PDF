import { _electron as electron } from 'playwright';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const env={...process.env,FOLIO_USER_DATA:path.resolve(`test-results/packaged-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;
const start=Date.now();
const app=await electron.launch({executablePath:path.resolve(pkg.build.directories.output,'win-unpacked/Folio PDF.exe'),args:[path.resolve('test-results/drawing.pdf')],env});
try{
const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.waitForSelector('.pdfViewer .page canvas',{timeout:30000});
await page.waitForFunction(()=>document.querySelector('.pdfViewer .page canvas')?.width>0);
console.log('packaged-first-canvas-ms',Date.now()-start);
assert.equal(await page.locator('.breadcrumb').count(),0);
const documentTop=await page.locator('.document-area').evaluate(e=>e.getBoundingClientRect().top);
assert.equal(documentTop,100);
assert.equal(await page.locator('.toolbar').getByRole('button',{name:'サイドバーの切り替え',exact:true}).count(),1);
assert.equal(await page.locator('.toolbar .save-state').getAttribute('title'),'保存済み');
const sidebar=page.locator('.folio-sidebar');
const expanded=await sidebar.evaluate(e=>e.getBoundingClientRect().width);
await page.getByRole('button',{name:'サイドバーの切り替え',exact:true}).click();
for(const theme of ['light','dark']){
 await page.evaluate(theme=>window.folio.settings({theme}),theme);
 const dimensions=await sidebar.evaluate(e=>{
   const rect=e.getBoundingClientRect();
   return {width:rect.width,mainLeft:document.querySelector('main').getBoundingClientRect().left,buttons:[...e.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right};})};
 });
 assert.equal(dimensions.width,48);
 assert.equal(dimensions.mainLeft,48);
 assert.ok(dimensions.buttons.every(b=>b.left>=0&&b.right<=48),JSON.stringify(dimensions));
}
await page.screenshot({path:'test-results/sidebar-fixed.png'});
await page.getByRole('button',{name:'サイドバーの切り替え',exact:true}).click();
assert.equal(await sidebar.evaluate(e=>e.getBoundingClientRect().width),expanded);
console.log('sidebar collapse/expand OK: 48px, both themes');
await page.screenshot({path:'test-results/unified-toolbar.png'});
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,650));
await page.waitForFunction(()=>innerWidth===800);
assert.ok(await page.locator('.toolbar').evaluate(e=>[...e.children].every(c=>c.getBoundingClientRect().right<=e.getBoundingClientRect().right)));
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1240,850));
await page.waitForFunction(()=>innerWidth===1240);
await page.getByRole('button',{name:'検索 (Ctrl+F)',exact:true}).click();
await page.getByPlaceholder('検索する文字を入力').fill('SEARCH-TEST');
await page.waitForFunction(()=>document.querySelector('.search-count')?.textContent.includes('5件'));
await page.getByRole('combobox',{name:'表示倍率'}).selectOption('1600');
await page.waitForSelector('canvas.detailView');
await page.waitForTimeout(600);
const details=await page.locator('canvas.detailView').first().evaluate(c=>({width:c.width,height:c.height}));
assert.ok(details.width>1000);
await page.evaluate(async()=>{const s=await window.folio.snapshot();await window.folio.edit(s.active,{type:'rotate',ids:[s.docs[0].pages[0].id],delta:90});});
const snapshot=await page.evaluate(()=>window.folio.snapshot());assert.equal(snapshot.docs[0].pages[0].rotation,90);
await page.locator('.toolbar .save-state[title="未保存の変更"]').waitFor();
await page.evaluate(async()=>{const s=await window.folio.snapshot();await window.folio.close(s.active,true);});
await page.waitForSelector('.home-toolbar');
assert.equal(await page.locator('.home-toolbar').getByRole('button',{name:'サイドバーの切り替え',exact:true}).count(),1);
assert.deepEqual(errors,[]);
console.log('PACKAGED PASS',details);
}finally{await app.evaluate(({app})=>app.exit(0));}
