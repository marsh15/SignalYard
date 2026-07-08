# Signal Yard Decisions

## Seq Ordering And Dedupe

The protocol engine maintains `seenSeqs`, an ordered `Map` buffer, `nextExpectedSeq`, and `pendingRenderSeq`. Duplicate seqs are dropped before they can mutate chat text, and future seqs stay buffered until the missing seq arrives.

## DOM-Consumed Vs Socket-Received Seq

`pendingRenderSeq` means the engine processed an event into derived state. `lastRenderedSeq` advances only after React commits the frame through `commitRenderedSeq`, so resume messages reflect DOM-consumed work rather than socket-received work.

## Layout-Shift Prevention

The app uses fixed panel tracks, virtualized trace/context regions, stable toolbar heights, bounded JSON/tool blocks, and frozen token blocks at tool boundaries. Streaming text can grow vertically inside the workstream without resizing the inspector.

## Reconnect Recovery

Close/error transitions move to `reconnecting` immediately, so the indicator appears well under 500ms. Backoff is `500ms -> 1s -> 2s -> 4s -> 10s`. On reopen, the first client message is the protocol-required `RESUME` with `last_seq` set from internal `lastRenderedSeq`; the composer remains editable but Send is disabled until connected.

## TOOL_ACK Race

Normal `TOOL_ACK` is sent after the tool card has committed. Every `TOOL_CALL` also gets a 1.5s fallback timer, so a delayed render commit or an out-of-order gap cannot leave the server waiting indefinitely. The fallback protocol ACK contains only `{ type: "TOOL_ACK", call_id }` and records the fallback reason internally in the timeline. When that tool later renders, the card is marked `fallback-sent` so a duplicate post-render ACK is not emitted.

**This is the protocol flaw the assignment hints at, and it is not just theoretical** — it reproduced during real chaos-mode testing (`docs/recordings/chaos.webm`, `curl http://localhost:4747/log`). The server's `TOOL_ACK` timeout is measured from when *it* dispatched `TOOL_CALL`; it has no visibility into chaos-injected network delay on the way to the client. In the recorded session, `tc_fa6ebbc2`'s `TOOL_ACK` fired from our fallback timer, but by the time it reached the server (network-delayed under the chaos profile), the server had already logged `TOOL_ACK_TIMEOUT` (a `violation`) 4.36s earlier and moved on — so our (correct, sent-on-time-by-wall-clock) ACK landed as `verdict: "unexpected"`. No amount of client-side tuning fixes this: the timeout is a race between two independent clocks with a lossy channel in between, and the server has no way to distinguish "client is slow" from "network is slow." A more robust protocol would let the client's ACK include the original `TOOL_CALL` `seq` so the server can still accept a late ACK if the result hasn't shipped yet, or would make the timeout adaptive based on measured RTT (which we do track, in `stats.lastRttMs`, but the server does not use).

## 50-Stream Dashboard Changes

The engine already separates `stream_id` on token rows and work items. For 50 concurrent streams, the UI should add a stream rail, per-stream virtualization, and stream-level filters while keeping the single ordered journal as the source of truth.

## 100x-Long-Response Changes

The current visual layer coalesces token notifications to animation frames and aggregates token timeline rows. For 100x longer responses, token block text should move to chunked rope storage plus windowed transcript rendering so copy/read interactions stay responsive.

## Context Diffing

Context snapshots are diffed in a Web Worker when available. Tests and non-worker runtimes use the same pure `diffJson` fallback, keeping diff semantics identical across environments.

## A False Alarm Worth Documenting: `agent-server` Is Single-Connection

While validating against the real Docker container, we saw a client repeatedly get `PONG_TIMEOUT` x3 then `CONNECTION_TERMINATED`, reconnect, and immediately repeat the same failure. It looked like a real heartbeat bug. It was not: two browser tabs were open against the same `agent-server` at once, and the server only tolerates one live connection (a second connection silently replaces the first, per `/health`'s `connected` flag and observed `close` code `1000 "replaced"`). Each tab kept stealing the slot back from the other, so PINGs were sent to whichever socket briefly "owned" the session, and neither tab reliably received or answered them. Closing the second tab and retesting in isolation showed the real behavior: every PING answered within single-digit milliseconds, confirmed by the server's own `/log` (`verdict: "ok"` for every `PONG`). The lesson generalizes: **before trusting an observed protocol violation, rule out multi-client contention on a server that assumes one client** — the symptom (repeated heartbeat timeouts immediately after reconnect) looks identical to a genuine client-side heartbeat bug, but the fix (close the other tab) and the diagnosis (check `/health.connected` and look for interleaved `RESUME`s with different `last_seq` values from what you expect) are completely different from a code fix.
