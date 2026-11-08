import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Bridge } from '../src/shared';
const call = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`folio:${name}`, ...args);
const api: Bridge = {
  snapshot: () => call('snapshot'),
  onChange: fn => { const listener = (_: unknown, state: Parameters<typeof fn>[0]) => fn(state); ipcRenderer.on('folio:state', listener); return () => ipcRenderer.removeListener('folio:state', listener); },
  onCloseRequest: fn => { const listener = () => fn(); ipcRenderer.on('folio:close-request', listener); return () => ipcRenderer.removeListener('folio:close-request', listener); },
  open: paths => call('open', paths), dropped: files => call('open', files.map(f => webUtils.getPathForFile(f))),
  read: id => call('read', id), reload: id => call('reload', id), initialize: (...args) => call('initialize', ...args),
  edit: (...args) => call('edit', ...args), activate: id => call('activate', id), view: (...args) => call('view', ...args), ui: (...args) => call('ui', ...args),
  save: (...args) => call('save', ...args), close: (...args) => call('close', ...args), closeWindow: () => call('closeWindow'),
  move: (...args) => call('move', ...args), merge: paths => call('merge', paths), chooseMerge: () => call('chooseMerge'), cancelMerge: () => call('cancelMerge'),
  settings: value => call('settings', value), clearHistory: () => call('clearHistory'), external: url => call('external', url),
  printBegin: id => call('printBegin', id), printPage: (...args) => call('printPage', ...args), printEnd: job => call('printEnd', job), printCancel: job => call('printCancel', job),
  confirm: message => call('confirm', message), minimize: () => { void call('minimize'); }, maximize: () => { void call('maximize'); }, quit: () => { void call('quit'); }
};
contextBridge.exposeInMainWorld('folio', api);
