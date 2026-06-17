import { diffJson, type ContextDiffResponse } from "./contextDiff";
import {
  type ChaosBadge,
  type ClientMessage,
  type ConnectionStatus,
  type ContextRecord,
  type EngineSnapshot,
  type JsonValue,
  type ServerMessage,
  type TimelineEventRow,
  type TimelineRow,
  type ToolCallEvent,
  type ToolCard,
  type WorkItem,
  parseServerMessage
} from "./types";

type Listener = () => void;
type Sender = (message: ClientMessage) => void;
type TimerHandle = ReturnType<typeof setTimeout>;
type ToolAckReason = "post-render" | "fallback-timeout";

interface ProtocolEngineOptions {
  url?: string;
  sender?: Sender;
  connectOnCreate?: boolean;
  ackFallbackMs?: number;
  heartbeatTimeoutMs?: number;
  storageKey?: string;
}

const DEFAULT_URL = "ws://localhost:4747/ws";
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 10_000] as const;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 18_000;
const STORAGE_VERSION = 1;

export function createInitialSnapshot(url = DEFAULT_URL): EngineSnapshot {
  return {
    connection: {
      status: "idle",
      url,
      attempt: 0
    },
    canSend: false,
    lastRenderedSeq: 0,
    pendingRenderSeq: 0,
    nextExpectedSeq: 1,
    workItems: [],
    toolCards: {},
    timelineRows: [],
    contexts: {},
    timelineFilter: "all",
    timelineSearch: "",
    chaos: [],
    outbound: [],
    parseErrors: [],
    stats: {
      bytesReceived: 0,
      duplicateSeqs: 0,
      gapBuffered: 0
    }
  };
}

function nowId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeJson(value: JsonValue): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length > 120 ? `${rendered.slice(0, 119)}...` : rendered;
}

function isToolRow(row: TimelineRow): boolean {
  return row.kind === "TOOL_CALL" || row.kind === "TOOL_RESULT" || row.kind === "ACK";
}

function rowMatchesFilter(row: TimelineRow, filter: EngineSnapshot["timelineFilter"]): boolean {
  if (filter === "all") return true;
  if (filter === "tokens") return row.kind === "TOKEN";
  if (filter === "tools") return isToolRow(row);
  if (filter === "context") return row.kind === "CONTEXT_SNAPSHOT" || row.kind === "CONTEXT_PATCH";
  if (filter === "control") return row.kind === "PING" || row.kind === "PONG" || row.kind === "STATUS";
  return row.kind === "ERROR" || row.kind === "PARSE_ERROR";
}

export class ProtocolEngine {
  private snapshot: EngineSnapshot;
  private listeners = new Set<Listener>();
  private seenSeqs = new Set<number>();
  private orderedBuffer = new Map<number, ServerMessage>();
  private pendingFallbackAcks = new Map<string, TimerHandle>();
  private fallbackAckedToolCalls = new Set<string>();
  private processedToolCalls = new Map<string, ToolCallEvent>();
  private socket?: WebSocket;
  private reconnectTimer?: TimerHandle;
  private heartbeatTimer?: TimerHandle;
  private resumeReplayTimer?: TimerHandle;
  private notifyRaf?: number;
  private sender?: Sender;
  private diffWorker?: Worker;
  private ackFallbackMs: number;
  private heartbeatTimeoutMs: number;
  private storageKey?: string;
  private duplicateTimelineRowCounter = 0;
  private suppressReplayPongs = false;
  private pongedPingSeqs = new Set<number>();

  constructor(options: ProtocolEngineOptions = {}) {
    const url = options.url ?? DEFAULT_URL;
    const isTestRuntime = typeof process !== "undefined" && process.env.NODE_ENV === "test";
    this.storageKey = options.storageKey ?? (typeof window === "undefined" || isTestRuntime ? undefined : "signal-yard-engine-snapshot");
    this.snapshot = this.hydrateSnapshot(url);
    this.sender = options.sender;
    this.ackFallbackMs = options.ackFallbackMs ?? 1_500;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.rebuildRuntimeIndexes();
    this.createDiffWorker();

    if (options.connectOnCreate) {
      this.connect();
    }
  }

  getSnapshot = (): EngineSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  connect() {
    if (typeof WebSocket === "undefined") {
      this.setConnection("error", { lastError: "WebSocket is unavailable in this runtime" });
      return;
    }

    if (this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    this.clearReconnectTimer();
    this.setConnection("connecting", { attempt: this.snapshot.connection.attempt });
    const socket = new WebSocket(this.snapshot.connection.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }

      this.setConnection("resuming", { attempt: 0 });
      this.beginResumeReplayGuard(this.snapshot.lastRenderedSeq);
      this.send({ type: "RESUME", last_seq: this.snapshot.lastRenderedSeq });
      this.flushRenderedToolAcks(this.snapshot.lastRenderedSeq);
      this.setConnection("connected", { attempt: 0 });
      this.markPacketReceived();
    };

    socket.onmessage = (event: globalThis.MessageEvent) => {
      if (this.socket !== socket) {
        return;
      }

      this.ingestSocketData(event.data);
    };

    socket.onerror = () => {
      if (this.socket !== socket) {
        return;
      }

      this.setConnection("error", { lastError: "WebSocket error" });
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = undefined;
      this.clearHeartbeatTimer();
      this.scheduleReconnect();
    };
  }

  disconnect() {
    const socket = this.socket;
    this.socket = undefined;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearResumeReplayTimer();
    this.suppressReplayPongs = false;
    socket?.close();
    this.setConnection("closed", { reconnectInMs: undefined });
  }

  ingestSocketData(data: unknown) {
    this.recordBytesReceived(data);
    try {
      // Parser escape hatch: WebSocket MessageEvent.data is browser-owned and can be Blob,
      // ArrayBuffer, or string. The protocol contract starts after this JSON boundary.
      const parsed: unknown = typeof data === "string" ? JSON.parse(data) : data;
      this.ingest(parsed);
    } catch (error) {
      this.recordParseError(error);
    }
  }

  ingest(input: unknown) {
    let event: ServerMessage;

    try {
      event = parseServerMessage(input);
    } catch (error) {
      this.recordParseError(error);
      return;
    }

    this.markPacketReceived();
    this.bumpResumeReplayGuard();

    if (this.seenSeqs.has(event.seq)) {
      this.snapshot = {
        ...this.snapshot,
        stats: {
          ...this.snapshot.stats,
          duplicateSeqs: this.snapshot.stats.duplicateSeqs + 1
        }
      };
      this.addChaos({
        label: "Duplicate seq",
        detail: `Dropped ${event.type} at seq ${event.seq}`,
        severity: "warning",
        seq: event.seq
      });
      this.addTimelineRow({
        id: `duplicate-${event.seq}-${event.type}-${++this.duplicateTimelineRowCounter}`,
        kind: "DUPLICATE",
        seq: event.seq,
        endSeq: event.seq,
        label: "Duplicate dropped",
        detail: event.type,
        severity: "warning"
      });
      this.notify();
      return;
    }

    this.seenSeqs.add(event.seq);

    if (event.type === "PING" && !this.suppressReplayPongs) {
      const rttStartedAt = performanceNow();
      this.send({
        type: "PONG",
        echo: event.challenge ?? ""
      });
      this.pongedPingSeqs.add(event.seq);
      this.snapshot = {
        ...this.snapshot,
        stats: {
          ...this.snapshot.stats,
          lastRttMs: Math.max(0, Math.round(performanceNow() - rttStartedAt))
        }
      };
    }

    if (event.type === "TOOL_CALL") {
      this.scheduleFallbackAck(event);
    }

    this.orderedBuffer.set(event.seq, event);

    if (event.seq > this.snapshot.nextExpectedSeq) {
      this.snapshot = {
        ...this.snapshot,
        stats: {
          ...this.snapshot.stats,
          gapBuffered: this.snapshot.stats.gapBuffered + 1
        }
      };
      this.addChaos({
        label: "Gap buffered",
        detail: `Waiting for seq ${this.snapshot.nextExpectedSeq}, buffered ${event.seq}`,
        severity: "info",
        seq: event.seq
      });
      this.notify();
      return;
    }

    this.processOrdered();
  }

  commitRenderedSeq(seq: number) {
    if (seq <= this.snapshot.lastRenderedSeq) {
      this.flushRenderedToolAcks(this.snapshot.lastRenderedSeq);
      return;
    }

    const boundedSeq = Math.min(seq, this.snapshot.pendingRenderSeq);
    this.flushRenderedToolAcks(boundedSeq);
  }

  private flushRenderedToolAcks(boundedSeq: number) {
    const toolCards = { ...this.snapshot.toolCards };

    for (const toolCall of this.processedToolCalls.values()) {
      const card = toolCards[toolCall.call_id];
      if (!card || toolCall.seq > boundedSeq || card.ackStatus !== "pending-render") {
        continue;
      }

      this.sendToolAck(toolCall, "post-render");
      toolCards[toolCall.call_id] = {
        ...card,
        status: card.status === "pending" ? "acked" : card.status,
        ackStatus: "sent"
      };
    }

    this.snapshot = {
      ...this.snapshot,
      lastRenderedSeq: Math.max(this.snapshot.lastRenderedSeq, boundedSeq),
      toolCards
    };
    this.notify();
  }

  sendUserMessage(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || !this.snapshot.canSend) {
      return false;
    }

    this.send({
      type: "USER_MESSAGE",
      content: trimmed
    });
    return true;
  }

  setTimelineFilter(filter: EngineSnapshot["timelineFilter"]) {
    this.snapshot = { ...this.snapshot, timelineFilter: filter };
    this.notify();
  }

  setTimelineSearch(search: string) {
    this.snapshot = { ...this.snapshot, timelineSearch: search };
    this.notify();
  }

  selectTimelineRow(rowId: string | undefined) {
    const row = this.snapshot.timelineRows.find((candidate) => candidate.id === rowId);
    this.snapshot = {
      ...this.snapshot,
      selectedTimelineRowId: rowId,
      highlightedSeq: row?.seq,
      highlightedToolCallId: row && "toolCallId" in row ? row.toolCallId : undefined
    };
    this.notify();
  }

  highlightTool(toolCallId: string | undefined) {
    const card = toolCallId ? this.snapshot.toolCards[toolCallId] : undefined;
    this.snapshot = {
      ...this.snapshot,
      highlightedToolCallId: toolCallId,
      highlightedSeq: card?.seq
    };
    this.notify();
  }

  selectContext(contextId: string | undefined) {
    this.snapshot = { ...this.snapshot, selectedContextId: contextId };
    this.notify();
  }

  selectContextSeq(contextId: string, seq: number) {
    const context = this.snapshot.contexts[contextId];
    const selected = context?.history.find((entry) => entry.seq === seq);
    if (!context || !selected) {
      return;
    }

    const previousIndex = context.history.findIndex((entry) => entry.seq === seq) - 1;
    const previous = previousIndex >= 0 ? context.history[previousIndex]?.snapshot ?? null : null;
    const updatedContext: ContextRecord = {
      ...context,
      current: selected.snapshot,
      selectedSeq: seq,
      diffPending: true
    };

    this.snapshot = {
      ...this.snapshot,
      contexts: {
        ...this.snapshot.contexts,
        [contextId]: updatedContext
      }
    };
    this.requestContextDiff(contextId, seq, previous, selected.snapshot);
    this.notify();
  }

  simulateConnection(status: ConnectionStatus) {
    this.setConnection(status, {
      reconnectInMs: status === "reconnecting" ? BACKOFF_MS[0] : undefined
    });
  }

  reset(url = this.snapshot.connection.url) {
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearResumeReplayTimer();
    this.suppressReplayPongs = false;
    this.pendingFallbackAcks.forEach((timer) => clearTimeout(timer));
    this.pendingFallbackAcks.clear();
    this.snapshot = createInitialSnapshot(url);
    this.rebuildRuntimeIndexes();
    this.persistSnapshot();
    this.notify();
  }

  visibleTimelineRows(): TimelineRow[] {
    const { timelineFilter, timelineSearch, timelineRows } = this.snapshot;
    const query = timelineSearch.trim().toLowerCase();

    return timelineRows.filter((row) => {
      if (!rowMatchesFilter(row, timelineFilter)) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack =
        row.kind === "TOKEN"
          ? `${row.kind} ${row.text} ${row.streamId}`
          : `${row.kind} ${row.label} ${row.detail} ${row.toolCallId ?? ""}`;
      return haystack.toLowerCase().includes(query);
    });
  }

  dispose() {
    this.disconnect();
    this.diffWorker?.terminate();
    this.pendingFallbackAcks.forEach((timer) => clearTimeout(timer));
    this.pendingFallbackAcks.clear();
    if (this.notifyRaf !== undefined && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.notifyRaf);
    }
  }

  private hydrateSnapshot(url: string): EngineSnapshot {
    if (!this.storageKey || typeof window === "undefined") {
      return createInitialSnapshot(url);
    }

    try {
      const raw = window.sessionStorage.getItem(this.storageKey);
      if (!raw) {
        return createInitialSnapshot(url);
      }

      const parsed = JSON.parse(raw) as { version?: number; snapshot?: EngineSnapshot };
      if (parsed.version !== STORAGE_VERSION || !parsed.snapshot) {
        return createInitialSnapshot(url);
      }

      return {
        ...createInitialSnapshot(url),
        ...parsed.snapshot,
        connection: {
          ...parsed.snapshot.connection,
          url,
          status: "idle",
          attempt: 0,
          reconnectInMs: undefined
        },
        canSend: false
      };
    } catch {
      return createInitialSnapshot(url);
    }
  }

  private rebuildRuntimeIndexes() {
    this.seenSeqs = new Set<number>();
    for (let seq = 1; seq < this.snapshot.nextExpectedSeq; seq += 1) {
      this.seenSeqs.add(seq);
    }
    this.duplicateTimelineRowCounter = this.snapshot.timelineRows.reduce((max, row) => {
      if (row.kind !== "DUPLICATE") {
        return max;
      }

      const counter = Number(row.id.match(/-(\d+)$/)?.[1] ?? 0);
      return Number.isFinite(counter) ? Math.max(max, counter) : max;
    }, 0);
    this.orderedBuffer.clear();
    this.fallbackAckedToolCalls.clear();
    this.processedToolCalls.clear();
    this.pongedPingSeqs.clear();

    for (const card of Object.values(this.snapshot.toolCards)) {
      const toolCall: ToolCallEvent = {
        type: "TOOL_CALL",
        seq: card.seq,
        stream_id: card.streamId,
        call_id: card.id,
        tool_name: card.name,
        args: card.input
      };
      this.processedToolCalls.set(card.id, toolCall);

      if (card.ackStatus === "fallback-sent") {
        this.fallbackAckedToolCalls.add(card.id);
      }
    }
  }

  private processOrdered() {
    let processedToken = false;
    let processedNonToken = false;

    while (this.orderedBuffer.has(this.snapshot.nextExpectedSeq)) {
      const event = this.orderedBuffer.get(this.snapshot.nextExpectedSeq);
      if (!event) {
        break;
      }

      this.orderedBuffer.delete(event.seq);
      this.applyEvent(event);
      this.snapshot = {
        ...this.snapshot,
        nextExpectedSeq: this.snapshot.nextExpectedSeq + 1,
        pendingRenderSeq: event.seq
      };

      if (event.type === "TOKEN") {
        processedToken = true;
      } else {
        processedNonToken = true;
      }
    }

    if (processedNonToken) {
      this.notify();
    } else if (processedToken) {
      this.notifyCoalesced();
    }
  }

  private applyEvent(event: ServerMessage) {
    switch (event.type) {
      case "RUN_STARTED":
        this.addTimelineRow({
          id: `run-started-${event.seq}`,
          kind: "RUN_STARTED",
          seq: event.seq,
          endSeq: event.seq,
          label: "Run started",
          detail: event.title ?? "Untitled run",
          severity: "info"
        });
        break;
      case "RUN_COMPLETED":
        this.addTimelineRow({
          id: `run-completed-${event.seq}`,
          kind: "RUN_COMPLETED",
          seq: event.seq,
          endSeq: event.seq,
          label: "Run completed",
          detail: event.outcome,
          severity: event.outcome === "success" ? "success" : "warning"
        });
        this.addChaos({
          label: "Run complete",
          detail: `Outcome ${event.outcome}`,
          severity: event.outcome === "success" ? "success" : "warning",
          seq: event.seq
        });
        break;
      case "STATUS":
        this.addTimelineRow({
          id: `status-${event.seq}`,
          kind: "STATUS",
          seq: event.seq,
          endSeq: event.seq,
          label: event.status,
          detail: event.detail ?? "status update",
          severity: event.status === "error" ? "error" : "info"
        });
        break;
      case "ERROR":
        this.addTimelineRow({
          id: `error-${event.seq}`,
          kind: "ERROR",
          seq: event.seq,
          endSeq: event.seq,
          label: event.code,
          detail: event.message,
          severity: "error"
        });
        this.addChaos({
          label: "Recoverable error",
          detail: event.message,
          severity: event.recoverable ? "warning" : "error",
          seq: event.seq
        });
        break;
      case "PING":
        this.addTimelineRow({
          id: `ping-${event.seq}`,
          kind: "PING",
          seq: event.seq,
          endSeq: event.seq,
          label: "PING",
          detail: `challenge: ${event.challenge ?? "<empty>"}`,
          severity: "info"
        });
        if (this.pongedPingSeqs.has(event.seq)) {
          this.addTimelineRow({
            id: `pong-${event.seq}`,
            kind: "PONG",
            seq: event.seq,
            endSeq: event.seq,
            label: "PONG",
            detail: `lastRenderedSeq ${this.snapshot.lastRenderedSeq}`,
            severity: "success"
          });
        }
        break;
      case "MESSAGE":
        this.addMessage(event);
        break;
      case "TOKEN":
        this.addToken(event);
        break;
      case "TOOL_CALL":
        this.addToolCall(event);
        break;
      case "TOOL_RESULT":
        this.addToolResult(event);
        break;
      case "CONTEXT_SNAPSHOT":
        this.addContextSnapshot(event.context_id, event.seq, event.data);
        this.addTimelineRow({
          id: `context-${event.context_id}-${event.seq}`,
          kind: "CONTEXT_SNAPSHOT",
          seq: event.seq,
          endSeq: event.seq,
          label: event.context_id,
          detail: "snapshot received",
          severity: "info"
        });
        break;
      case "CONTEXT_PATCH":
        this.addTimelineRow({
          id: `context-patch-${event.context_id}-${event.seq}`,
          kind: "CONTEXT_PATCH",
          seq: event.seq,
          endSeq: event.seq,
          label: event.context_id,
          detail: summarizeJson(event.patch),
          severity: "info"
        });
        break;
    }
  }

  private addMessage(event: Extract<ServerMessage, { type: "MESSAGE" }>) {
    const item: WorkItem = {
      kind: "message",
      id: `message-${event.seq}`,
      role: event.role,
      content: event.content,
      seq: event.seq
    };
    this.snapshot = {
      ...this.snapshot,
      workItems: [...this.snapshot.workItems, item]
    };
    this.addTimelineRow({
      id: `message-row-${event.seq}`,
      kind: "MESSAGE",
      seq: event.seq,
      endSeq: event.seq,
      label: event.role,
      detail: event.content,
      streamId: event.stream_id,
      severity: "info"
    });
  }

  private addToken(event: Extract<ServerMessage, { type: "TOKEN" }>) {
    const workItems = [...this.snapshot.workItems];
    const previous = workItems[workItems.length - 1];

    if (previous?.kind === "tokens" && previous.streamId === event.stream_id && !previous.frozen) {
      workItems[workItems.length - 1] = {
        ...previous,
        text: `${previous.text}${event.text}`,
        endSeq: event.seq
      };
    } else {
      workItems.push({
        kind: "tokens",
        id: `tokens-${event.stream_id}-${event.seq}`,
        streamId: event.stream_id,
        text: event.text,
        startSeq: event.seq,
        endSeq: event.seq,
        frozen: false
      });
    }

    this.snapshot = {
      ...this.snapshot,
      workItems
    };

    const timelineRows = [...this.snapshot.timelineRows];
    const lastRow = timelineRows[timelineRows.length - 1];
    if (lastRow?.kind === "TOKEN" && lastRow.streamId === event.stream_id && lastRow.endSeq + 1 === event.seq) {
      timelineRows[timelineRows.length - 1] = {
        ...lastRow,
        text: `${lastRow.text}${event.text}`,
        endSeq: event.seq
      };
      this.snapshot = { ...this.snapshot, timelineRows };
    } else {
      this.addTimelineRow({
        id: `token-${event.stream_id}-${event.seq}`,
        kind: "TOKEN",
        seq: event.seq,
        endSeq: event.seq,
        streamId: event.stream_id,
        text: event.text
      });
    }
  }

  private addToolCall(event: ToolCallEvent) {
    this.processedToolCalls.set(event.call_id, event);

    const workItems = this.snapshot.workItems.map((item) =>
      item.kind === "tokens" && item.streamId === event.stream_id ? { ...item, frozen: true } : item
    );

    const card: ToolCard = {
      id: event.call_id,
      seq: event.seq,
      streamId: event.stream_id,
      name: event.tool_name,
      input: event.args,
      status: this.fallbackAckedToolCalls.has(event.call_id) ? "acked" : "pending",
      ackStatus: this.fallbackAckedToolCalls.has(event.call_id)
        ? "fallback-sent"
        : "pending-render"
    };

    this.snapshot = {
      ...this.snapshot,
      workItems: [
        ...workItems,
        {
          kind: "tool",
          id: `tool-${event.call_id}`,
          streamId: event.stream_id,
          toolCallId: event.call_id,
          seq: event.seq
        }
      ],
      toolCards: {
        ...this.snapshot.toolCards,
        [event.call_id]: card
      }
    };

    this.addTimelineRow({
      id: `tool-call-${event.call_id}`,
      kind: "TOOL_CALL",
      seq: event.seq,
      endSeq: event.seq,
      label: event.tool_name,
      detail: summarizeJson(event.args),
      streamId: event.stream_id,
      toolCallId: event.call_id,
      relatedId: `tool-result-${event.call_id}`,
      severity: "warning"
    });
  }

  private addToolResult(event: Extract<ServerMessage, { type: "TOOL_RESULT" }>) {
    const existing = this.snapshot.toolCards[event.call_id];
    const updatedCard: ToolCard = existing
      ? {
          ...existing,
          output: event.result,
          status: "complete",
          resultSeq: event.seq
        }
      : {
          id: event.call_id,
          seq: event.seq,
          streamId: "unknown",
          name: "unknown_tool",
          input: {},
          output: event.result,
          status: "complete",
          ackStatus: "sent",
          resultSeq: event.seq
        };

    this.snapshot = {
      ...this.snapshot,
      toolCards: {
        ...this.snapshot.toolCards,
        [event.call_id]: updatedCard
      }
    };

    this.addTimelineRow({
      id: `tool-result-${event.call_id}`,
      kind: "TOOL_RESULT",
      seq: event.seq,
      endSeq: event.seq,
      label: event.call_id,
      detail: summarizeJson(event.result),
      toolCallId: event.call_id,
      relatedId: `tool-call-${event.call_id}`,
      severity: "success"
    });
  }

  private addContextSnapshot(contextId: string, seq: number, snapshot: JsonValue) {
    const previous = this.snapshot.contexts[contextId];
    const previousSnapshot = previous?.current ?? null;
    const history = [...(previous?.history ?? []), { seq, snapshot }];
    const context: ContextRecord = {
      contextId,
      current: snapshot,
      history,
      diff: previous?.diff ?? [],
      selectedSeq: seq,
      diffPending: true
    };

    this.snapshot = {
      ...this.snapshot,
      selectedContextId: this.snapshot.selectedContextId ?? contextId,
      contexts: {
        ...this.snapshot.contexts,
        [contextId]: context
      }
    };
    this.requestContextDiff(contextId, seq, previousSnapshot, snapshot);
  }

  private addTimelineRow(row: TimelineRow) {
    this.snapshot = {
      ...this.snapshot,
      timelineRows: [...this.snapshot.timelineRows, row]
    };
  }

  private addChaos(badge: Omit<ChaosBadge, "id">) {
    const chaos = [
      {
        ...badge,
        id: nowId("chaos")
      },
      ...this.snapshot.chaos
    ].slice(0, 8);

    this.snapshot = {
      ...this.snapshot,
      chaos
    };
  }

  private scheduleFallbackAck(event: ToolCallEvent) {
    this.clearFallbackAck(event.call_id);
    const timer = setTimeout(() => {
      const card = this.snapshot.toolCards[event.call_id];
      if (card?.ackStatus === "sent" || card?.ackStatus === "fallback-sent") {
        return;
      }

      this.sendToolAck(event, "fallback-timeout");
      this.fallbackAckedToolCalls.add(event.call_id);
      this.addChaos({
        label: "Fallback TOOL_ACK",
        detail: `${event.tool_name} seq ${event.seq} waited ${this.ackFallbackMs}ms for render ACK`,
        severity: "warning",
        seq: event.seq
      });

      if (card) {
        this.snapshot = {
          ...this.snapshot,
          toolCards: {
            ...this.snapshot.toolCards,
            [event.call_id]: {
              ...card,
              ackStatus: "fallback-sent",
              status: card.status === "pending" ? "acked" : card.status
            }
          }
        };
      }
      this.notify();
    }, this.ackFallbackMs);
    this.pendingFallbackAcks.set(event.call_id, timer);
  }

  private clearFallbackAck(toolCallId: string) {
    const timer = this.pendingFallbackAcks.get(toolCallId);
    if (timer) {
      clearTimeout(timer);
      this.pendingFallbackAcks.delete(toolCallId);
    }
  }

  private sendToolAck(toolCall: ToolCallEvent, reason: ToolAckReason) {
    this.clearFallbackAck(toolCall.call_id);
    const rendered = reason === "post-render";
    this.send({
      type: "TOOL_ACK",
      call_id: toolCall.call_id
    });
    this.addTimelineRow({
      id: `ack-${toolCall.call_id}-${reason}`,
      kind: "ACK",
      seq: toolCall.seq,
      endSeq: toolCall.seq,
      label: "TOOL_ACK",
      detail: reason,
      toolCallId: toolCall.call_id,
      severity: rendered ? "success" : "warning"
    });
  }

  private send(message: ClientMessage) {
    this.sender?.(message);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }

    this.snapshot = {
      ...this.snapshot,
      outbound: [...this.snapshot.outbound, message]
    };
  }

  private setConnection(
    status: ConnectionStatus,
    patch: Partial<EngineSnapshot["connection"]> = {}
  ) {
    this.snapshot = {
      ...this.snapshot,
      canSend: status === "connected",
      connection: {
        ...this.snapshot.connection,
        ...patch,
        status
      }
    };
    this.notify();
  }

  private markPacketReceived() {
    this.snapshot = {
      ...this.snapshot,
      stats: {
        ...this.snapshot.stats,
        lastPacketAt: Date.now()
      }
    };
    this.scheduleHeartbeatWatchdog();
  }

  private recordBytesReceived(data: unknown) {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data).byteLength
        : data instanceof ArrayBuffer
          ? data.byteLength
          : data instanceof Blob
            ? data.size
            : 0;

    this.snapshot = {
      ...this.snapshot,
      stats: {
        ...this.snapshot.stats,
        bytesReceived: this.snapshot.stats.bytesReceived + bytes
      }
    };
  }

  private scheduleHeartbeatWatchdog() {
    this.clearHeartbeatTimer();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.heartbeatTimer = setTimeout(() => {
      const lastPacketAt = this.snapshot.stats.lastPacketAt ?? 0;
      if (Date.now() - lastPacketAt < this.heartbeatTimeoutMs) {
        this.scheduleHeartbeatWatchdog();
        return;
      }

      this.addChaos({
        label: "Heartbeat timeout",
        detail: `No packets for ${Math.round(this.heartbeatTimeoutMs / 1000)}s; reconnecting`,
        severity: "warning"
      });
      this.socket?.close();
    }, this.heartbeatTimeoutMs);
  }

  private clearHeartbeatTimer() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private beginResumeReplayGuard(resumeSeq: number) {
    this.clearResumeReplayTimer();
    this.suppressReplayPongs = resumeSeq > 0;
    this.bumpResumeReplayGuard();
  }

  private bumpResumeReplayGuard() {
    if (!this.suppressReplayPongs) {
      return;
    }

    this.clearResumeReplayTimer();
    this.resumeReplayTimer = setTimeout(() => {
      this.resumeReplayTimer = undefined;
      this.suppressReplayPongs = false;
    }, 750);
  }

  private clearResumeReplayTimer() {
    if (this.resumeReplayTimer) {
      clearTimeout(this.resumeReplayTimer);
      this.resumeReplayTimer = undefined;
    }
  }

  private scheduleReconnect() {
    const nextAttempt = this.snapshot.connection.attempt + 1;
    const reconnectInMs = BACKOFF_MS[Math.min(nextAttempt - 1, BACKOFF_MS.length - 1)];
    this.setConnection("reconnecting", {
      attempt: nextAttempt,
      reconnectInMs
    });
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), reconnectInMs);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private createDiffWorker() {
    const isTestRuntime =
      typeof process !== "undefined" && process.env.NODE_ENV === "test";

    if (typeof Worker === "undefined" || isTestRuntime) {
      return;
    }

    try {
      this.diffWorker = new Worker(new URL("../workers/contextDiff.worker.ts", import.meta.url), {
        type: "module"
      });
      this.diffWorker.onmessage = (event: MessageEvent<ContextDiffResponse>) => {
        this.applyContextDiff(event.data);
      };
    } catch {
      this.diffWorker = undefined;
    }
  }

  private requestContextDiff(
    contextId: string,
    seq: number,
    previous: JsonValue | null,
    next: JsonValue
  ) {
    if (this.diffWorker) {
      this.diffWorker.postMessage({
        id: nowId("diff"),
        contextId,
        seq,
        previous,
        next
      });
      return;
    }

    this.applyContextDiff({
      id: nowId("diff"),
      contextId,
      seq,
      diff: diffJson(previous, next)
    });
  }

  private applyContextDiff(response: ContextDiffResponse) {
    const context = this.snapshot.contexts[response.contextId];
    if (!context || context.selectedSeq !== response.seq) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      contexts: {
        ...this.snapshot.contexts,
        [response.contextId]: {
          ...context,
          diff: response.diff,
          diffPending: false
        }
      }
    };
    this.notify();
  }

  private recordParseError(error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown parser error";
    this.snapshot = {
      ...this.snapshot,
      parseErrors: [...this.snapshot.parseErrors, message],
      timelineRows: [
        ...this.snapshot.timelineRows,
        {
          id: nowId("parse-error"),
          kind: "PARSE_ERROR",
          seq: this.snapshot.pendingRenderSeq,
          endSeq: this.snapshot.pendingRenderSeq,
          label: "Parser rejected payload",
          detail: message,
          severity: "error"
        } satisfies TimelineEventRow
      ]
    };
    this.addChaos({
      label: "Parser rejection",
      detail: message,
      severity: "error"
    });
    this.notify();
  }

  private notifyCoalesced() {
    if (typeof requestAnimationFrame === "undefined") {
      this.notify();
      return;
    }

    if (this.notifyRaf !== undefined) {
      return;
    }

    this.notifyRaf = requestAnimationFrame(() => {
      this.notifyRaf = undefined;
      this.notify();
    });
  }

  private notify() {
    this.persistSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private persistSnapshot() {
    if (!this.storageKey || typeof window === "undefined") {
      return;
    }

    try {
      window.sessionStorage.setItem(
        this.storageKey,
        JSON.stringify({
          version: STORAGE_VERSION,
          snapshot: this.snapshot
        })
      );
    } catch {
      // Storage can be unavailable or full; the live engine should keep running.
    }
  }
}

function performanceNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

let browserEngine: ProtocolEngine | undefined;

export function getBrowserProtocolEngine(): ProtocolEngine {
  if (!browserEngine) {
    browserEngine = new ProtocolEngine();
  }

  return browserEngine;
}
