import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../dist/config.js";
import { handleMessage } from "../dist/relay.js";
import { parseCodexRunRequest } from "../dist/request.js";
import { buildCodexArgs } from "../dist/runner.js";

function message(eventName, data = {}) {
  return {
    protocol_version: "0.1.0",
    message_id: "msg_test",
    type: "event.created",
    created_at: "2026-05-15T12:00:00Z",
    event: {
      event_name: eventName,
      data,
    },
  };
}

function logger() {
  const entries = [];
  return {
    entries,
    info(text, details) {
      entries.push({ level: "info", text, details });
    },
    warn(text, details) {
      entries.push({ level: "warn", text, details });
    },
    error(text, details) {
      entries.push({ level: "error", text, details });
    },
  };
}

test("parseArgs reads URL and execution controls", () => {
  const config = parseArgs([
    "--url",
    "https://example.test/events",
    "--execute",
    "--codex-bin",
    "/tmp/codex",
    "--keep-alive-seconds",
    "20",
  ], {});

  assert.deepEqual(config, {
    url: "https://example.test/events",
    execute: true,
    codexBin: "/tmp/codex",
    keepAliveIntervalHintSeconds: 20,
  });
});

test("parseCodexRunRequest accepts codex.run.requested events", () => {
  const parsed = parseCodexRunRequest(message("codex.run.requested", {
    prompt: "Do the thing",
    cwd: "/tmp/project",
    model: "gpt-5.2",
    thinking: "medium",
    sandbox: "workspace-write",
    json: true,
  }));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.request, {
    prompt: "Do the thing",
    cwd: "/tmp/project",
    model: "gpt-5.2",
    thinking: "medium",
    sandbox: "workspace-write",
    json: true,
  });
});

test("parseCodexRunRequest rejects invalid request shapes", () => {
  assert.deepEqual(parseCodexRunRequest(message("other.event")), {
    ok: false,
    reason: "ignored event name",
  });
  assert.deepEqual(parseCodexRunRequest(message("codex.run.requested", { prompt: "" })), {
    ok: false,
    reason: "event data prompt must be a non-empty string",
  });
  assert.deepEqual(parseCodexRunRequest(message("codex.run.requested", { prompt: "x", thinking: "max" })), {
    ok: false,
    reason: "event data thinking is unsupported",
  });
});

test("buildCodexArgs maps request fields to codex exec flags", () => {
  assert.deepEqual(buildCodexArgs({
    prompt: "Run task",
    cwd: "/tmp/project",
    model: "gpt-5.2",
    thinking: "high",
    sandbox: "workspace-write",
    profile: "work",
    json: true,
  }), [
    "exec",
    "--model",
    "gpt-5.2",
    "-c",
    "model_reasoning_effort=\"high\"",
    "--sandbox",
    "workspace-write",
    "--cd",
    "/tmp/project",
    "--profile",
    "work",
    "--json",
    "Run task",
  ]);
});

test("handleMessage logs dry-runs without invoking the runner", async () => {
  const log = logger();
  const runner = {
    async run() {
      throw new Error("runner should not be called");
    },
  };

  await handleMessage(message("codex.run.requested", { prompt: "Hello" }), {
    execute: false,
    runner,
    logger: log,
  });

  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].text, "dry-run codex request");
});

test("handleMessage invokes the runner in execute mode", async () => {
  const log = logger();
  const calls = [];
  const runner = {
    async run(request) {
      calls.push(request);
      return { code: 0, signal: null, stdout: "done", stderr: "" };
    },
  };

  await handleMessage(message("codex.run.requested", { prompt: "Hello" }), {
    execute: true,
    runner,
    logger: log,
  });

  assert.deepEqual(calls, [{ prompt: "Hello" }]);
  assert.equal(log.entries.at(-1).text, "codex request completed");
});
