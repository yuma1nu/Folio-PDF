import { watch, watchFile, unwatchFile } from 'node:fs';

type FileStamp = { nlink: number; size: number; mtimeMs: number; ctimeMs: number };
type NativeMonitor = { on(event: 'error', listener: (error: Error) => void): unknown; close(): void };
type PollListener = (current: FileStamp, previous: FileStamp) => void;
type MonitorIO = {
  watch(file: string, listener: () => void): NativeMonitor;
  watchFile(file: string, options: { persistent: boolean; interval: number }, listener: PollListener): unknown;
  unwatchFile(file: string, listener: PollListener): void;
};
const io: MonitorIO = { watch, watchFile, unwatchFile };

/** Monitoring is supplementary: a failed SMB watcher must not fail PDF opening. */
export function monitorFile(file: string, initial: FileStamp, onChange: () => void, onError: (error: unknown) => void, fs: MonitorIO = io): { close(): void } {
  let native: NativeMonitor | undefined;
  let polling = false;
  let closed = false;
  let lastAvailable = initial;
  const poll: PollListener = current => {
    // Network disconnects can report zeroed stats. Retain the last valid stamp
    // so reconnecting neither invents a change nor loses a real modification.
    if (closed || current.nlink === 0) return;
    const changed = current.size !== lastAvailable.size || current.mtimeMs !== lastAvailable.mtimeMs || current.ctimeMs !== lastAvailable.ctimeMs;
    lastAvailable = current;
    if (changed) onChange();
  };
  const fallback = (error: unknown) => {
    if (closed || polling) return;
    native?.close(); native = undefined;
    onError(error);
    polling = true;
    try { fs.watchFile(file, { persistent: false, interval: 5000 }, poll); }
    catch (pollError) { polling = false; onError(pollError); }
  };
  try {
    native = fs.watch(file, () => { if (!closed) onChange(); });
    // try/catch only catches watch() setup errors, not later EventEmitter errors.
    native.on('error', fallback);
  } catch (error) { fallback(error); }
  return { close() {
    if (closed) return;
    closed = true;
    native?.close(); native = undefined;
    if (polling) { fs.unwatchFile(file, poll); polling = false; }
  } };
}
