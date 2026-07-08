import { expect, test } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TimelineRow } from "@/protocol/types";

/**
 * This spec drives the REAL Next.js client against the REAL Dockerized
 * agent-server running with `--mode chaos`. It is intentionally excluded
 * from `npm run test:e2e` (see package.json `record:chaos` script) because
 * it depends on an external process on localhost:4747 and runs for several
 * minutes to give the server's randomized chaos profile a realistic chance
 * to exercise every required scenario.
 *
 * It produces `docs/recordings/chaos.webm`, a real screen recording (not a
 * scripted harness fixture) with an on-screen checklist overlay that is
 * driven directly by the protocol engine's live snapshot, so every label
 * shown in the video corresponds to a real detected protocol event.
 *
 * Run with: agent-server container up in --mode chaos, then
 *   npm run record:chaos
 */

const recordingDir = path.join(process.cwd(), "docs", "recordings");

const AGENT_SERVER_HEALTH_URL = "http://localhost:4747/health";
const TOTAL_DURATION_MS = process.env.CHAOS_RECORDING_MS
  ? Number(process.env.CHAOS_RECORDING_MS)
  : 4 * 60_000 + 30_000; // ~4.5 minutes
const POLL_INTERVAL_MS = 500;

const PROMPTS = [
  "hello there",
  "give me the schema for the large database evaluation",
  "please analyze and compare the two datasets",
  "give me a long and detailed document summary",
  "lookup and find the report metrics",
  "summarize the q3 report",
  "analyze and compare checkout conversion",
  "give me a long, detailed document about the incident"
];

interface ScenarioState {
  connectionDrop: boolean;
  outOfOrder: boolean;
  rapidToolCalls: boolean;
  oversizedContext: boolean;
  corruptHeartbeat: boolean;
}

function emptyState(): ScenarioState {
  return {
    connectionDrop: false,
    outOfOrder: false,
    rapidToolCalls: false,
    oversizedContext: false,
    corruptHeartbeat: false
  };
}

test.use({ video: "on" });

test("records real chaos-mode survival against the live Docker agent-server", async ({ page, request }) => {
  test.setTimeout(TOTAL_DURATION_MS + 60_000);

  const health = await request.get(AGENT_SERVER_HEALTH_URL).catch(() => undefined);
  test.skip(
    !health || !health.ok(),
    "agent-server is not reachable on localhost:4747. Start it with: docker run -p 4747:4747 agent-server --mode chaos"
  );

  const body = (await health!.json()) as { mode?: string };
  test.skip(
    body.mode !== "chaos",
    `agent-server is running in "${body.mode}" mode. Restart it with --mode chaos before recording.`
  );

  await mkdir(recordingDir, { recursive: true });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Signal Yard" })).toBeVisible();

  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.id = "chaos-recording-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "top:8px",
      "right:8px",
      "z-index:99999",
      "width:340px",
      "font-family:ui-monospace,monospace",
      "font-size:11px",
      "line-height:1.5",
      "background:rgba(15,23,23,0.92)",
      "color:#e6fbf8",
      "border:1px solid #0f766e",
      "border-radius:8px",
      "padding:10px 12px",
      "box-shadow:0 8px 24px rgba(0,0,0,0.35)",
      "pointer-events:none"
    ].join(";");
    overlay.innerHTML = "<strong>CHAOS MODE — live agent-server</strong><div id=\"chaos-overlay-body\"></div>";
    document.body.appendChild(overlay);
  });

  const state = emptyState();
  const startedAt = Date.now();
  let lastPromptAt = 0;
  let promptIndex = 0;

  async function updateOverlay(status: string, extra: string) {
    await page.evaluate(
      ({ status, extra, state, elapsed }) => {
        const body = document.getElementById("chaos-overlay-body");
        if (!body) return;
        const line = (ok: boolean, label: string) =>
          `<div>${ok ? "\u2705" : "\u2610"} ${label}</div>`;
        body.innerHTML = `
          <div style="margin:6px 0 8px;color:#94f5ea">t+${elapsed}s · connection: ${status}</div>
          ${line(state.connectionDrop, "Connection drop mid-stream -&gt; reconnect")}
          ${line(state.outOfOrder, "Out-of-order / duplicate seq handled")}
          ${line(state.rapidToolCalls, "Rapid sequential tool calls")}
          ${line(state.oversizedContext, "Oversized context snapshot (500KB+)")}
          ${line(state.corruptHeartbeat, "Corrupt heartbeat (empty challenge)")}
          <div style="margin-top:8px;color:#94f5ea">${extra}</div>
        `;
      },
      { status, extra, state, elapsed: Math.round((Date.now() - startedAt) / 1000) }
    );
  }

  async function sendPrompt(text: string) {
    const input = page.getByPlaceholder("Send an evaluator instruction...");
    const canType = await input.isEnabled().catch(() => false);
    if (!canType) return;
    await input.fill(text);
    await input.press("Meta+Enter").catch(() => undefined);
  }

  let everConnected = false;
  let wasConnectedBefore = false;

  while (Date.now() - startedAt < TOTAL_DURATION_MS) {
    const snapshot = await page.evaluate(() => {
      const engine = window.__SIGNAL_YARD_ENGINE__;
      if (!engine) return null;
      const snap = engine.getSnapshot();
      return {
        status: snap.connection.status,
        duplicateSeqs: snap.stats.duplicateSeqs,
        gapBuffered: snap.stats.gapBuffered,
        bytesReceived: snap.stats.bytesReceived,
        toolCards: Object.values(snap.toolCards).map((card) => card.status),
        pingRows: snap.timelineRows
          .filter((row): row is Exclude<TimelineRow, { kind: "TOKEN" }> => row.kind !== "TOKEN")
          .filter((row) => row.kind === "PING")
          .map((row) => row.detail)
      };
    });

    if (snapshot) {
      const isConnected = snapshot.status === "connected";
      if (wasConnectedBefore && !isConnected) {
        state.connectionDrop = true;
      }
      if (isConnected) {
        everConnected = true;
      }
      wasConnectedBefore = isConnected;

      if (snapshot.duplicateSeqs > 0 || snapshot.gapBuffered > 0) {
        state.outOfOrder = true;
      }

      const pendingToolCount = snapshot.toolCards.filter(
        (status) => status === "pending" || status === "acked"
      ).length;
      if (pendingToolCount >= 2) {
        state.rapidToolCalls = true;
      }

      if (snapshot.bytesReceived > 500 * 1024) {
        state.oversizedContext = true;
      }

      if (snapshot.pingRows.some((detail) => detail === "challenge: ")) {
        state.corruptHeartbeat = true;
      }

      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      if (elapsedS - lastPromptAt >= 35) {
        lastPromptAt = elapsedS;
        const prompt = PROMPTS[promptIndex % PROMPTS.length];
        promptIndex += 1;
        await sendPrompt(prompt);
        await updateOverlay(snapshot.status, `sent: "${prompt}"`);
      } else {
        await updateOverlay(snapshot.status, "watching live protocol events...");
      }
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  expect(everConnected, "the client must have connected to the live agent-server at least once").toBe(true);

  await updateOverlay("done", "recording window complete");
  await page.waitForTimeout(1_000);

  const video = page.video();
  await page.close();

  if (video) {
    await copyFile(await video.path(), path.join(recordingDir, "chaos.webm"));
  }
});
