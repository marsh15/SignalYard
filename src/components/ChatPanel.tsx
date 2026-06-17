"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Copy, CornerDownRight, PauseCircle, Send, Wrench } from "lucide-react";
import type { ProtocolEngine } from "@/protocol/engine";
import type { EngineSnapshot, ToolCard, WorkItem } from "@/protocol/types";
import { cn, formatJson, IconButton, PanelHeader, SeqLabel } from "./ui";

interface ChatPanelProps {
  engine: ProtocolEngine;
  snapshot: EngineSnapshot;
}

export function ChatPanel({ engine, snapshot }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceFromBottom < 160) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [snapshot.workItems.length, snapshot.pendingRenderSeq]);

  const reconnecting =
    snapshot.connection.status === "reconnecting" || snapshot.connection.status === "resuming";

  function submit() {
    if (engine.sendUserMessage(draft)) {
      setDraft("");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <PanelHeader
        title="Workstream"
        meta="Incremental stream rendering freezes at tool-call boundaries"
        actions={
          reconnecting ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded border border-yard-amber/20 bg-yard-amberSoft px-2 text-xs font-semibold text-yard-amber">
              <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
              resuming
            </span>
          ) : null
        }
      />

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto bg-yard-wash/70 p-3 scrollbar-thin">
        <div className="mx-auto flex max-w-5xl flex-col gap-2">
          {snapshot.workItems.length === 0 ? (
            <EmptyWorkstream />
          ) : (
            snapshot.workItems.map((item) => (
              <WorkstreamItem
                key={item.id}
                item={item}
                toolCard={item.kind === "tool" ? snapshot.toolCards[item.toolCallId] : undefined}
                highlightedToolCallId={snapshot.highlightedToolCallId}
                onHighlight={(toolCallId) => engine.highlightTool(toolCallId)}
              />
            ))
          )}
        </div>
      </div>

      <div className="border-t border-yard-line bg-white p-3">
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="composer">
            Message
          </label>
          <textarea
            id="composer"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                submit();
              }
            }}
            placeholder={
              snapshot.canSend
                ? "Send an evaluator instruction..."
                : "Composer remains editable while connection resumes..."
            }
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded border border-yard-line bg-yard-wash px-3 py-2 text-sm leading-5 text-yard-ink outline-none transition placeholder:text-yard-muted focus:border-yard-teal focus:bg-white focus:ring-2 focus:ring-yard-teal/15"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!snapshot.canSend || draft.trim().length === 0}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded border border-yard-teal bg-yard-teal px-3 text-sm font-semibold text-white transition hover:bg-[#066d67] focus:outline-none focus:ring-2 focus:ring-yard-teal/25 disabled:cursor-not-allowed disabled:border-yard-line disabled:bg-yard-wash disabled:text-yard-muted"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyWorkstream() {
  return (
    <div className="grid min-h-[420px] place-items-center rounded border border-dashed border-yard-line bg-white">
      <div className="max-w-sm text-center">
        <div className="mx-auto grid h-10 w-10 place-items-center rounded border border-yard-line bg-yard-wash text-yard-muted">
          <CornerDownRight className="h-5 w-5" aria-hidden="true" />
        </div>
        <p className="mt-3 text-sm font-semibold">Waiting for protocol events</p>
        <p className="mt-1 text-xs leading-5 text-yard-muted">
          Default target is ws://localhost:4747/ws. Add ?scenario=tool-stream for the deterministic harness.
        </p>
      </div>
    </div>
  );
}

function WorkstreamItem({
  item,
  toolCard,
  highlightedToolCallId,
  onHighlight
}: {
  item: WorkItem;
  toolCard?: ToolCard;
  highlightedToolCallId?: string;
  onHighlight: (toolCallId: string | undefined) => void;
}) {
  if (item.kind === "message") {
    return (
      <article className="rounded border border-yard-line bg-white p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-normal text-yard-muted">{item.role}</span>
          <SeqLabel start={item.seq} />
        </div>
        <p className="whitespace-pre-wrap text-sm leading-6">{item.content}</p>
      </article>
    );
  }

  if (item.kind === "tokens") {
    return (
      <article
        className={cn(
          "rounded border bg-white p-3 transition",
          item.frozen ? "border-yard-amber/30" : "border-yard-line"
        )}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-yard-muted">assistant stream</span>
          <div className="flex items-center gap-2">
            {item.frozen ? (
              <span className="rounded bg-yard-amberSoft px-1.5 py-0.5 text-[11px] font-semibold text-yard-amber">
                frozen
              </span>
            ) : null}
            <SeqLabel start={item.startSeq} end={item.endSeq} />
          </div>
        </div>
        <p className="whitespace-pre-wrap text-[15px] leading-7">{item.text}</p>
      </article>
    );
  }

  if (!toolCard) {
    return null;
  }

  return (
    <ToolCardView
      card={toolCard}
      highlighted={highlightedToolCallId === toolCard.id}
      onHighlight={onHighlight}
    />
  );
}

function ToolCardView({
  card,
  highlighted,
  onHighlight
}: {
  card: ToolCard;
  highlighted: boolean;
  onHighlight: (toolCallId: string | undefined) => void;
}) {
  const statusTone =
    card.status === "complete"
      ? "bg-yard-tealSoft text-yard-teal"
      : card.status === "error"
        ? "bg-yard-roseSoft text-yard-rose"
        : "bg-yard-amberSoft text-yard-amber";

  return (
    <article
      onMouseEnter={() => onHighlight(card.id)}
      onMouseLeave={() => onHighlight(undefined)}
      className={cn(
        "rounded border bg-white p-3 transition",
        highlighted ? "border-yard-teal shadow-panel" : "border-yard-line"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded border border-yard-line bg-yard-wash text-yard-muted">
              <Wrench className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold leading-5">{card.name}</h3>
              <p className="font-mono text-[11px] leading-4 text-yard-muted">{card.id}</p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn("rounded px-2 py-1 text-xs font-semibold", statusTone)}>
            {card.status}
          </span>
          <SeqLabel start={card.seq} end={card.resultSeq} />
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <JsonBlock label="input" value={card.input} />
        <JsonBlock label={card.output ? "result" : "result pending"} value={card.output ?? { pending: true }} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-yard-line pt-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-yard-muted">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          ACK {card.ackStatus}
        </span>
        <IconButton
          label="Copy tool card JSON"
          onClick={() => navigator.clipboard.writeText(formatJson(card))}
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      </div>
    </article>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded border border-yard-line bg-yard-wash p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-normal text-yard-muted">{label}</div>
      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-yard-ink scrollbar-thin">
        {formatJson(value)}
      </pre>
    </div>
  );
}
