import { _electron as electron } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const output=path.resolve('test-results');
const env={...process.env,FOLIO_USER_DATA:path.join(output,`quality-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;
const dpr=Number(process.env.FOLIO_TEST_DPR ?? 1);
const app=await electron.launch({args:[`--force-device-scale-factor=${dpr}`,'.',path.join(output,'drawing.pdf')],env});
try{
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForSelector('.pdfViewer .page canvas');
 await page.getByRole('combobox',{name:'表示倍率'}).selectOption('1600');
 await page.evaluate(()=>{const c=document.querySelector('.viewer-container');c.scrollTop=1250;c.scrollLeft=600;});
 await page.waitForTimeout(1000);
 const metrics=await page.locator('.pdfViewer .page canvas.detailView').first().evaluate(canvas=>{
   const bounds=canvas.getBoundingClientRect(); const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let nonWhite=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]&&pixels[i]<180)nonWhite++;
   return {width:canvas.width,height:canvas.height,cssWidth:bounds.width,cssHeight:bounds.height,dpr:devicePixelRatio,nonWhite};
 });
 assert.ok(metrics.width/metrics.cssWidth>=metrics.dpr*.98,JSON.stringify(metrics));
 assert.ok(metrics.nonWhite>1000,JSON.stringify(metrics));
 await page.screenshot({path:path.join(output,`drawing-detail-${dpr}x.png`)});
 // Return to a previously drawn area after a burst of zooms and pans.
 for(const value of ['800','400','1600','800','1600']) await page.getByRole('combobox',{name:'表示倍率'}).selectOption(value);
 await page.evaluate(()=>{const c=document.querySelector('.viewer-container');c.scrollTop=3000;c.scrollLeft=1000;c.scrollTop=1250;c.scrollLeft=600;});
 await page.waitForTimeout(1000);
 const final=await page.locator('.pdfViewer .page canvas.detailView').first().evaluate(c=>({width:c.width,height:c.height,cssWidth:c.getBoundingClientRect().width}));
 assert.ok(final.width/final.cssWidth>=.98);
 assert.deepEqual(errors,[]);
 console.log('QUALITY PASS',metrics,final);
 await writeFile(path.join(output,`quality-metrics-${dpr}x.json`),JSON.stringify({metrics,final},null,2));
 // Generate a code-drawn application icon, without adding an image dependency.
 const base64=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');x.fillStyle='#353d3a';x.beginPath();x.roundRect(0,0,256,256,48);x.fill();x.fillStyle='#f7f6f1';x.beginPath();x.roundRect(65,42,126,172,10);x.fill();x.fillStyle='#d2d7cb';x.beginPath();x.moveTo(153,42);x.lineTo(191,80);x.lineTo(153,80);x.fill();x.strokeStyle='#657d73';x.lineWidth=9;x.lineCap='round';for(const y of [109,137,165]){x.beginPath();x.moveTo(91,y);x.lineTo(y===165?137:165,y);x.stroke();}return c.toDataURL('image/png').split(',')[1];});
 const png=Buffer.from(base64,'base64');const head=Buffer.alloc(22);head.writeUInt16LE(1,2);head.writeUInt16LE(1,4);head.writeUInt16LE(1,10);head.writeUInt16LE(32,12);head.writeUInt32LE(png.length,14);head.writeUInt32LE(22,18);
 const {mkdir}=await import('node:fs/promises');await mkdir('assets',{recursive:true});await writeFile('assets/icon.png',png);await writeFile('assets/icon.ico',Buffer.concat([head,png]));
}finally{await app.evaluate(({app})=>app.exit(0));}
