import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { terminalResizeWidget } from "./tmux-redraw.ts";

test("resize resets the frame even at unchanged dimensions; bursts coalesce and dispose cancels", async () => {
  const signals = new EventEmitter();
  const calls = [];
  const widget = terminalResizeWidget({ requestRender: force => calls.push(force) }, signals);
  assert.deepEqual(widget.render(80), []);
  widget.invalidate();
  signals.emit("SIGWINCH");
  signals.emit("SIGWINCH");
  await new Promise(setImmediate);
  assert.deepEqual(calls, [true]);
  signals.emit("SIGWINCH");
  widget.dispose();
  widget.dispose();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [true]);
  assert.equal(signals.listenerCount("SIGWINCH"), 0);
});
