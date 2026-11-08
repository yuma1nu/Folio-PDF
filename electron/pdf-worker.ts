import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import type { PageRef } from '../src/shared';
async function run() {
  const { type, paths, pages, bytes: originalBytes } = workerData as { type: string; paths: string[]; pages?: PageRef[]; bytes?: Uint8Array };
  if (type === 'inspect') {
    try {
      const bytes = originalBytes ?? await readFile(paths[0]);
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const fields = doc.getForm().getFields();
      const signed = fields.some(f => f.acroField.dict.get(PDFName.of('FT')) === PDFName.of('Sig'));
      const complex = fields.length > 0 || !!doc.catalog.get(PDFName.of('Outlines')) || doc.getPages().some(p => !!p.node.get(PDFName.of('Annots')));
      return { encrypted: false, signed, complex, rotations: doc.getPages().map(p => p.getRotation().angle) };
    } catch (e) {
      if (String(e).includes('encrypt')) return { encrypted: true, signed: false, complex: false, rotations: [] };
      // PDF.js may recover a document that pdf-lib cannot parse. Editing remains disabled.
      return { encrypted: false, signed: false, complex: true, unsupported: true, rotations: [] };
    }
  }
  const output = await PDFDocument.create();
  if (type === 'merge') {
    for (const path of paths) {
      const source = await PDFDocument.load(await readFile(path), { updateMetadata: false });
      if (source.getForm().getFields().some(f => f.acroField.dict.get(PDFName.of('FT')) === PDFName.of('Sig'))) throw new Error('署名付きPDFの結合には対応していません。');
      for (const page of await output.copyPages(source, source.getPageIndices())) output.addPage(page);
    }
  } else {
    const source = await PDFDocument.load(originalBytes ?? await readFile(paths[0]), { updateMetadata: false });
    const copied = await output.copyPages(source, pages!.map(p => p.source));
    copied.forEach((page, i) => { page.setRotation(degrees(pages![i].rotation)); output.addPage(page); });
  }
  return await output.save();
}
run().then(result => parentPort!.postMessage({ result })).catch(error => parentPort!.postMessage({ error: String(error.message ?? error) }));
