import { WorkerWidget, type WorkerPanelHost } from "./activity.ts";

export const UI_PANELS_PROBE = "ui-kit:v1:probe";
export const UI_PANELS_READY = "ui-kit:v1:ready";
export const UI_PANELS_STOPPED = "ui-kit:v1:stopped";

type PanelEvents = {
  on?(event: string, handler: (payload: unknown) => void): unknown;
  emit?(event: string, payload: unknown): void;
};

function isHost(value: unknown): value is WorkerPanelHost {
  return !!value &&
    typeof (value as WorkerPanelHost).upsert === "function" &&
    typeof (value as WorkerPanelHost).remove === "function";
}

// Local structural adapter for the optional ui-kit extension. It deliberately
// does not import that extension: extensions are loaded independently and the
// callbacks are trusted in-process.
export function installUiPanels(pi: { events?: PanelEvents }, widget: WorkerWidget) {
  const events = pi.events;
  let activeTui = false;
  let disposed = false;
  let host: WorkerPanelHost | undefined;
  let unsubscribeReady: unknown;
  let unsubscribeStopped: unknown;
  let subscribed = false;
  let generation = 0;

  const emit = (event: string, payload: unknown) => {
    try { events?.emit?.(event, payload); } catch { /* Optional provider may be absent. */ }
  };

  const attach = (candidate: unknown, token: number) => {
    if (!isHost(candidate) || disposed || !activeTui || token !== generation) return;
    host = candidate;
    widget.attachHost(candidate);
  };

  const detach = (candidate: unknown, token: number) => {
    if (candidate !== host || token !== generation) return;
    widget.detachHost(candidate as WorkerPanelHost);
    host = undefined;
  };

  const subscribe = (token: number) => {
    if (!events || subscribed) return;
    subscribed = true;
    unsubscribeReady = events.on?.(UI_PANELS_READY, candidate => attach(candidate, token));
    unsubscribeStopped = events.on?.(UI_PANELS_STOPPED, candidate => detach(candidate, token));
  };

  const unsubscribe = () => {
    if (typeof unsubscribeReady === "function") unsubscribeReady();
    if (typeof unsubscribeStopped === "function") unsubscribeStopped();
    unsubscribeReady = undefined;
    unsubscribeStopped = undefined;
    subscribed = false;
  };

  function start(ctx: { mode?: string; hasUI?: boolean; ui?: unknown }) {
    const token = ++generation;
    disposed = false;
    unsubscribe();
    activeTui = ctx.mode === "tui" && ctx.hasUI === true && !!ctx.ui;
    if (!activeTui) {
      widget.detachHost();
      widget.setUI(undefined);
      host = undefined;
      return;
    }
    subscribe(token);
    widget.setUI(ctx.ui);
    emit(UI_PANELS_PROBE, {
      accept: (candidate: WorkerPanelHost) => {
        attach(candidate, token);
      },
    });
  }

  function stop() {
    generation++;
    activeTui = false;
    disposed = true;
    widget.dispose();
    host = undefined;
    unsubscribe();
  }

  return {
    start,
    stop,
    dispose: stop,
    get host() { return host; },
    unsubscribe,
  };
}
