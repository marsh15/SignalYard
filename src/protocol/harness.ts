import type { ProtocolEngine } from "./engine";
import type { ServerMessage } from "./types";

export type HarnessScenario =
  | "tool-stream"
  | "reconnect"
  | "rapid-tools"
  | "large-context"
  | "chaos";

const baseEvents: ServerMessage[] = [
  { type: "RUN_STARTED", seq: 1, title: "Evaluate checkout recovery agent" },
  {
    type: "TOKEN",
    seq: 2,
    stream_id: "main",
    text: "I am checking the latest run state and will inspect the cart recovery path. "
  },
  {
    type: "TOKEN",
    seq: 3,
    stream_id: "main",
    text: "First I need the order timeline."
  },
  {
    type: "TOOL_CALL",
    seq: 4,
    stream_id: "main",
    call_id: "tool_001",
    tool_name: "orders.lookup",
    args: { orderId: "ord_7429", includeEvents: true }
  },
  {
    type: "TOOL_RESULT",
    seq: 5,
    call_id: "tool_001",
    stream_id: "main",
    result: {
      status: "recovered",
      events: ["abandoned_cart", "agent_email_sent", "checkout_completed"],
      latencyMs: 842
    }
  },
  {
    type: "TOKEN",
    seq: 6,
    stream_id: "main",
    text: " The cart was recovered after the first agent email. I am comparing the context snapshot now."
  },
  {
    type: "CONTEXT_SNAPSHOT",
    seq: 7,
    context_id: "checkout-agent",
    data: {
      customer: { tier: "pro", locale: "en-US" },
      cart: { value: 481.4, currency: "USD", items: 3 },
      policy: { maxDiscountPercent: 12, allowSms: false },
      evidence: { recovered: true, channel: "email" }
    }
  },
  {
    type: "CONTEXT_SNAPSHOT",
    seq: 8,
    context_id: "checkout-agent",
    data: {
      customer: { tier: "pro", locale: "en-US" },
      cart: { value: 481.4, currency: "USD", items: 3 },
      policy: { maxDiscountPercent: 15, allowSms: true },
      evidence: { recovered: true, channel: "email", checkoutLatencyMs: 842 }
    }
  },
  { type: "PING", seq: 9, challenge: "" },
  {
    type: "TOKEN",
    seq: 10,
    stream_id: "main",
    text: " The policy context changed: SMS became available and the discount cap moved to 15 percent."
  },
  { type: "RUN_COMPLETED", seq: 11, outcome: "success" }
];

function largeContext(seq: number): ServerMessage {
  const orders = Array.from({ length: 180 }, (_, index) => ({
    id: `ord_${7000 + index}`,
    score: Number((0.52 + index * 0.002).toFixed(3)),
    status: index % 5 === 0 ? "needs_review" : "ok",
    tags: ["checkout", index % 2 === 0 ? "email" : "sms"]
  }));

  return {
    type: "CONTEXT_SNAPSHOT",
    seq,
    context_id: "large-eval",
    data: {
      generatedAt: "2026-06-14T10:00:00.000Z",
      orders,
      limits: { maxRows: 5000, virtualized: true }
    }
  };
}

function eventsForScenario(scenario: HarnessScenario): ServerMessage[] {
  if (scenario === "large-context") {
    return [...baseEvents.slice(0, 8), largeContext(9), { type: "RUN_COMPLETED", seq: 10, outcome: "success" }];
  }

  if (scenario === "rapid-tools") {
    return [
      { type: "RUN_STARTED", seq: 1, title: "Rapid tool fan-out" },
      { type: "TOKEN", seq: 2, stream_id: "main", text: "Fan-out starting. " },
      {
        type: "TOOL_CALL",
        seq: 3,
        stream_id: "main",
        call_id: "tool_a",
        tool_name: "search.docs",
        args: { q: "resume protocol" }
      },
      {
        type: "TOOL_CALL",
        seq: 4,
        stream_id: "main",
        call_id: "tool_b",
        tool_name: "search.logs",
        args: { q: "dropped seq" }
      },
      {
        type: "TOOL_RESULT",
        seq: 5,
        call_id: "tool_a",
        stream_id: "main",
        result: { hits: 12, top: "resume-first reconnect" }
      },
      {
        type: "TOOL_RESULT",
        seq: 6,
        call_id: "tool_b",
        stream_id: "main",
        result: { hits: 4, top: "duplicate seq dropped" }
      },
      { type: "TOKEN", seq: 7, stream_id: "main", text: "Both tool results are linked and rendered." },
      { type: "RUN_COMPLETED", seq: 8, outcome: "success" }
    ];
  }

  if (scenario === "chaos") {
    return [
      baseEvents[0],
      baseEvents[1],
      baseEvents[3],
      baseEvents[2],
      baseEvents[3],
      baseEvents[4],
      { type: "PING", seq: 6, challenge: "" },
      {
        type: "TOKEN",
        seq: 7,
        stream_id: "main",
        text: " Chaos replay preserved ordered rendering and dropped the duplicate tool call."
      },
      {
        type: "CONTEXT_SNAPSHOT",
        seq: 8,
        context_id: "chaos",
        data: { duplicateDropped: true, fallbackAckRace: true, resumed: true }
      },
      { type: "RUN_COMPLETED", seq: 9, outcome: "success" }
    ];
  }

  return baseEvents;
}

export function playHarnessScenario(engine: ProtocolEngine, scenario: HarnessScenario) {
  const events = eventsForScenario(scenario);

  if (scenario === "reconnect" || scenario === "chaos") {
    setTimeout(() => engine.simulateConnection("reconnecting"), 250);
    setTimeout(() => engine.simulateConnection("connected"), 3_500);
  } else {
    engine.simulateConnection("connected");
  }

  events.forEach((event, index) => {
    const delay = scenario === "tool-stream" ? index * 160 : index * 90;
    setTimeout(() => engine.ingest(event), delay);
  });
}
