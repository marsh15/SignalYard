import { describe, expect, it, vi, afterEach } from "vitest";
import { diffJson } from "@/protocol/contextDiff";
import { ProtocolEngine } from "@/protocol/engine";
import type { ClientMessage } from "@/protocol/types";

function makeEngine(options: { ackFallbackMs?: number } = {}) {
  const outbound: ClientMessage[] = [];
  const engine = new ProtocolEngine({
    sender: (message) => outbound.push(message),
    ackFallbackMs: options.ackFallbackMs
  });
  return { engine, outbound };
}

afterEach(() => {
  vi.useRealTimers();
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
