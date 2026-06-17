"use client";

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Database, GitCompareArrows, Search } from "lucide-react";
import type { ProtocolEngine } from "@/protocol/engine";
import { createDiffIndex, formatJsonPreview } from "@/protocol/contextDiff";
import type { DiffEntry, EngineSnapshot, JsonValue } from "@/protocol/types";
import { isJsonObject } from "@/protocol/types";
import { cn, PanelHeader, SeqLabel } from "./ui";

interface ContextInspectorProps {
  engine: ProtocolEngine;
  snapshot: EngineSnapshot;
}

interface JsonTreeRow {
  path: string;
  key: string;
  value: JsonValue;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  diff?: DiffEntry;
}

export function ContextInspector({ engine, snapshot }: ContextInspectorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["$"]));
  const [query, setQuery] = useState("");
  const parentRef = useRef<HTMLDivElement | null>(null);
  const contexts = Object.values(snapshot.contexts);
  const selectedContext =
    snapshot.selectedContextId
      ? snapshot.contexts[snapshot.selectedContextId] ?? contexts[0]
      : contexts[0];
  const diffIndex = useMemo(
    () => createDiffIndex(selectedContext?.diff ?? []),
    [selectedContext?.diff]
  );
  const rows = useMemo(
    () => (selectedContext ? flattenJsonTree(selectedContext.current, expanded, diffIndex, query) : []),
    [diffIndex, expanded, query, selectedContext]
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 20
  });

  return (
    <section className="flex min-h-0 flex-col bg-white">
      <PanelHeader
        title="Context Inspector"
        meta={
          selectedContext
            ? `${selectedContext.contextId} · ${selectedContext.diff.length} diff entries`
            : "No snapshots received"
        }
        actions={
          selectedContext?.diffPending ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded border border-yard-line bg-yard-wash px-2 text-xs font-semibold text-yard-muted">
              <GitCompareArrows className="h-3.5 w-3.5" aria-hidden="true" />
              diffing
            </span>
          ) : null
        }
      />

      {contexts.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-yard-line bg-yard-wash p-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-thin">
            {contexts.map((context) => (
              <button
                key={context.contextId}
                type="button"
                onClick={() => engine.selectContext(context.contextId)}
                className={cn(
                  "h-8 shrink-0 rounded border px-2 text-xs font-semibold transition",
                  selectedContext?.contextId === context.contextId
                    ? "border-yard-teal/30 bg-yard-tealSoft text-yard-teal"
                    : "border-yard-line bg-white text-yard-muted hover:border-yard-teal/30"
                )}
              >
                {context.contextId}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {selectedContext ? (
        <div className="border-b border-yard-line bg-white px-3 py-2">
          <div className="flex items-center gap-3">
            <SeqLabel start={selectedContext.selectedSeq} />
            <input
              aria-label="Context history scrubber"
              type="range"
              min={0}
              max={Math.max(selectedContext.history.length - 1, 0)}
              value={Math.max(
                selectedContext.history.findIndex((entry) => entry.seq === selectedContext.selectedSeq),
                0
              )}
              onChange={(event) => {
                const nextEntry = selectedContext.history[Number(event.target.value)];
                if (nextEntry) {
                  engine.selectContextSeq(selectedContext.contextId, nextEntry.seq);
                }
              }}
              className="h-2 min-w-0 flex-1 accent-yard-teal"
            />
            <span className="font-mono text-[11px] text-yard-muted">
              {selectedContext.history.length} snapshots
            </span>
          </div>
          <label className="mt-2 flex h-8 items-center gap-2 rounded border border-yard-line bg-yard-wash px-2 text-xs text-yard-muted">
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <input
              aria-label="Search context"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search paths, keys, values"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-yard-ink outline-none placeholder:text-yard-muted"
            />
            {query ? (
              <span className="shrink-0 font-mono text-[11px]">{rows.length} rows</span>
            ) : null}
          </label>
        </div>
      ) : null}

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto bg-yard-wash/60 scrollbar-thin">
        {selectedContext ? (
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              return (
                <div
                  key={row.path}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full px-2 py-0.5"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <JsonTreeRowView
                    row={row}
                    onToggle={() => {
                      const next = new Set(expanded);
                      if (next.has(row.path)) {
                        next.delete(row.path);
                      } else {
                        next.add(row.path);
                      }
                      setExpanded(next);
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid h-full min-h-[220px] place-items-center p-6 text-center">
            <div>
              <div className="mx-auto grid h-10 w-10 place-items-center rounded border border-yard-line bg-white text-yard-muted">
                <Database className="h-5 w-5" aria-hidden="true" />
              </div>
              <p className="mt-3 text-sm font-semibold">No context snapshots yet</p>
              <p className="mt-1 text-xs leading-5 text-yard-muted">
                CONTEXT_SNAPSHOT events will diff in a worker and render as a lazy JSON tree.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function JsonTreeRowView({ row, onToggle }: { row: JsonTreeRow; onToggle: () => void }) {
  const diffTone =
    row.diff?.status === "added"
      ? "border-yard-teal/20 bg-yard-tealSoft"
      : row.diff?.status === "removed"
        ? "border-yard-rose/20 bg-yard-roseSoft"
        : row.diff?.status === "changed"
          ? "border-yard-amber/20 bg-yard-amberSoft"
          : "border-yard-line bg-white";

  return (
    <div
      className={cn(
        "grid min-h-[28px] grid-cols-[minmax(120px,0.42fr)_minmax(0,1fr)_auto] items-center gap-2 rounded border px-2 text-xs",
        diffTone
      )}
      style={{ paddingLeft: `${8 + row.depth * 14}px` }}
    >
      <button
        type="button"
        onClick={row.expandable ? onToggle : undefined}
        className="flex min-w-0 items-center gap-1 text-left font-mono font-semibold text-yard-ink disabled:cursor-default"
        disabled={!row.expandable}
      >
        {row.expandable ? (
          row.expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-yard-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-yard-muted" aria-hidden="true" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="truncate">{row.key}</span>
      </button>
      <span className="truncate font-mono text-[11px] text-yard-muted">{formatJsonPreview(row.value)}</span>
      {row.diff ? (
        <span className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold text-yard-muted">
          {row.diff.status}
        </span>
      ) : null}
    </div>
  );
}

function flattenJsonTree(
  value: JsonValue,
  expanded: Set<string>,
  diffIndex: Record<string, DiffEntry>,
  query = ""
): JsonTreeRow[] {
  const rows: JsonTreeRow[] = [];
  const normalizedQuery = query.trim().toLowerCase();
  const searchMode = normalizedQuery.length > 0;

  function visit(node: JsonValue, key: string, path: string, depth: number) {
    const expandable = Array.isArray(node) || isJsonObject(node);
    const isExpanded = searchMode ? true : expanded.has(path);
    const row: JsonTreeRow = {
      path,
      key,
      value: node,
      depth,
      expandable,
      expanded: isExpanded,
      diff: diffIndex[path] ?? descendantDiff(path, diffIndex)
    };
    const rowIndex = rows.length;
    rows.push(row);

    if (!expandable || !isExpanded) {
      return rowMatchesContextSearch(row, normalizedQuery);
    }

    let descendantMatched = false;
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        descendantMatched = visit(child, `[${index}]`, `${path}[${index}]`, depth + 1) || descendantMatched;
      });
    } else {
      Object.entries(node).forEach(([childKey, child]) => {
        descendantMatched = visit(child, childKey, path === "$" ? `$.${childKey}` : `${path}.${childKey}`, depth + 1) || descendantMatched;
      });
    }

    const selfMatched = rowMatchesContextSearch(row, normalizedQuery);
    if (searchMode && !selfMatched && !descendantMatched) {
      rows.splice(rowIndex, 1);
    }
    return selfMatched || descendantMatched;
  }

  visit(value, "$", "$", 0);
  return rows;
}

function rowMatchesContextSearch(row: JsonTreeRow, query: string): boolean {
  if (!query) {
    return true;
  }

  return `${row.path} ${row.key} ${formatJsonPreview(row.value)}`.toLowerCase().includes(query);
}

function descendantDiff(path: string, diffIndex: Record<string, DiffEntry>): DiffEntry | undefined {
  const objectPrefix = path === "$" ? "$." : `${path}.`;
  const arrayPrefix = `${path}[`;
  const hasDescendant = Object.keys(diffIndex).some(
    (diffPath) => diffPath.startsWith(objectPrefix) || diffPath.startsWith(arrayPrefix)
  );

  return hasDescendant ? { path, status: "changed" } : undefined;
}
