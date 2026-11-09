import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { monitorFile } from '../electron/file-monitor.ts';

const initial = { nlink: 1, size: 1200, mtimeMs: 100, ctimeMs: 100 };
function setup(failAtStart = false) {
  let changes = 0, nativeClosed = 0, pollStarted = 0, pollStopped = 0;
  let poll: ((current: typeof initial, previous: typeof initial) => void) | undefined;
  let nativeChange: (() => void) | undefined;
  const errors: unknown[] = [];
  const watcher = Object.assign(new EventEmitter(), { close() { nativeClosed++; } });
  const monitor = monitorFile('Z:\\drawings\\test.pdf', initial, () => changes++, error => errors.push(error), {
    watch(_file, listener) { if (failAtStart) throw new Error('UNKNOWN: unknown error, watch'); nativeChange = listener; return watcher; },
    watchFile(_file, options, listener) { assert.equal(options.interval, 5000); assert.equal(options.persistent, false); pollStarted++; poll = listener; },
    unwatchFile(_file, listener) { assert.equal(listener, poll); pollStopped++; }
  });
  return { monitor, watcher, nativeChange: () => nativeChange?.(), poll: (value: typeof initial) => poll?.(value, initial), errors,
    counts: () => ({ changes, nativeClosed, pollStarted, pollStopped }) };
}
test('asynchronous UNKNOWN watch error is handled and monitoring switches to polling', () => {
  const state = setup();
  assert.doesNotThrow(() => state.watcher.emit('error', new Error('UNKNOWN: unknown error, watch')));
  assert.equal(state.counts().pollStarted, 1); assert.equal(state.counts().nativeClosed, 1);
  state.watcher.emit('error', new Error('another queued error'));
  assert.equal(state.counts().pollStarted, 1);
  state.poll({ ...initial, size: 1300 }); assert.equal(state.counts().changes, 1);
  state.monitor.close(); state.monitor.close(); assert.equal(state.counts().pollStopped, 1);
});
test('network disconnect and reconnect preserve baseline without false changes', () => {
  const state = setup(true);
  state.poll({ nlink: 0, size: 0, mtimeMs: 0, ctimeMs: 0 }); state.poll(initial);
  assert.equal(state.counts().changes, 0);
  state.poll({ ...initial, mtimeMs: 200 }); state.poll({ ...initial, mtimeMs: 200 });
  assert.equal(state.counts().changes, 1);
  state.monitor.close();
  state.poll({ ...initial, size: 500 }); assert.equal(state.counts().changes, 1);
});
test('normal local watching is retained and late errors after close cannot restart it', () => {
  const state = setup(); state.nativeChange(); assert.equal(state.counts().changes, 1);
  assert.equal(state.counts().pollStarted, 0); state.monitor.close();
  assert.doesNotThrow(() => state.watcher.emit('error', new Error('late error')));
  assert.equal(state.counts().pollStarted, 0);
});
