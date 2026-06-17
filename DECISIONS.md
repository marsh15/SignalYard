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

## 50-Stream Dashboard Changes

The engine already separates `stream_id` on token rows and work items. For 50 concurrent streams, the UI should add a stream rail, per-stream virtualization, and stream-level filters while keeping the single ordered journal as the source of truth.

## 100x-Long-Response Changes

The current visual layer coalesces token notifications to animation frames and aggregates token timeline rows. For 100x longer responses, token block text should move to chunked rope storage plus windowed transcript rendering so copy/read interactions stay responsive.

## Context Diffing

Context snapshots are diffed in a Web Worker when available. Tests and non-worker runtimes use the same pure `diffJson` fallback, keeping diff semantics identical across environments.
