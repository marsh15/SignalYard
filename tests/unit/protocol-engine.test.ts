import { describe, expect, it, vi, afterEach } from "vitest";
import { diffJson } from "@/protocol/contextDiff";
import { createInitialSnapshot, ProtocolEngine } from "@/protocol/engine";
import type { ClientMessage } from "@/protocol/types";

const originalWebSocket = globalThis.WebSocket;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = TestWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = TestWebSocket.CLOSED;
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  closeFromServer() {
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }
}

function installTestWebSocket() {
  TestWebSocket.instances = [];
  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
}

function makeEngine(options: { ackFallbackMs?: number } = {}) {
  const outbound: ClientMessage[] = [];
  const engine = new ProtocolEngine({
    sender: (message) => outbound.push(message),
    ackFallbackMs: options.ackFallbackMs
  });
  return { engine, outbound };
}

function makeHydratedEngine(snapshot: ReturnType<typeof createInitialSnapshot>) {
  const outbound: ClientMessage[] = [];
  const storageKey = `protocol-test-${crypto.randomUUID()}`;
  window.sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      version: 1,
      snapshot
    })
  );

  const engine = new ProtocolEngine({
    sender: (message) => outbound.push(message),
    storageKey
  });

  return { engine, outbound, storageKey };
}

afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
  globalThis.WebSocket = originalWebSocket;
});

describe("ProtocolEngine ordering and replay", () => {
  it("buffers out-of-order events until the missing seq arrives", () => {
    const { engine } = makeEngine();

    engine.ingest({ type: "TOKEN", seq: 2, stream_id: "main", text: "world" });
    expect(engine.getSnapshot().workItems).toHaveLength(0);
    expect(engine.getSnapshot().nextExpectedSeq).toBe(1);

    engine.ingest({ type: "RUN_STARTED", seq: 1, title: "run" });
    const snapshot = engine.getSnapshot();
    expect(snapshot.nextExpectedSeq).toBe(3);
    expect(snapshot.pendingRenderSeq).toBe(2);
    expect(snapshot.workItems).toEqual([
      {
        kind: "tokens",
        id: "tokens-main-2",
        streamId: "main",
        text: "world",
        startSeq: 2,
        endSeq: 2,
        frozen: false
      }
    ]);

    engine.dispose();
  });

  it("deduplicates replayed seqs without appending duplicate text", () => {
    const { engine } = makeEngine();

    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "A" });
    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "A" });

    const tokenItem = engine.getSnapshot().workItems[0];
    expect(tokenItem?.kind).toBe("tokens");
    expect(tokenItem?.kind === "tokens" ? tokenItem.text : "").toBe("A");
    expect(engine.getSnapshot().chaos[0]?.label).toBe("Duplicate seq");

    engine.dispose();
  });

  it("assigns unique timeline ids to repeated duplicate drops", () => {
    const { engine } = makeEngine();

    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "A" });
    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "A" });
    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "A" });

    const duplicateRows = engine.getSnapshot().timelineRows.filter((row) => row.kind === "DUPLICATE");

    expect(duplicateRows).toHaveLength(2);
    expect(new Set(duplicateRows.map((row) => row.id)).size).toBe(duplicateRows.length);

    engine.dispose();
  });

  it("continues duplicate timeline ids after hydration", () => {
    const snapshot = createInitialSnapshot();
    snapshot.lastRenderedSeq = 1;
    snapshot.pendingRenderSeq = 1;
    snapshot.nextExpectedSeq = 2;
    snapshot.timelineRows = [
      {
        id: "token-main-1",
        kind: "TOKEN",
        seq: 1,
        endSeq: 1,
        streamId: "main",
        text: "A"
      },
      {
        id: "duplicate-1-TOKEN-1",
        kind: "DUPLICATE",
        seq: 1,
        endSeq: 1,
        label: "Duplicate dropped",
        detail: "TOKEN",
        severity: "warning"
      }
    ];

    const { engine } = makeHydratedEngine(snapshot);

    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "A" });

    const duplicateIds = engine
      .getSnapshot()
      .timelineRows.filter((row) => row.kind === "DUPLICATE")
      .map((row) => row.id);

    expect(duplicateIds).toEqual(["duplicate-1-TOKEN-1", "duplicate-1-TOKEN-2"]);

    engine.dispose();
  });

  it("processes reversed seq bursts in order", () => {
    const { engine } = makeEngine();

    engine.ingest({ type: "TOKEN", seq: 3, stream_id: "main", text: "C" });
    engine.ingest({ type: "TOKEN", seq: 2, stream_id: "main", text: "B" });
    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "A" });

    const tokenItem = engine.getSnapshot().workItems[0];
    expect(tokenItem?.kind === "tokens" ? tokenItem.text : "").toBe("ABC");
    expect(engine.getSnapshot().lastRenderedSeq).toBe(0);

    engine.commitRenderedSeq(3);
    expect(engine.getSnapshot().lastRenderedSeq).toBe(3);

    engine.dispose();
  });
});

describe("ProtocolEngine control plane", () => {
  it("replies to PING immediately, including an empty challenge", () => {
    const { engine, outbound } = makeEngine();

    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "ok" });
    engine.commitRenderedSeq(1);
    engine.ingest({ type: "PING", seq: 2, challenge: "" });

    expect(outbound).toContainEqual({
      type: "PONG",
      echo: ""
    });
    expect(engine.getSnapshot().timelineRows.some((row) => row.kind === "PONG")).toBe(true);

    engine.dispose();
  });

  it("normalizes malformed PING challenges instead of recording parser errors", () => {
    const { engine, outbound } = makeEngine();

    engine.ingest({ type: "PING", seq: 1, challenge: null });
    engine.ingest({ type: "PING", seq: 2, challenge: 42 });

    expect(outbound).toContainEqual({ type: "PONG", echo: "" });
    expect(outbound).toContainEqual({ type: "PONG", echo: "42" });
    expect(engine.getSnapshot().parseErrors).toEqual([]);

    engine.dispose();
  });

  it("does not reply again when a PING seq is replayed", () => {
    const { engine, outbound } = makeEngine();

    engine.ingest({ type: "PING", seq: 1, challenge: "chaos-1" });
    engine.ingest({ type: "PING", seq: 1, challenge: "chaos-1" });

    expect(outbound.filter((message) => message.type === "PONG")).toEqual([
      {
        type: "PONG",
        echo: "chaos-1"
      }
    ]);
    expect(engine.getSnapshot().timelineRows.filter((row) => row.kind === "PONG")).toHaveLength(1);
    expect(engine.getSnapshot().stats.duplicateSeqs).toBe(1);

    engine.dispose();
  });

  it("does not answer historical PINGs during a resume replay burst", () => {
    vi.useFakeTimers();
    installTestWebSocket();
    const snapshot = createInitialSnapshot();
    snapshot.lastRenderedSeq = 11;
    snapshot.pendingRenderSeq = 11;
    snapshot.nextExpectedSeq = 12;
    const { engine, outbound } = makeHydratedEngine(snapshot);

    engine.connect();
    TestWebSocket.instances[0]?.open();
    engine.ingest({ type: "PING", seq: 12, challenge: "old-heartbeat" });

    expect(outbound).toContainEqual({ type: "RESUME", last_seq: 11 });
    expect(outbound.filter((message) => message.type === "PONG")).toHaveLength(0);
    expect(engine.getSnapshot().timelineRows.filter((row) => row.kind === "PING")).toHaveLength(1);
    expect(engine.getSnapshot().timelineRows.filter((row) => row.kind === "PONG")).toHaveLength(0);

    vi.advanceTimersByTime(750);
    engine.ingest({ type: "PING", seq: 13, challenge: "live-heartbeat" });

    expect(outbound.filter((message) => message.type === "PONG")).toEqual([
      {
        type: "PONG",
        echo: "live-heartbeat"
      }
    ]);

    engine.dispose();
  });

  it("tracks duplicate and gap counters", () => {
    const { engine } = makeEngine();

    engine.ingest({ type: "TOKEN", seq: 2, stream_id: "main", text: "gap" });
    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "first" });
    engine.ingest({ type: "TOKEN", seq: 2, stream_id: "main", text: "gap" });

    expect(engine.getSnapshot().stats.gapBuffered).toBe(1);
    expect(engine.getSnapshot().stats.duplicateSeqs).toBe(1);

    engine.dispose();
  });
});

describe("ProtocolEngine WebSocket lifecycle", () => {
  it("does not reconnect after an intentional disconnect", () => {
    vi.useFakeTimers();
    installTestWebSocket();
    const engine = new ProtocolEngine();

    engine.connect();
    const socket = TestWebSocket.instances[0];
    socket?.open();
    engine.disconnect();
    socket?.closeFromServer();
    vi.advanceTimersByTime(10_000);

    expect(TestWebSocket.instances).toHaveLength(1);
    expect(engine.getSnapshot().connection.status).toBe("closed");

    engine.dispose();
  });

  it("ignores close events from sockets that have already been replaced", () => {
    vi.useFakeTimers();
    installTestWebSocket();
    const engine = new ProtocolEngine();

    engine.connect();
    const staleSocket = TestWebSocket.instances[0];
    staleSocket?.open();
    if (staleSocket) {
      staleSocket.readyState = TestWebSocket.CLOSING;
    }
    engine.connect();

    expect(TestWebSocket.instances).toHaveLength(2);

    staleSocket?.closeFromServer();
    vi.advanceTimersByTime(500);

    expect(TestWebSocket.instances).toHaveLength(2);

    engine.dispose();
  });
});

describe("ProtocolEngine tool ACK policy", () => {
  it("sends normal TOOL_ACK after the tool card is committed", () => {
    const { engine, outbound } = makeEngine();

    engine.ingest({ type: "RUN_STARTED", seq: 1, title: "run" });
    engine.ingest({
      type: "TOOL_CALL",
      seq: 2,
      stream_id: "main",
      call_id: "tool_1",
      tool_name: "lookup",
      args: { id: "1" }
    });

    expect(outbound.some((message) => message.type === "TOOL_ACK")).toBe(false);
    engine.commitRenderedSeq(2);

    expect(outbound).toContainEqual({
      type: "TOOL_ACK",
      call_id: "tool_1"
    });

    engine.dispose();
  });

  it("sends one fallback TOOL_ACK when an out-of-order tool call is blocked", () => {
    vi.useFakeTimers();
    const { engine, outbound } = makeEngine({ ackFallbackMs: 1_500 });

    engine.ingest({
      type: "TOOL_CALL",
      seq: 2,
      stream_id: "main",
      call_id: "tool_gap",
      tool_name: "blocked.lookup",
      args: { id: "gap" }
    });

    vi.advanceTimersByTime(1_500);
    engine.ingest({ type: "RUN_STARTED", seq: 1, title: "run" });
    engine.commitRenderedSeq(2);

    const ackMessages = outbound.filter((message) => message.type === "TOOL_ACK");
    expect(ackMessages).toHaveLength(1);
    expect(ackMessages[0]).toMatchObject({
      call_id: "tool_gap"
    });
    expect(engine.getSnapshot().toolCards.tool_gap?.ackStatus).toBe("fallback-sent");

    engine.dispose();
  });

  it("sends fallback TOOL_ACK for an in-order tool call if render commit is delayed", () => {
    vi.useFakeTimers();
    const { engine, outbound } = makeEngine({ ackFallbackMs: 250 });

    engine.ingest({ type: "RUN_STARTED", seq: 1, title: "run" });
    engine.ingest({
      type: "TOOL_CALL",
      seq: 2,
      stream_id: "main",
      call_id: "tool_slow_render",
      tool_name: "search.logs",
      args: { query: "q3" }
    });

    vi.advanceTimersByTime(250);
    engine.commitRenderedSeq(2);

    const ackMessages = outbound.filter((message) => message.type === "TOOL_ACK");
    expect(ackMessages).toHaveLength(1);
    expect(ackMessages[0]).toMatchObject({
      call_id: "tool_slow_render"
    });
    expect(engine.getSnapshot().toolCards.tool_slow_render?.ackStatus).toBe("fallback-sent");

    engine.dispose();
  });

  it("does not send fallback TOOL_ACK when post-render ACK wins first", () => {
    vi.useFakeTimers();
    const { engine, outbound } = makeEngine({ ackFallbackMs: 250 });

    engine.ingest({ type: "RUN_STARTED", seq: 1, title: "run" });
    engine.ingest({
      type: "TOOL_CALL",
      seq: 2,
      stream_id: "main",
      call_id: "tool_fast_render",
      tool_name: "search.logs",
      args: { query: "q3" }
    });

    engine.commitRenderedSeq(2);
    vi.advanceTimersByTime(250);

    const ackMessages = outbound.filter((message) => message.type === "TOOL_ACK");
    expect(ackMessages).toHaveLength(1);
    expect(engine.getSnapshot().toolCards.tool_fast_render?.ackStatus).toBe("sent");

    engine.dispose();
  });

  it("rebuilds pending tool ACK state after hydration and flushes rendered tools", () => {
    const snapshot = createInitialSnapshot();
    snapshot.lastRenderedSeq = 2;
    snapshot.pendingRenderSeq = 2;
    snapshot.nextExpectedSeq = 3;
    snapshot.toolCards.tool_resume = {
      id: "tool_resume",
      seq: 2,
      streamId: "main",
      name: "search.logs",
      input: { query: "ack timeout" },
      status: "pending",
      ackStatus: "pending-render"
    };

    const { engine, outbound } = makeHydratedEngine(snapshot);

    engine.commitRenderedSeq(2);

    expect(outbound).toContainEqual({
      type: "TOOL_ACK",
      call_id: "tool_resume"
    });
    expect(engine.getSnapshot().toolCards.tool_resume?.ackStatus).toBe("sent");

    engine.dispose();
  });

  it("does not resend a fallback ACK after hydration", () => {
    const snapshot = createInitialSnapshot();
    snapshot.lastRenderedSeq = 2;
    snapshot.pendingRenderSeq = 2;
    snapshot.nextExpectedSeq = 3;
    snapshot.toolCards.tool_resume_fallback = {
      id: "tool_resume_fallback",
      seq: 2,
      streamId: "main",
      name: "search.logs",
      input: { query: "already acked" },
      status: "acked",
      ackStatus: "fallback-sent"
    };

    const { engine, outbound } = makeHydratedEngine(snapshot);

    engine.commitRenderedSeq(2);

    expect(outbound.filter((message) => message.type === "TOOL_ACK")).toHaveLength(0);

    engine.dispose();
  });

  it("freezes token text at a tool boundary and resumes in a new block", () => {
    const { engine } = makeEngine();

    engine.ingest({ type: "TOKEN", seq: 1, stream_id: "main", text: "before " });
    engine.ingest({
      type: "TOOL_CALL",
      seq: 2,
      stream_id: "main",
      call_id: "tool_2",
      tool_name: "lookup",
      args: { id: "2" }
    });
    engine.ingest({ type: "TOKEN", seq: 3, stream_id: "main", text: "after" });

    const [first, tool, second] = engine.getSnapshot().workItems;
    expect(first?.kind === "tokens" ? first.frozen : false).toBe(true);
    expect(tool?.kind).toBe("tool");
    expect(second?.kind === "tokens" ? second.text : "").toBe("after");

    engine.dispose();
  });
});

describe("context diffing", () => {
  it("marks added, removed, and changed JSON paths", () => {
    const diff = diffJson(
      {
        keep: true,
        remove: "old",
        nested: { count: 1 },
        list: ["a", "b"]
      },
      {
        keep: true,
        add: "new",
        nested: { count: 2 },
        list: ["a"]
      }
    );

    expect(diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.add", status: "added" }),
        expect.objectContaining({ path: "$.remove", status: "removed" }),
        expect.objectContaining({ path: "$.nested.count", status: "changed" }),
        expect.objectContaining({ path: "$.list[1]", status: "removed" })
      ])
    );
  });
});
