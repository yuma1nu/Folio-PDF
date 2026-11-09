import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, screen, type IpcMainInvokeEvent } from 'electron';
import { readFile, writeFile, rename, unlink, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { Doc, DocumentUI, Edit, PageRef, Recent, Settings, Snapshot, View } from '../src/shared';
import { editPages, samePages } from '../src/core';
import { monitorFile } from './file-monitor';

type Internal = Doc & { owner: number; initial: PageRef[]; undo: PageRef[][]; redo: PageRef[][]; bytes?: Uint8Array; unsupported?: boolean; watcher?: { close(): void }; stamp?: number };
type SavedWindow = { paths: string[]; active?: string; bounds?: Electron.Rectangle };
type Persisted = { settings: Settings; recent: Recent[]; views: Record<string, View>; windows: SavedWindow[] };
const defaults: Settings = { theme: 'system', openMode: 'tab', restore: true };
const documents = new Map<string, Internal>();
const windows = new Map<number, { win: BrowserWindow; active: string | null; closing: boolean }>();
let persisted: Persisted = { settings: defaults, recent: [], views: {}, windows: [] };
let persistenceTimer: ReturnType<typeof setTimeout>;
const jobs = new Map<string, { owner: number; dir: string; pages: { file: string; width: number; height: number }[]; win?: BrowserWindow }>();
const mergeWorkers = new Map<number, { worker: Worker; reject: (error: Error) => void }>();
let shuttingDown = false;
let persistenceChain = Promise.resolve();
const statePath = () => path.join(app.getPath('userData'), 'state.json');
const normalize = (p: string) => path.resolve(p).toLowerCase();
const windowDocs = (owner: number) => [...documents.values()].filter(d => d.owner === owner);
const publicDoc = ({ owner, initial, undo, redo, bytes, watcher, stamp, unsupported, ...doc }: Internal): Doc => doc;
const snapshot = (owner: number): Snapshot => ({ windowId: owner, docs: windowDocs(owner).map(publicDoc), active: windows.get(owner)?.active ?? null, settings: persisted.settings, recent: persisted.recent, windows: [...windows].map(([id, { win }]) => ({ id, title: windowDocs(id).map(d => d.name).join(', ') || 'ホーム' })) });
function broadcast() { for (const [id, { win }] of windows) if (!win.isDestroyed()) win.webContents.send('folio:state', snapshot(id)); }
function collectWindows(): SavedWindow[] { return [...windows].map(([id, { win, active }]) => ({ paths: windowDocs(id).map(d => d.path), active: active ? documents.get(active)?.path : undefined, bounds: win.getNormalBounds() })); }
async function persist(keepWindows = false) {
  if (!keepWindows) persisted.windows = collectWindows();
  const value = JSON.stringify(persisted, null, 2);
  persistenceChain = persistenceChain.catch(() => {}).then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    const temp = `${statePath()}.tmp`; await writeFile(temp, value); await rename(temp, statePath());
  });
  await persistenceChain;
}
function schedulePersist() { clearTimeout(persistenceTimer); persistenceTimer = setTimeout(() => { void persist().catch(console.error); }, 500); }
function owned(event: IpcMainInvokeEvent, id: string) {
  const doc = documents.get(id); if (!doc || doc.owner !== event.sender.id) throw new Error('この文書にアクセスできません。'); return doc;
}
function work<T>(type: string, paths: string[], pages?: PageRef[], owner?: number, bytes?: Uint8Array): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pdf-worker.cjs'), { workerData: { type, paths, pages, bytes } });
    if (owner) mergeWorkers.set(owner, { worker, reject });
    worker.once('message', message => { if (owner) mergeWorkers.delete(owner); message.error ? reject(new Error(message.error)) : resolve(message.result); });
    worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error(`PDF処理が終了しました (${code})`)); });
  });
}
function setActive(owner: number, id: string | null) { const entry = windows.get(owner); if (entry) entry.active = id; }
function applyTheme() { nativeTheme.themeSource = persisted.settings.theme; }
function createWindow(bounds?: Electron.Rectangle) {
  const area = screen.getDisplayMatching(bounds ?? screen.getPrimaryDisplay().workArea).workArea;
  const width = Math.min(bounds?.width ?? 1240, area.width), height = Math.min(bounds?.height ?? 850, area.height);
  const win = new BrowserWindow({ width, height, x: Math.max(area.x, Math.min(bounds?.x ?? area.x + 60, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds?.y ?? area.y + 40, area.y + area.height - height)), minWidth: 800, minHeight: 600, show: false, frame: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#ffffff', title: 'Folio PDF', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  win.setIcon(path.join(__dirname, '../assets/icon.png'));
  const owner = win.webContents.id;
  windows.set(owner, { win, active: null, closing: false });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    const entry = windows.get(owner);
    if (!entry?.closing && !shuttingDown) { event.preventDefault(); win.webContents.send('folio:close-request'); }
  });
  win.on('closed', () => { for (const d of windowDocs(owner)) { d.watcher?.close(); documents.delete(d.id); } for (const [id, job] of jobs) if (job.owner === owner) { job.win?.destroy(); void rm(job.dir, { recursive: true, force: true }); jobs.delete(id); } windows.delete(owner); broadcast(); });
  win.on('resize', schedulePersist); win.on('move', schedulePersist);
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL); else void win.loadFile(path.join(__dirname, '../dist/index.html'));
  broadcast(); return owner;
}
async function openPaths(owner: number, paths: string[], forceOwner = false) {
  let current = owner;
  const errors: string[] = [];
  for (const file of paths) {
    try {
      if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.pdf') throw new Error('PDFファイルを指定してください。');
      const initialStat = await stat(file);
      const duplicate = [...documents.values()].find(d => normalize(d.path) === normalize(file));
      if (duplicate) { setActive(duplicate.owner, duplicate.id); windows.get(duplicate.owner)?.win.focus(); continue; }
      if (!forceOwner && persisted.settings.openMode === 'window' && windowDocs(current).length) current = createWindow();
      const id = randomUUID();
      const view = persisted.views[normalize(file)] ?? { page: 1, scale: 'page-width', left: 0, top: 0 };
      const doc: Internal = { id, path: file, name: path.basename(file), pages: [], dirty: false, encrypted: false, signed: false, complex: false, restricted: false, printAllowed: true, version: 0, view, ui: { query: '', sensitive: false, selected: [], organize: false, panel: 'pages' }, canUndo: false, canRedo: false, owner: current, initial: [], undo: [], redo: [] };
      documents.set(id, doc); setActive(current, id);
      persisted.recent = [{ path: file, name: doc.name }, ...persisted.recent.filter(r => normalize(r.path) !== normalize(file))].slice(0, 20);
      doc.watcher = monitorFile(file, initialStat, () => { if (documents.has(id)) { doc.changed = true; broadcast(); } }, error => console.warn('File monitoring failed; using periodic update checks:', error));
      broadcast();
    } catch (error) { errors.push(`${path.basename(file)}: ${String(error)}`); }
  }
  schedulePersist(); broadcast();
  if (errors.length) await dialog.showMessageBox(windows.get(owner)!.win, { type: 'warning', message: '開けないファイルがありました', detail: errors.join('\n') });
}
async function atomicWrite(destination: string, bytes: Uint8Array) {
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try { await writeFile(temp, bytes, { flag: 'wx' }); if ((await stat(temp)).size !== bytes.byteLength) throw new Error('保存データを検証できませんでした。'); await rename(temp, destination); }
  finally { await unlink(temp).catch(() => {}); }
}
function editable(doc: Internal) { if (doc.encrypted || doc.signed || doc.restricted || doc.unsupported) throw new Error('このPDFは閲覧専用です。暗号化・署名・権限制限のあるPDFは編集できません。'); }
async function saveDoc(doc: Internal, selected?: string[]) {
  editable(doc);
  if (doc.changed && !doc.bytes) throw new Error('元ファイルが外部で変更されました。ファイルを開き直してください。');
  if (doc.complex) {
    const result = await dialog.showMessageBox(windows.get(doc.owner)!.win, { type: 'warning', message: 'ページ構成を変更して保存します', detail: '既存のしおり・フォーム・注釈・内部リンクなどは完全に保持されない場合があります。原本を残して保存してください。', buttons: ['続ける', 'キャンセル'], defaultId: 1, cancelId: 1 });
    if (result.response !== 0) return false;
  }
  const pages = selected ? doc.pages.filter(p => selected.includes(p.id)) : doc.pages;
  if (!pages.length) throw new Error('保存するページを選択してください。');
  const { canceled, filePath } = await dialog.showSaveDialog(windows.get(doc.owner)!.win, { title: selected ? '選択ページを保存' : '名前を付けて保存', defaultPath: doc.path.replace(/\.pdf$/i, selected ? '_抽出.pdf' : '_編集.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (canceled || !filePath) return false;
  const other = [...documents.values()].find(d => d.id !== doc.id && normalize(d.path) === normalize(filePath));
  if (other || (selected && normalize(doc.path) === normalize(filePath))) throw new Error('開いているPDFとは異なる保存先を指定してください。');
  const version = doc.version;
  if (doc.changed && normalize(filePath) === normalize(doc.path)) throw new Error('元ファイルが外部で変更されています。別の名前で保存してください。');
  const bytes = await work<Uint8Array>('export', [doc.path], pages, undefined, doc.bytes);
  await atomicWrite(filePath, bytes);
  if (!selected && version === doc.version) {
    doc.watcher?.close(); documents.delete(doc.id); await openPaths(doc.owner, [filePath], true);
  } else await openPaths(doc.owner, [filePath], true);
  return true;
}
async function removeDoc(doc: Internal, discard = false) {
  if (doc.dirty && !discard) {
    const result = await dialog.showMessageBox(windows.get(doc.owner)!.win, { type: 'question', message: `${doc.name} の変更を保存しますか？`, buttons: ['保存', '破棄', 'キャンセル'], defaultId: 0, cancelId: 2 });
    if (result.response === 2) return false;
    if (result.response === 0) {
      if (!await saveDoc(doc)) return false;
      if (!documents.has(doc.id)) { const replacement = windowDocs(doc.owner).find(d => d.id === windows.get(doc.owner)?.active); if (replacement && !replacement.dirty) return removeDoc(replacement, true); }
      if (doc.dirty) return false;
    }
  }
  doc.watcher?.close(); documents.delete(doc.id);
  if (windows.get(doc.owner)?.active === doc.id) setActive(doc.owner, windowDocs(doc.owner).at(-1)?.id ?? null);
  broadcast(); return true;
}
function register(name: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(`folio:${name}`, (event, ...args) => {
    if (!windows.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('許可されていない呼び出しです。');
    return handler(event, ...args);
  });
}
register('snapshot', event => snapshot(event.sender.id));
register('open', async (event, paths) => {
  if (paths !== undefined && (!Array.isArray(paths) || paths.some(p => typeof p !== 'string'))) throw new Error('ファイル指定が不正です。');
  if (!paths) { const result = await dialog.showOpenDialog(windows.get(event.sender.id)!.win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] }); paths = result.filePaths; }
  await openPaths(event.sender.id, paths);
});
register('read', async (event, id) => {
  const doc = owned(event, id);
  if (doc.bytes) return doc.bytes;
  doc.bytes = new Uint8Array(await readFile(doc.path));
  const info = await work<{ encrypted: boolean; signed: boolean; complex: boolean; rotations: number[]; unsupported?: boolean }>('inspect', [doc.path], undefined, undefined, doc.bytes);
  Object.assign(doc, { encrypted: info.encrypted, signed: info.signed, complex: info.complex, unsupported: info.unsupported });
  if (!doc.pages.length && info.rotations.length) { doc.pages = info.rotations.map((rotation, source) => ({ id: `${doc.id}:${source}`, source, rotation })); doc.initial = doc.pages; }
  doc.changed = false; broadcast(); return doc.bytes;
});
register('reload', async (event, id) => { const doc = owned(event, id); if (doc.dirty) throw new Error('先に編集内容を保存するか、変更を破棄してください。'); const owner = doc.owner, file = doc.path; await removeDoc(doc, true); await openPaths(owner, [file], true); });
register('initialize', (event, id, count, rotations, restricted, printAllowed) => {
  const doc = owned(event, id);
  if (!Number.isInteger(count) || count < 1 || count > 200000 || !Array.isArray(rotations) || rotations.length !== count) throw new Error('ページ情報が不正です。');
  if (!doc.pages.length) { doc.pages = rotations.map((rotation: number, source: number) => ({ id: `${doc.id}:${source}`, source, rotation })); doc.initial = doc.pages; }
  doc.restricted = !!restricted || !!doc.unsupported; doc.printAllowed = !!printAllowed; broadcast();
});
register('edit', (event, id, op: Edit) => {
  const doc = owned(event, id); editable(doc);
  const viewedPage = doc.pages[Math.max(0, doc.view.page - 1)]?.id;
  if (!op || !['rotate', 'delete', 'move', 'undo', 'redo'].includes(op.type)) throw new Error('編集操作が不正です。');
  if ('ids' in op && (!Array.isArray(op.ids) || op.ids.some(id => !doc.pages.some(p => p.id === id)))) throw new Error('ページ指定が不正です。');
  if (op.type === 'rotate' && ![90, -90].includes(op.delta)) throw new Error('回転角が不正です。');
  if (op.type === 'undo') { const previous = doc.undo.pop(); if (previous) { doc.redo.push(doc.pages); doc.pages = previous; } }
  else if (op.type === 'redo') { const next = doc.redo.pop(); if (next) { doc.undo.push(doc.pages); doc.pages = next; } }
  else { const next = editPages(doc.pages, op); if (!samePages(next, doc.pages)) { doc.undo.push(doc.pages); doc.redo = []; doc.pages = next; } }
  doc.canUndo = !!doc.undo.length; doc.canRedo = !!doc.redo.length; doc.dirty = !samePages(doc.pages, doc.initial); doc.version++;
  const index = doc.pages.findIndex(p => p.id === viewedPage);
  doc.view = { ...doc.view, page: index >= 0 ? index + 1 : Math.min(doc.view.page, doc.pages.length), top: 0, left: 0 };
  doc.ui.selected = doc.ui.selected.filter(id => doc.pages.some(p => p.id === id));
  broadcast();
});
register('activate', (event, id) => { owned(event, id); setActive(event.sender.id, id); broadcast(); });
register('view', (event, id, view: View) => { const doc = owned(event, id); if (!view || !Number.isFinite(view.page) || !Number.isFinite(view.left) || !Number.isFinite(view.top) || typeof view.scale !== 'string') return; doc.view = view; persisted.views[normalize(doc.path)] = view; schedulePersist(); });
register('ui', (event, id, ui: DocumentUI) => { const doc = owned(event, id); if (!ui || typeof ui.query !== 'string' || !Array.isArray(ui.selected) || !['pages', 'search'].includes(ui.panel)) return; doc.ui = { query: ui.query.slice(0, 5000), sensitive: !!ui.sensitive, selected: ui.selected.filter(id => doc.pages.some(p => p.id === id)), organize: !!ui.organize, panel: ui.panel }; });
register('save', (event, id, selected) => saveDoc(owned(event, id), selected));
register('close', async (event, id, discard) => { const result = await removeDoc(owned(event, id), discard); schedulePersist(); return result; });
register('closeWindow', async event => {
  const owner = event.sender.id, entry = windows.get(owner)!;
  const saved = collectWindows();
  for (const doc of windowDocs(owner)) if (!await removeDoc(doc)) return;
  // saveDoc can open a replacement tab. It has no unsaved changes, so close it too.
  for (const doc of windowDocs(owner)) await removeDoc(doc, true);
  entry.closing = true;
  if (windows.size === 1) { persisted.windows = saved; clearTimeout(persistenceTimer); await persist(true); }
  entry.win.close();
});
register('quit', event => windows.get(event.sender.id)?.win.close());
register('move', (event, id, target?: number) => { const doc = owned(event, id); const dest = target ?? createWindow(); if (!windows.has(dest)) throw new Error('移動先がありません。'); const old = doc.owner; doc.owner = dest; setActive(dest, doc.id); setActive(old, windowDocs(old).at(-1)?.id ?? null); broadcast(); windows.get(dest)?.win.show(); windows.get(dest)?.win.focus(); schedulePersist(); });
register('settings', (_event, value: Partial<Settings>) => { if (value.theme && ['system', 'light', 'dark'].includes(value.theme)) persisted.settings.theme = value.theme; if (value.openMode && ['tab', 'window'].includes(value.openMode)) persisted.settings.openMode = value.openMode; if (typeof value.restore === 'boolean') persisted.settings.restore = value.restore; applyTheme(); broadcast(); schedulePersist(); });
register('clearHistory', () => { persisted.recent = []; persisted.views = {}; broadcast(); schedulePersist(); });
register('external', (_event, url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url); });
register('confirm', async (event, message) => (await dialog.showMessageBox(windows.get(event.sender.id)!.win, { type: 'question', message: String(message).slice(0, 2000), buttons: ['続ける', 'キャンセル'], cancelId: 1 })).response === 0);
register('minimize', event => windows.get(event.sender.id)?.win.minimize());
register('maximize', event => { const win = windows.get(event.sender.id)!.win; win.isMaximized() ? win.unmaximize() : win.maximize(); });
register('chooseMerge', async event => {
  const result = await dialog.showOpenDialog(windows.get(event.sender.id)!.win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  const files = [];
  for (const file of result.filePaths) { const info = await work<{ rotations: number[] }>('inspect', [file]); files.push({ path: file, name: path.basename(file), count: info.rotations.length }); }
  return files;
});
register('cancelMerge', async event => { const running = mergeWorkers.get(event.sender.id); if (running) { running.reject(new Error('結合をキャンセルしました。')); await running.worker.terminate(); mergeWorkers.delete(event.sender.id); } });
register('merge', async (event, paths?: string[]) => {
  const win = windows.get(event.sender.id)!.win;
  if (!paths) paths = (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })).filePaths;
  if (!Array.isArray(paths) || paths.length < 2 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p) || !/\.pdf$/i.test(p))) throw new Error('結合するPDFを2つ以上選択してください。');
  if (!await dialog.showMessageBox(win, { message: '保存済みのPDFを指定順に結合します', detail: paths.map((p, i) => `${i + 1}. ${path.basename(p)}`).join('\n') + '\n\n開いているタブの未保存編集は含まれません。しおり・フォーム等は完全に保持されない場合があります。', buttons: ['結合する', 'キャンセル'], cancelId: 1 }).then(r => r.response === 0)) return;
  const destination = await dialog.showSaveDialog(win, { defaultPath: '結合.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!destination.filePath) return;
  if (paths.some(p => normalize(p) === normalize(destination.filePath!)) || [...documents.values()].some(d => normalize(d.path) === normalize(destination.filePath!))) throw new Error('入力PDFとは異なる保存先を指定してください。');
  const bytes = await work<Uint8Array>('merge', paths, undefined, event.sender.id); await atomicWrite(destination.filePath, bytes); await openPaths(event.sender.id, [destination.filePath], true);
});

register('printBegin', async (event, id) => { const doc = owned(event, id); if (!doc.printAllowed) throw new Error('このPDFの印刷は許可されていません。'); const job = randomUUID(); const root = path.join(app.getPath('userData'), 'print-jobs'); await mkdir(root, { recursive: true }); const dir = await mkdtemp(path.join(root, 'job-')); jobs.set(job, { owner: event.sender.id, dir, pages: [] }); return job; });
function jobFor(event: IpcMainInvokeEvent, id: string) { const job = jobs.get(id); if (!job || job.owner !== event.sender.id) throw new Error('印刷ジョブが見つかりません。'); return job; }
register('printPage', async (event, id, index, data, width, height) => { const job = jobFor(event, id); if (!Number.isInteger(index) || index !== job.pages.length || !(data instanceof Uint8Array) || data.length > 200_000_000 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('印刷データが不正です。'); const file = path.join(job.dir, `${index}.png`); await writeFile(file, data); job.pages.push({ file, width, height }); });
register('printCancel', async (event, id) => { const job = jobFor(event, id); job.win?.destroy(); await rm(job.dir, { recursive: true, force: true }); jobs.delete(id); });
register('printEnd', async (event, id) => {
  const job = jobFor(event, id); if (!job.pages.length) throw new Error('印刷するページがありません。');
  try {
    const css = job.pages.map((p, i) => `@page p${i}{size:${p.width}pt ${p.height}pt;margin:0} .p${i}{page:p${i};width:${p.width}pt;height:${p.height}pt}`).join('');
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><style>html,body{margin:0;padding:0} ${css} section{break-after:page;overflow:hidden}section:last-child{break-after:auto}img{width:100%;height:100%;display:block}</style></head><body>${job.pages.map((p, i) => `<section class="p${i}"><img src="${i}.png"></section>`).join('')}</body></html>`;
    await writeFile(path.join(job.dir, 'print.html'), html);
    const win = new BrowserWindow({ show: false, parent: windows.get(event.sender.id)!.win, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } }); job.win = win;
    await win.loadFile(path.join(job.dir, 'print.html'));
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.decode()))');
    return await new Promise<string>((resolve, reject) => win.webContents.print({ silent: false, printBackground: true, margins: { marginType: 'none' }, usePrinterDefaultPageSize: true }, (success, reason) => { if (success) resolve('プリンターに送信しました'); else if (/cancel/i.test(reason)) resolve('印刷をキャンセルしました'); else reject(new Error(reason || '印刷に失敗しました')); }));
  } finally { job.win?.destroy(); await rm(job.dir, { recursive: true, force: true }); jobs.delete(id); }
});

if (process.env.FOLIO_USER_DATA) app.setPath('userData', process.env.FOLIO_USER_DATA);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', (_event, argv) => { const owner = BrowserWindow.getFocusedWindow()?.webContents.id ?? [...windows.keys()][0]; if (owner) { windows.get(owner)?.win.restore(); windows.get(owner)?.win.focus(); void openPaths(owner, argv.filter(p => /\.pdf$/i.test(p))); } });
  app.whenReady().then(async () => {
    try { const saved = JSON.parse(await readFile(statePath(), 'utf8')); persisted = { ...persisted, ...saved, settings: { ...defaults, ...saved.settings } }; } catch { /* first launch */ }
    if (!['system', 'light', 'dark'].includes(persisted.settings.theme)) persisted.settings.theme = 'system';
    if (!Array.isArray(persisted.windows)) persisted.windows = [];
    persisted.windows = persisted.windows.filter(w => Array.isArray(w.paths));
    if (!Array.isArray(persisted.recent)) persisted.recent = [];
    if (!persisted.views || typeof persisted.views !== 'object') persisted.views = {};
    await rm(path.join(app.getPath('userData'), 'print-jobs'), { recursive: true, force: true }).catch(() => {});
    applyTheme();
    const previous = persisted.windows;
    const requested = process.argv.filter(p => /\.pdf$/i.test(p) && path.isAbsolute(p));
    const owner = createWindow(previous[0]?.bounds);
    if (requested.length) await openPaths(owner, requested, true);
    if (persisted.settings.restore) {
      for (const [index, entry] of previous.entries()) {
        const target = index === 0 ? owner : createWindow(entry.bounds);
        for (const file of entry.paths) { try { await stat(file); await openPaths(target, [file], true); } catch { /* shown in recent list as missing when reopened */ } }
        const active = windowDocs(target).find(d => d.path === entry.active); if (active && !requested.length) setActive(target, active.id);
      }
    }
    broadcast();
  }).catch(console.error);
  app.on('window-all-closed', () => { shuttingDown = true; app.quit(); });
}
