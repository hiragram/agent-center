import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfigFile, parseArgs } from "../dist/config.js";
import { handleConfiguredMessage, handleMessage, renderCommand, renderPrompt } from "../dist/relay.js";
import { parseCodexRunRequest } from "../dist/request.js";
import { buildCodexArgs, buildOpenClawAgentArgs } from "../dist/runner.js";

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
    mode: "single",
    url: "https://example.test/events",
    execute: true,
    codexBin: "/tmp/codex",
    keepAliveIntervalHintSeconds: 20,
  });
});

test("loadConfigFile reads streams and agent routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-center-"));
  const path = join(dir, "agent-center.config.json");
  writeFileSync(path, JSON.stringify({
    execute: true,
    streams: [
      {
        id: "github",
        url: "https://example.test/github/events",
        headers: {
          Authorization: "Bearer test-token",
        },
        keepAliveIntervalHintSeconds: 20,
        routes: [
          {
            eventName: "issue.opened",
            agent: "triage",
            promptTemplate: "Triage issue: {{ data.title }}",
            command: {
              bin: "openclaw",
              args: ["agent", "--agent", "triage", "--message", "{{ prompt }}"],
              cwd: "/tmp/repo",
              env: {
                AGENT_CENTER_STREAM: "{{ stream.id }}",
              },
            },
            model: "gpt-5.2",
            thinking: "medium",
            cwd: "/tmp/repo",
          },
        ],
      },
    ],
  }));

  assert.deepEqual(loadConfigFile(path, {
    execute: false,
    codexBin: "/tmp/codex",
    openclawBin: "/tmp/openclaw",
  }), {
    mode: "configured",
    execute: true,
    codexBin: "/tmp/codex",
    openclawBin: "/tmp/openclaw",
    streams: [
      {
        id: "github",
        url: "https://example.test/github/events",
        headers: {
          Authorization: "Bearer test-token",
        },
        keepAliveIntervalHintSeconds: 20,
        routes: [
          {
            eventName: "issue.opened",
            agent: "triage",
            promptTemplate: "Triage issue: {{ data.title }}",
            command: {
              bin: "openclaw",
              args: ["agent", "--agent", "triage", "--message", "{{ prompt }}"],
              cwd: "/tmp/repo",
              env: {
                AGENT_CENTER_STREAM: "{{ stream.id }}",
              },
            },
            model: "gpt-5.2",
            thinking: "medium",
            cwd: "/tmp/repo",
          },
        ],
      },
    ],
  });
});

test("loadConfigFile expands environment variables in config strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-center-"));
  const path = join(dir, "agent-center.config.json");
  writeFileSync(path, JSON.stringify({
    streams: [
      {
        id: "github",
        url: "${EEP_STREAM_URL}",
        headers: {
          Authorization: "Bearer ${SSE_BEARER_TOKEN}",
          "X-Agent-Center": "${AGENT_CENTER_NAME:-devteam}",
        },
        routes: [
          {
            eventName: "github.ping.received",
            command: {
              bin: "${TRUE_BIN:-/usr/bin/true}",
              args: ["--repo", "${REPO_NAME}"],
              env: {
                TOKEN_FILE: "${TOKEN_FILE}",
              },
            },
          },
        ],
      },
    ],
  }));

  const config = loadConfigFile(path, {
    execute: false,
    codexBin: "/tmp/codex",
    openclawBin: "/tmp/openclaw",
  }, {
    EEP_STREAM_URL: "https://eep-bridge.reirei.app/events/github",
    SSE_BEARER_TOKEN: "secret-token",
    REPO_NAME: "reirei-lab/example",
    TOKEN_FILE: "/tmp/token",
  });

  assert.equal(config.streams[0].url, "https://eep-bridge.reirei.app/events/github");
  assert.deepEqual(config.streams[0].headers, {
    Authorization: "Bearer secret-token",
    "X-Agent-Center": "devteam",
  });
  assert.deepEqual(config.streams[0].routes[0].command, {
    bin: "/usr/bin/true",
    args: ["--repo", "reirei-lab/example"],
    env: {
      TOKEN_FILE: "/tmp/token",
    },
  });
});

test("loadConfigFile rejects missing environment variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-center-"));
  const path = join(dir, "agent-center.config.json");
  writeFileSync(path, JSON.stringify({
    streams: [
      {
        id: "github",
        url: "${MISSING_URL}",
        routes: [
          {
            eventName: "github.ping.received",
          },
        ],
      },
    ],
  }));

  assert.throws(
    () => loadConfigFile(path, {
      execute: false,
      codexBin: "/tmp/codex",
      openclawBin: "/tmp/openclaw",
    }, {}),
    /\$\.streams\[0\]\.url references missing environment variable MISSING_URL/,
  );
});

test("renderCommand interpolates command templates", () => {
  const rendered = renderCommand({
    bin: "openclaw",
    args: ["agent", "--agent", "{{ route.agent }}", "--message", "{{ prompt }}"],
    cwd: "{{ data.cwd }}",
    env: {
      EVENT_NAME: "{{ event.event_name }}",
    },
  }, {
    route: { agent: "triage" },
    event: { event_name: "issue.opened" },
    data: { cwd: "/tmp/project" },
    prompt: "Triage issue",
  });

  assert.deepEqual(rendered, {
    bin: "openclaw",
    args: ["agent", "--agent", "triage", "--message", "Triage issue"],
    cwd: "/tmp/project",
    env: {
      EVENT_NAME: "issue.opened",
    },
  });
});

test("renderPrompt interpolates service event data from route templates", () => {
  assert.equal(renderPrompt(message("issue.opened", {
    title: "Crash on launch",
    labels: ["bug", "urgent"],
  }), {
    eventName: "issue.opened",
    promptTemplate: "Handle {{ event.event_name }}: {{ data.title }} labels={{ data.labels }}",
  }, {
    id: "github",
    url: "https://example.test/events",
    routes: [],
  }), "Handle issue.opened: Crash on launch labels=[\"bug\",\"urgent\"]");
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

test("buildOpenClawAgentArgs maps agent routes to openclaw agent flags", () => {
  assert.deepEqual(buildOpenClawAgentArgs({
    prompt: "Handle issue",
    agent: "triage",
    model: "gpt-5.2",
    thinking: "high",
    json: true,
  }), [
    "agent",
    "--agent",
    "triage",
    "--model",
    "gpt-5.2",
    "--thinking",
    "high",
    "--json",
    "--message",
    "Handle issue",
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

test("handleConfiguredMessage routes service events to configured agents", async () => {
  const log = logger();
  const openclawCalls = [];
  const codexRunner = {
    async run() {
      throw new Error("codex runner should not be called");
    },
  };
  const openclawRunner = {
    async run(request) {
      openclawCalls.push(request);
      return { code: 0, signal: null, stdout: "done", stderr: "" };
    },
  };

  await handleConfiguredMessage(message("issue.opened", { title: "Triage this" }), {
    execute: true,
    stream: {
      id: "github",
      url: "https://example.test/events",
      routes: [
        {
          eventName: "issue.opened",
          agent: "triage",
          promptTemplate: "Triage issue: {{ data.title }}",
          cwd: "/tmp/project",
          thinking: "medium",
        },
      ],
    },
    codexRunner,
    openclawRunner,
    logger: log,
  });

  assert.deepEqual(openclawCalls, [
    {
      prompt: "Triage issue: Triage this",
      agent: "triage",
      cwd: "/tmp/project",
      thinking: "medium",
    },
  ]);
  assert.equal(log.entries.at(-1).text, "routed request completed");
});

test("handleConfiguredMessage runs configured command templates", async () => {
  const log = logger();
  const commandCalls = [];
  const runner = {
    async run() {
      throw new Error("agent runners should not be called");
    },
  };
  const commandRunner = {
    async run(command) {
      commandCalls.push(command);
      return { code: 0, signal: null, stdout: "done", stderr: "" };
    },
  };

  await handleConfiguredMessage(message("issue.opened", { title: "Crash", repo: "/tmp/project" }), {
    execute: true,
    stream: {
      id: "github",
      url: "https://example.test/events",
      routes: [
        {
          eventName: "issue.opened",
          promptTemplate: "Triage issue: {{ data.title }}",
          command: {
            bin: "openclaw",
            args: ["agent", "--agent", "triage", "--message", "{{ prompt }}"],
            cwd: "{{ data.repo }}",
          },
        },
      ],
    },
    codexRunner: runner,
    openclawRunner: runner,
    commandRunner,
    logger: log,
  });

  assert.deepEqual(commandCalls, [
    {
      bin: "openclaw",
      args: ["agent", "--agent", "triage", "--message", "Triage issue: Crash"],
      cwd: "/tmp/project",
      env: undefined,
    },
  ]);
  assert.equal(log.entries.at(-1).text, "command request completed");
});

test("handleConfiguredMessage ignores unrouted events", async () => {
  const log = logger();
  const runner = {
    async run() {
      throw new Error("runner should not be called");
    },
  };

  await handleConfiguredMessage(message("comment.created", { text: "Ignore me" }), {
    execute: true,
    stream: {
      id: "github",
      url: "https://example.test/events",
      routes: [{ eventName: "issue.opened", agent: "triage" }],
    },
    codexRunner: runner,
    openclawRunner: runner,
    commandRunner: runner,
    logger: log,
  });

  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].details.reason, "no matching route");
});
