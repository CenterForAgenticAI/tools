import { constants, homedir } from "node:os";
import { resolve } from "node:path";

import { Editor, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, type Terminal } from "@earendil-works/pi-tui";

import { connectDaemon, DaemonRequestError, type DaemonAttachment, type DaemonClient } from "../client/index.js";
import { DAEMON_VERSION } from "../daemon/bootstrap.js";
import { loadSavedState, saveSavedState, savedStatePath, SAVED_STATE_VERSION, type SavedState } from "./saved-state.js";
import { chooseFocus, connectingView, observingView, reduceFrame, viewLines, type TuiViewModel } from "./view-model.js";

export * from "./saved-state.js";

export interface TuiOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly terminal?: Terminal;
  /** Receives the same pure projection that drives the terminal; useful for integration tests. */
  readonly onView?: (view: TuiViewModel) => void;
}

function endpoint(environment: NodeJS.ProcessEnv): string {
  const socket = environment.PI_DAEMON_SOCKET;
  if (socket !== undefined) return socket;
  if (environment.XDG_RUNTIME_DIR !== undefined) {
    return resolve(environment.XDG_RUNTIME_DIR, "pi-daemon", "pi-daemon.sock");
  }
  return resolve(environment.HOME ?? homedir(), ".local", "state", "pi-daemon", "run", "pi-daemon.sock");
}

/** A read-only TUI: neither observation nor quitting obtains authority or changes session lifecycle. */
export async function runTui(options: TuiOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const header = new Text();
  const transcript = new Text();
  const footer = new Text();
  const editor = new Editor(tui, {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text, selectedText: (text) => text,
      description: (text) => text, scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  });
  editor.disableSubmit = true;
  // Do not focus the editor or forward input to it: even drafts must not be accepted in observing mode.
  const layout = new VStack([
    header, { component: new ScrollView(transcript, { primary: true, follow: "end" }), grow: 1 },
    footer, editor,
  ]);
  tui.setLayoutRoot(layout);
  let view = connectingView();
  const render = (): void => {
    const lines = viewLines(view);
    header.setText(lines.header);
    transcript.setText(lines.transcript);
    footer.setText(lines.footer);
    options.onView?.(view);
    tui.requestRender();
  };
  let quit: (() => void) | undefined;
  let quitting = false;
  let terminationSignal: NodeJS.Signals | undefined;
  const exit = new Promise<void>((resolveExit) => { quit = resolveExit; });
  const requestQuit = (): void => { quitting = true; quit?.(); };
  const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = (): void => {
      terminationSignal ??= signal;
      requestQuit();
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  let client: DaemonClient | undefined;
  let attachment: DaemonAttachment | undefined;
  let stream: Promise<void> | undefined;
  let replayChecked = false;
  let started = false;
  try {
    tui.addInputListener((data) => {
      if (data === "q" || data === "Q" || data === "\u0003" || data === "\u0004") {
        requestQuit();
      }
      return { consume: true };
    });
    started = true;
    tui.start();
    render();
    const path = savedStatePath({ socketPath: endpoint(environment), environment });
    const loaded = await Promise.race([loadSavedState(path), exit.then(() => undefined)]);
    if (quitting) return;
    const state: SavedState = loaded?.kind === "loaded" ? loaded.state : {
      version: SAVED_STATE_VERSION, focusedSessionId: null, sessions: [],
    };
    const connecting = connectDaemon({ environment, autoSpawn: true,
      client: { name: "pi-daemon-tui", version: DAEMON_VERSION },
    });
    // Keep a connection that finishes after quit from leaking; closing it has no session effect.
    void connecting.then((opened) => { if (quitting) opened.close(); }).catch(() => undefined);
    client = await Promise.race([connecting, exit.then(() => undefined)]);
    if (quitting || client === undefined) return;
    const list = await Promise.race([client.request("list", {}), exit.then(() => undefined)]);
    if (quitting || list === undefined) return;
    const selected = chooseFocus(list.sessions, state.focusedSessionId);
    if (selected === null) {
      view = { ...connectingView(), screen: "empty" };
      render();
      await exit;
      return;
    }
    // A saved cursor is only a checkpoint, not a transcript. Replay from the beginning on every run.
    attachment = await Promise.race([client.attach(selected.sessionId, { fromCursor: null, live: true }), exit.then(() => undefined)]);
    if (quitting || attachment === undefined) return;
    view = observingView(attachment.result.session);
    if (attachment.result.replay.outcome === "cursor_off_branch") {
      view = { ...view, notices: ["Cursor off branch: replay is not continuous."] };
    }
    if (selected.observedPhase === "asleep" || selected.observedPhase === "gone") {
      view = { ...view, notices: [...view.notices, `Session ${selected.observedPhase}; observing saved history only.`] };
    }
    if (state.focusedSessionId !== selected.sessionId && !quitting) {
      // Focus is metadata; no cursor is invented before a committed entry is processed.
      await saveSavedState(path, { version: SAVED_STATE_VERSION, focusedSessionId: selected.sessionId,
        sessions: state.sessions });
    }
    render();
    const activeClient = client;
    const activeAttachment = attachment;
    stream = (async () => {
      for await (const frame of activeAttachment) {
        if (quitting) break;
        const previous = view;
        view = reduceFrame(view, frame);
        render();
        if (frame.kind === "entry" && frame.generation === activeAttachment.result.session.generation &&
          view.committedCursor !== previous.committedCursor) {
          const cursor = view.committedCursor;
          if (cursor === null) throw new Error("processed entry lacks committed cursor");
          const updated: SavedState = {
            version: SAVED_STATE_VERSION, focusedSessionId: selected.sessionId,
            sessions: [...state.sessions.filter((item) => item.id !== selected.sessionId),
              { id: selected.sessionId, committedCursor: cursor }],
          };
          await saveSavedState(path, updated);
          await activeAttachment.acknowledge(frame);
        }
        if (frame.kind === "daemon" && frame.name === "replay_end") {
          const stored = state.sessions.find((item) => item.id === selected.sessionId)?.committedCursor;
          if (stored !== undefined && !quitting && !replayChecked) {
            replayChecked = true;
            try {
              const replay = await activeClient.request("replay", {
                attachmentId: activeAttachment.attachmentId, fromCursor: stored,
              }, selected.sessionId);
              if (replay.outcome === "cursor_off_branch") {
                view = { ...view, notices: [...view.notices,
                  `Cursor off branch (${stored.entryId ?? "start"}); full active history was rebuilt from the beginning.`] };
                render();
              }
            } catch (error) {
              if (!(error instanceof DaemonRequestError)) throw error;
              view = { ...view, notices: [...view.notices, `Saved cursor unavailable: ${error.code}: ${error.message}; full history was rebuilt.`] };
              render();
            }
          }
        }
      }
    })();
    await Promise.race([stream, exit]);
  } finally {
    quitting = true;
    // Closing the socket ends the attachment without sleeping or aborting the session.
    client?.close();
    try {
      // The stream may have been awaiting socket input when quit was requested.
      await stream?.catch(() => undefined);
    } finally {
      try {
        if (started) tui.stop();
      } finally {
        for (const [signal, handler] of signalHandlers) process.off(signal, handler);
        if (terminationSignal !== undefined) {
          // Cleanup is complete; exit here so the CLI wrapper cannot replace the signal status with 0.
          process.exit(128 + constants.signals[terminationSignal]);
        }
      }
    }
  }
}
