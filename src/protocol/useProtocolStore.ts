"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createInitialSnapshot, getBrowserProtocolEngine, type ProtocolEngine } from "./engine";
import { playHarnessScenario, type HarnessScenario } from "./harness";

const hydrationSnapshot = createInitialSnapshot();

export function useProtocolEngine(scenario?: HarnessScenario): ProtocolEngine {
  const engine = useMemo(() => getBrowserProtocolEngine(), []);
  const activeScenarioRef = useRef<HarnessScenario | undefined>(undefined);

  useEffect(() => {
    if (scenario) {
      if (activeScenarioRef.current !== scenario) {
        activeScenarioRef.current = scenario;
        engine.reset();
        playHarnessScenario(engine, scenario);
      }
      return;
    }

    activeScenarioRef.current = undefined;
    engine.connect();
    return () => {
      engine.disconnect();
    };
  }, [engine, scenario]);

  return engine;
}

export function useProtocolSnapshot(engine: ProtocolEngine) {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, () => hydrationSnapshot);
}
