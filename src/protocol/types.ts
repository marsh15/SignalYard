import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(jsonSchema)
  ])
);

const baseEventSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string().optional(),
  run_id: z.string().optional()
});

export const tokenEventSchema = baseEventSchema.extend({
  type: z.literal("TOKEN"),
  stream_id: z.string().default("default"),
  text: z.string(),
  context_id: z.string().optional()
});

export const messageEventSchema = baseEventSchema.extend({
  type: z.literal("MESSAGE"),
  role: z.enum(["assistant", "user", "system"]),
  content: z.string(),
  stream_id: z.string().default("default")
});

export const toolCallEventSchema = baseEventSchema.extend({
  type: z.literal("TOOL_CALL"),
  call_id: z.string(),
  tool_name: z.string(),
  args: jsonSchema,
  stream_id: z.string().default("default")
});

export const toolResultEventSchema = baseEventSchema.extend({
  type: z.literal("TOOL_RESULT"),
  call_id: z.string(),
  result: jsonSchema,
  stream_id: z.string().default("default")
});

export const contextSnapshotEventSchema = baseEventSchema.extend({
  type: z.literal("CONTEXT_SNAPSHOT"),
  context_id: z.string(),
  data: jsonSchema
});

export const contextPatchEventSchema = baseEventSchema.extend({
  type: z.literal("CONTEXT_PATCH"),
  context_id: z.string(),
  patch: jsonSchema
});

export const pingEventSchema = baseEventSchema.extend({
  type: z.literal("PING"),
  challenge: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((value) => (value === null ? "" : String(value ?? "")))
});

export const statusEventSchema = baseEventSchema.extend({
  type: z.literal("STATUS"),
  status: z.enum(["starting", "running", "paused", "resumed", "complete", "error"]),
  detail: z.string().optional()
});

export const errorEventSchema = baseEventSchema.extend({
  type: z.literal("ERROR"),
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean().default(true)
});

export const runStartedEventSchema = baseEventSchema.extend({
  type: z.literal("RUN_STARTED"),
  title: z.string().optional()
});

export const runCompletedEventSchema = baseEventSchema.extend({
  type: z.literal("RUN_COMPLETED"),
  outcome: z.enum(["success", "failed", "cancelled"]).default("success")
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  tokenEventSchema,
  messageEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  contextSnapshotEventSchema,
  contextPatchEventSchema,
  pingEventSchema,
  statusEventSchema,
  errorEventSchema,
  runStartedEventSchema,
  runCompletedEventSchema
]);

export type TokenEvent = z.infer<typeof tokenEventSchema>;
export type MessageEvent = z.infer<typeof messageEventSchema>;
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof toolResultEventSchema>;
export type ContextSnapshotEvent = z.infer<typeof contextSnapshotEventSchema>;
export type ContextPatchEvent = z.infer<typeof contextPatchEventSchema>;
export type PingEvent = z.infer<typeof pingEventSchema>;
export type StatusEvent = z.infer<typeof statusEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type RunStartedEvent = z.infer<typeof runStartedEventSchema>;
export type RunCompletedEvent = z.infer<typeof runCompletedEventSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ClientMessage =
  | {
      type: "RESUME";
      last_seq: number;
    }
  | {
      type: "PONG";
      echo: string;
    }
  | {
      type: "TOOL_ACK";
      call_id: string;
    }
  | {
      type: "USER_MESSAGE";
      content: string;
    };

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "resuming"
  | "closed"
  | "error";

export type DiffStatus = "added" | "removed" | "changed" | "same";

export interface DiffEntry {
  path: string;
  status: Exclude<DiffStatus, "same">;
  before?: JsonValue;
  after?: JsonValue;
}

export interface ContextHistoryEntry {
  seq: number;
  snapshot: JsonValue;
}

export interface ContextRecord {
  contextId: string;
  current: JsonValue;
  history: ContextHistoryEntry[];
  diff: DiffEntry[];
  selectedSeq: number;
  diffPending: boolean;
}

export interface TokenWorkItem {
  kind: "tokens";
  id: string;
  streamId: string;
  text: string;
  startSeq: number;
  endSeq: number;
  frozen: boolean;
}

export interface MessageWorkItem {
  kind: "message";
  id: string;
  role: "assistant" | "user" | "system";
  content: string;
  seq: number;
}

export interface ToolWorkItem {
  kind: "tool";
  id: string;
  streamId: string;
  toolCallId: string;
  seq: number;
}

export type WorkItem = TokenWorkItem | MessageWorkItem | ToolWorkItem;

export interface ToolCard {
  id: string;
  seq: number;
  streamId: string;
  name: string;
  input: JsonValue;
  output?: JsonValue;
  status: "pending" | "acked" | "complete" | "error";
  ackStatus: "pending-render" | "sent" | "fallback-sent";
  resultSeq?: number;
}

export interface TimelineTokenRow {
  id: string;
  kind: "TOKEN";
  seq: number;
  endSeq: number;
  streamId: string;
  text: string;
  relatedId?: string;
}

export interface TimelineEventRow {
  id: string;
  kind:
    | Exclude<ServerMessage["type"], "TOKEN">
    | "PONG"
    | "DUPLICATE"
    | "PARSE_ERROR"
    | "ACK";
  seq: number;
  endSeq: number;
  label: string;
  detail: string;
  streamId?: string;
  toolCallId?: string;
  relatedId?: string;
  severity?: "info" | "success" | "warning" | "error";
}

export type TimelineRow = TimelineTokenRow | TimelineEventRow;

export interface ChaosBadge {
  id: string;
  label: string;
  detail: string;
  severity: "info" | "success" | "warning" | "error";
  seq?: number;
}

export interface EngineSnapshot {
  connection: {
    status: ConnectionStatus;
    url: string;
    attempt: number;
    lastError?: string;
    reconnectInMs?: number;
  };
  canSend: boolean;
  lastRenderedSeq: number;
  pendingRenderSeq: number;
  nextExpectedSeq: number;
  workItems: WorkItem[];
  toolCards: Record<string, ToolCard>;
  timelineRows: TimelineRow[];
  contexts: Record<string, ContextRecord>;
  selectedContextId?: string;
  selectedTimelineRowId?: string;
  highlightedSeq?: number;
  highlightedToolCallId?: string;
  timelineFilter: "all" | "tokens" | "tools" | "context" | "control" | "errors";
  timelineSearch: string;
  chaos: ChaosBadge[];
  outbound: ClientMessage[];
  parseErrors: string[];
  stats: {
    bytesReceived: number;
    duplicateSeqs: number;
    gapBuffered: number;
    lastPacketAt?: number;
    lastRttMs?: number;
  };
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input);
}

export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
