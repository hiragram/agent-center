import type { EventEmissionMessage } from "@event-emission-protocol/core";

export const CODEX_RUN_REQUESTED = "codex.run.requested";

export interface CodexRunRequest {
  prompt: string;
  agent?: string;
  cwd?: string;
  model?: string;
  thinking?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  profile?: string;
  json?: boolean;
}

export interface RequestParseResult {
  ok: boolean;
  request?: CodexRunRequest;
  reason?: string;
}

export function parseCodexRunRequest(
  message: EventEmissionMessage,
  expectedEventName = CODEX_RUN_REQUESTED,
): RequestParseResult {
  if (message.event.event_name !== expectedEventName) {
    return { ok: false, reason: "ignored event name" };
  }

  const data = message.event.data;
  if (!isRecord(data)) {
    return { ok: false, reason: "event data must be an object" };
  }

  if (typeof data.prompt !== "string" || data.prompt.trim() === "") {
    return { ok: false, reason: "event data prompt must be a non-empty string" };
  }

  const request: CodexRunRequest = {
    prompt: data.prompt,
  };

  if (data.cwd !== undefined) {
    if (typeof data.cwd !== "string" || data.cwd.trim() === "") {
      return { ok: false, reason: "event data cwd must be a non-empty string" };
    }
    request.cwd = data.cwd;
  }

  if (data.agent !== undefined) {
    if (typeof data.agent !== "string" || data.agent.trim() === "") {
      return { ok: false, reason: "event data agent must be a non-empty string" };
    }
    request.agent = data.agent;
  }

  if (data.model !== undefined) {
    if (typeof data.model !== "string" || data.model.trim() === "") {
      return { ok: false, reason: "event data model must be a non-empty string" };
    }
    request.model = data.model;
  }

  if (data.thinking !== undefined) {
    if (!isThinking(data.thinking)) {
      return { ok: false, reason: "event data thinking is unsupported" };
    }
    request.thinking = data.thinking;
  }

  if (data.sandbox !== undefined) {
    if (!isSandbox(data.sandbox)) {
      return { ok: false, reason: "event data sandbox is unsupported" };
    }
    request.sandbox = data.sandbox;
  }

  if (data.profile !== undefined) {
    if (typeof data.profile !== "string" || data.profile.trim() === "") {
      return { ok: false, reason: "event data profile must be a non-empty string" };
    }
    request.profile = data.profile;
  }

  if (data.json !== undefined) {
    if (typeof data.json !== "boolean") {
      return { ok: false, reason: "event data json must be a boolean" };
    }
    request.json = data.json;
  }

  return { ok: true, request };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinking(value: unknown): value is CodexRunRequest["thinking"] {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isSandbox(value: unknown): value is CodexRunRequest["sandbox"] {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}
