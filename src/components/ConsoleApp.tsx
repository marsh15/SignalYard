"use client";

import { useEffect, useState } from "react";
import { Activity, Gauge, Network, RadioTower, RotateCcw, TerminalSquare } from "lucide-react";
import type { ProtocolEngine } from "@/protocol/engine";
import type { HarnessScenario } from "@/protocol/harness";
import { useProtocolEngine, useProtocolSnapshot } from "@/protocol/useProtocolStore";
import { ChatPanel } from "./ChatPanel";
import { ContextInspector } from "./ContextInspector";
import { TraceTimeline } from "./TraceTimeline";
import { cn } from "./ui";

declare global {
  interface Window {
    __SIGNAL_YARD_ENGINE__?: ProtocolEngine;
  }
}

interface ConsoleAppProps {
  scenario?: HarnessScenario;
}

const scenarios: HarnessScenario[] = ["tool-stream", "reconnect", "rapid-tools", "large-context", "chaos"];

export function ConsoleApp({ scenario }: ConsoleAppProps) {
  const [selectedScenario, setSelectedScenario] = useState<HarnessScenario | undefined>(scenario);
  const engine = useProtocolEngine(selectedScenario);
  const snapshot = useProtocolSnapshot(engine);

  useEffect(() => {
    window.__SIGNAL_YARD_ENGINE__ = engine;
  }, [engine]);

  useEffect(() => {
    if (snapshot.pendingRenderSeq <= snapshot.lastRenderedSeq) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      engine.commitRenderedSeq(snapshot.pendingRenderSeq);
    });

    return () => cancelAnimationFrame(frame);
  }, [engine, snapshot.lastRenderedSeq, snapshot.pendingRenderSeq]);

  return (
    <main className="min-h-screen p-3 text-yard-ink sm:p-4">
      <div className="mx-auto flex h-[calc(100vh-1.5rem)] min-h-[760px] max-w-[1600px] flex-col overflow-hidden rounded-md border border-yard-line bg-yard-wash shadow-panel sm:h-[calc(100vh-2rem)]">
        <TopBar scenario={selectedScenario} snapshot={snapshot} onScenarioChange={setSelectedScenario} />
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-yard-line xl:grid-cols-[minmax(0,1.46fr)_minmax(420px,0.94fr)]">
          <section className="min-h-0 bg-yard-panel">
            <ChatPanel engine={engine} snapshot={snapshot} />
          </section>
          <aside className="grid min-h-0 grid-rows-[minmax(260px,0.54fr)_minmax(260px,0.46fr)] gap-px bg-yard-line">
            <TraceTimeline engine={engine} snapshot={snapshot} />
            <ContextInspector engine={engine} snapshot={snapshot} />
          </aside>
        </div>
      </div>
    </main>
  );
}

function TopBar({
  scenario,
  snapshot,
  onScenarioChange
}: {
  scenario?: HarnessScenario;
  snapshot: ReturnType<ProtocolEngine["getSnapshot"]>;
  onScenarioChange: (scenario: HarnessScenario | undefined) => void;
}) {
  const statusTone =
    snapshot.connection.status === "connected"
      ? "bg-yard-tealSoft text-yard-teal"
      : snapshot.connection.status === "reconnecting" || snapshot.connection.status === "resuming"
        ? "bg-yard-amberSoft text-yard-amber"
        : snapshot.connection.status === "error"
          ? "bg-yard-roseSoft text-yard-rose"
          : "bg-white text-yard-muted";

  return (
    <header className="grid min-h-[64px] grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-yard-line bg-white px-3 py-2 sm:px-4 lg:grid-cols-[auto_minmax(0,1fr)_auto]">
      <div className="flex min-w-[190px] items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-md bg-yard-ink text-white">
          <RadioTower className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-[17px] font-semibold leading-5 tracking-normal">Signal Yard</h1>
          <p className="text-xs leading-4 text-yard-muted">Agent operations console</p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 overflow-x-auto scrollbar-thin">
        <StatusChip
          icon={<Activity className="h-3.5 w-3.5" aria-hidden="true" />}
          label={snapshot.connection.status}
          className={statusTone}
        />
        <StatusChip
          icon={<TerminalSquare className="h-3.5 w-3.5" aria-hidden="true" />}
          label={`rendered ${snapshot.lastRenderedSeq}`}
          title={`lastRenderedSeq ${snapshot.lastRenderedSeq}`}
        />
        <StatusChip
          icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
          label={`next ${snapshot.nextExpectedSeq}`}
        />
        <StatusChip
          icon={<Gauge className="h-3.5 w-3.5" aria-hidden="true" />}
          label={`pong ${snapshot.stats.lastRttMs ?? 0}ms`}
        />
        <StatusChip
          icon={<Network className="h-3.5 w-3.5" aria-hidden="true" />}
          label={`${formatKiB(snapshot.stats.bytesReceived)} · d${snapshot.stats.duplicateSeqs} · g${snapshot.stats.gapBuffered}`}
          title={`${formatKiB(snapshot.stats.bytesReceived)} · dup ${snapshot.stats.duplicateSeqs} · gaps ${snapshot.stats.gapBuffered}`}
        />
      </div>

      <div className="col-span-2 flex min-w-0 items-center justify-end gap-2 overflow-hidden lg:col-span-1 lg:min-w-[390px]">
        <select
          aria-label="Scenario"
          value={scenario ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onScenarioChange(value ? (value as HarnessScenario) : undefined);
          }}
          className="h-8 w-[172px] shrink-0 rounded border border-yard-line bg-yard-wash px-2 text-xs font-semibold text-yard-ink"
        >
          <option value="">live socket</option>
          {scenarios.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
        {snapshot.chaos.length === 0 ? (
          <span className="shrink-0 whitespace-nowrap rounded border border-yard-line bg-yard-wash px-2 py-1 text-xs font-medium text-yard-muted">
            chaos evidence: clean
          </span>
        ) : (
          <>
            {snapshot.chaos.slice(0, 2).map((badge) => (
              <span
                key={badge.id}
                className={cn(
                  "max-w-[10rem] shrink truncate rounded border px-2 py-1 text-xs font-medium",
                  badge.severity === "success" && "border-yard-teal/20 bg-yard-tealSoft text-yard-teal",
                  badge.severity === "warning" && "border-yard-amber/20 bg-yard-amberSoft text-yard-amber",
                  badge.severity === "error" && "border-yard-rose/20 bg-yard-roseSoft text-yard-rose",
                  badge.severity === "info" && "border-yard-line bg-yard-wash text-yard-muted"
                )}
                title={`${badge.label}: ${badge.detail}`}
              >
                {badge.label}
              </span>
            ))}
            {snapshot.chaos.length > 2 ? (
              <span
                className="shrink-0 whitespace-nowrap rounded border border-yard-line bg-yard-wash px-2 py-1 text-xs font-medium text-yard-muted"
                title={snapshot.chaos
                  .slice(2)
                  .map((badge) => `${badge.label}: ${badge.detail}`)
                  .join("\n")}
              >
                +{snapshot.chaos.length - 2}
              </span>
            ) : null}
          </>
        )}
      </div>
    </header>
  );
}

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
}

function StatusChip({
  icon,
  label,
  className,
  title
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-yard-line bg-yard-wash px-2.5 text-xs font-semibold text-yard-muted",
        className
      )}
    >
      {icon}
      <span className="font-mono">{label}</span>
    </span>
  );
}
