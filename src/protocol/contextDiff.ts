import type { DiffEntry, JsonValue } from "./types";
import { isJsonObject } from "./types";

export interface ContextDiffRequest {
  id: string;
  contextId: string;
  seq: number;
  previous: JsonValue | null;
  next: JsonValue;
}

export interface ContextDiffResponse {
  id: string;
  contextId: string;
  seq: number;
  diff: DiffEntry[];
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) {
    return true;
  }

  if (left === undefined || right === undefined) {
    return false;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }

  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => sameJson(left[key], right[key]))
    );
  }

  return false;
}

function childPath(path: string, key: string | number): string {
  if (typeof key === "number") {
    return `${path}[${key}]`;
  }

  return path === "$" ? `$.${key}` : `${path}.${key}`;
}

function walkDiff(
  previous: JsonValue | undefined,
  next: JsonValue | undefined,
  path: string,
  entries: DiffEntry[]
) {
  if (previous === undefined && next !== undefined) {
    entries.push({ path, status: "added", after: next });
    return;
  }

  if (previous !== undefined && next === undefined) {
    entries.push({ path, status: "removed", before: previous });
    return;
  }

  if (previous === undefined || next === undefined || sameJson(previous, next)) {
    return;
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    const maxLength = Math.max(previous.length, next.length);
    for (let index = 0; index < maxLength; index += 1) {
      walkDiff(previous[index], next[index], childPath(path, index), entries);
    }
    return;
  }

  if (isJsonObject(previous) && isJsonObject(next)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of Array.from(keys).sort()) {
      walkDiff(previous[key], next[key], childPath(path, key), entries);
    }
    return;
  }

  entries.push({ path, status: "changed", before: previous, after: next });
}

export function diffJson(previous: JsonValue | null, next: JsonValue): DiffEntry[] {
  if (previous === null) {
    return [{ path: "$", status: "added", after: next }];
  }

  const entries: DiffEntry[] = [];
  walkDiff(previous, next, "$", entries);
  return entries;
}

export function createDiffIndex(entries: DiffEntry[]): Record<string, DiffEntry> {
  return Object.fromEntries(entries.map((entry) => [entry.path, entry]));
}

export function formatJsonPreview(value: JsonValue | undefined, limit = 96): string {
  if (value === undefined) {
    return "";
  }

  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  if (rendered.length <= limit) {
    return rendered;
  }

  return `${rendered.slice(0, limit - 1)}...`;
}
