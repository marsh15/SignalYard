import { ConsoleApp } from "@/components/ConsoleApp";
import type { HarnessScenario } from "@/protocol/harness";

const scenarios: HarnessScenario[] = [
  "tool-stream",
  "reconnect",
  "rapid-tools",
  "large-context",
  "chaos"
];

export default async function Page({
  searchParams
}: {
  searchParams?: Promise<{ scenario?: string }>;
}) {
  const params = await searchParams;
  const scenario = scenarios.find((candidate) => candidate === params?.scenario);
  return <ConsoleApp scenario={scenario} />;
}
