"use client";

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Braces, Bug, Filter, Link2, MessageSquareText, Search, ShieldAlert, Wrench } from "lucide-react";
import type { ProtocolEngine } from "@/protocol/engine";
import type { EngineSnapshot, TimelineRow } from "@/protocol/types";
import { cn, PanelHeader, SeqLabel } from "./ui";

interface TraceTimelineProps {
  engine: ProtocolEngine;
  snapshot: EngineSnapshot;
}

export function TraceTimeline({ engine, snapshot }: TraceTimelineProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const visibleRows = useMemo(() => filterRows(snapshot), [snapshot]);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 12
  });

  return (
    <section className="flex min-h-0 flex-col bg-white">
      <PanelHeader
        title="Trace Timeline"
        meta={`${visibleRows.length} visible / ${snapshot.timelineRows.length} recorded`}
        actions={
          <div className="flex items-center gap-1">
            <FilterButton
              label="All events"
              active={snapshot.timelineFilter === "all"}
              onClick={() => engine.setTimelineFilter("all")}
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
            </FilterButton>
            <FilterButton
              label="Tokens"
              active={snapshot.timelineFilter === "tokens"}
              onClick={() => engine.setTimelineFilter("tokens")}
            >
              <MessageSquareText className="h-4 w-4" aria-hidden="true" />
            </FilterButton>
            <FilterButton
              label="Tools"
              active={snapshot.timelineFilter === "tools"}
              onClick={() => engine.setTimelineFilter("tools")}
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
            </FilterButton>
            <FilterButton
              label="Context"
              active={snapshot.timelineFilter === "context"}
              onClick={() => engine.setTimelineFilter("context")}
            >
              <Braces className="h-4 w-4" aria-hidden="true" />
            </FilterButton>
            <FilterButton
              label="Errors"
              active={snapshot.timelineFilter === "errors"}
              onClick={() => engine.setTimelineFilter("errors")}
            >
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            </FilterButton>
          </div>
        }
      />

      <div className="border-b border-yard-line bg-yard-wash p-2">
        <label className="flex h-9 items-center gap-2 rounded border border-yard-line bg-white px-2 text-yard-muted">
          <Search className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">Search trace</span>
          <input
            value={snapshot.timelineSearch}
            onChange={(event) => engine.setTimelineSearch(event.target.value)}
            placeholder="Search trace rows"
            className="min-w-0 flex-1 bg-transparent text-sm text-yard-ink outline-none placeholder:text-yard-muted"
          />
        </label>
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto bg-yard-wash/60 scrollbar-thin">
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = visibleRows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={row.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full px-2 py-1"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <TimelineRowView
                  row={row}
                  selected={snapshot.selectedTimelineRowId === row.id}
                  linked={
                    "toolCallId" in row &&
                    Boolean(row.toolCallId && snapshot.highlightedToolCallId === row.toolCallId)
                  }
                  onClick={() => engine.selectTimelineRow(row.id)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function filterRows(snapshot: EngineSnapshot): TimelineRow[] {
  const query = snapshot.timelineSearch.trim().toLowerCase();

  return snapshot.timelineRows.filter((row) => {
    const filter = snapshot.timelineFilter;
    const filterMatch =
      filter === "all" ||
      (filter === "tokens" && row.kind === "TOKEN") ||
      (filter === "tools" && (row.kind === "TOOL_CALL" || row.kind === "TOOL_RESULT" || row.kind === "ACK")) ||
      (filter === "context" && (row.kind === "CONTEXT_SNAPSHOT" || row.kind === "CONTEXT_PATCH")) ||
      (filter === "control" && (row.kind === "PING" || row.kind === "PONG" || row.kind === "STATUS")) ||
      (filter === "errors" && (row.kind === "ERROR" || row.kind === "PARSE_ERROR"));

    if (!filterMatch) return false;
    if (!query) return true;

    const text =
      row.kind === "TOKEN"
        ? `${row.kind} ${row.text} ${row.streamId}`
        : `${row.kind} ${row.label} ${row.detail} ${row.toolCallId ?? ""}`;
    return text.toLowerCase().includes(query);
  });
}

function TimelineRowView({
  row,
  selected,
  linked,
  onClick
}: {
  row: TimelineRow;
  selected: boolean;
  linked: boolean;
  onClick: () => void;
}) {
  const severity = row.kind === "TOKEN" ? "info" : row.severity ?? "info";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "grid w-full grid-cols-[70px_minmax(0,1fr)_auto] items-start gap-2 rounded border bg-white p-2 text-left transition focus:outline-none focus:ring-2 focus:ring-yard-teal/20",
        selected || linked ? "border-yard-teal shadow-panel" : "border-yard-line hover:border-yard-teal/30",
        severity === "error" && "bg-yard-roseSoft/50",
        severity === "warning" && "bg-yard-amberSoft/50",
        severity === "success" && "bg-yard-tealSoft/50"
      )}
    >
      <div className="pt-0.5">
        <SeqLabel start={row.seq} end={row.endSeq} />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[11px] font-semibold text-yard-ink">{row.kind}</span>
          {"relatedId" in row && row.relatedId ? (
            <Link2 className="h-3.5 w-3.5 shrink-0 text-yard-teal" aria-hidden="true" />
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs leading-4 text-yard-muted">
          {row.kind === "TOKEN" ? row.text : row.detail}
        </p>
      </div>
      {row.kind === "PARSE_ERROR" || row.kind === "DUPLICATE" ? (
        <Bug className="mt-0.5 h-4 w-4 text-yard-amber" aria-hidden="true" />
      ) : null}
    </button>
  );
}

function FilterButton({
  label,
  active,
  onClick,
  children
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-8 w-8 place-items-center rounded border border-yard-line bg-white text-yard-muted transition hover:border-yard-teal/30 hover:text-yard-teal focus:outline-none focus:ring-2 focus:ring-yard-teal/20",
        active && "border-yard-teal/30 bg-yard-tealSoft text-yard-teal"
      )}
    >
      {children}
    </button>
  );
}
