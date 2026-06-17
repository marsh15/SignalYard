import { diffJson, type ContextDiffRequest, type ContextDiffResponse } from "@/protocol/contextDiff";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<ContextDiffRequest>) => {
  const request = event.data;
  const response: ContextDiffResponse = {
    id: request.id,
    contextId: request.contextId,
    seq: request.seq,
    diff: diffJson(request.previous, request.next)
  };

  workerScope.postMessage(response);
};

export {};
