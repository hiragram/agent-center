import { connectEventStream } from "@event-emission-protocol/client";
import type { EventEmissionMessage } from "@event-emission-protocol/core";
import type { AgentCenterConfig, RelayConfig, RouteConfig, RuntimeConfig, StreamConfig } from "./config.js";
import { CliCodexRunner, OpenClawAgentRunner, type CodexRunner } from "./runner.js";
import { parseCodexRunRequest } from "./request.js";
import type { CodexRunRequest } from "./request.js";

export interface RelayLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface RunRelayOptions {
  config: RuntimeConfig;
  runner?: CodexRunner;
  openclawRunner?: CodexRunner;
  logger?: RelayLogger;
}

export async function runRelay(options: RunRelayOptions): Promise<void> {
  const logger = options.logger ?? console;
  if (options.config.mode === "configured") {
    await runConfiguredRelay(options.config, {
      codexRunner: options.runner ?? new CliCodexRunner(options.config.codexBin),
      openclawRunner: options.openclawRunner ?? new OpenClawAgentRunner(options.config.openclawBin),
      logger,
    });
    return;
  }

  const runner = options.runner ?? new CliCodexRunner(options.config.codexBin);

  logger.info("connecting to event stream", {
    url: options.config.url,
    execute: options.config.execute,
  });

  for await (const message of connectEventStream(options.config.url, {
    keepAliveIntervalHintSeconds: options.config.keepAliveIntervalHintSeconds,
  })) {
    await handleMessage(message, {
      execute: options.config.execute,
      runner,
      logger,
    });
  }
}

async function runConfiguredRelay(
  config: AgentCenterConfig,
  options: { codexRunner: CodexRunner; openclawRunner: CodexRunner; logger: RelayLogger },
): Promise<void> {
  await Promise.all(config.streams.map((stream) => runStream(stream, config, options)));
}

async function runStream(
  stream: StreamConfig,
  config: AgentCenterConfig,
  options: { codexRunner: CodexRunner; openclawRunner: CodexRunner; logger: RelayLogger },
): Promise<void> {
  options.logger.info("connecting to event stream", {
    streamId: stream.id,
    url: stream.url,
    execute: config.execute,
  });

  for await (const message of connectEventStream(stream.url, {
    keepAliveIntervalHintSeconds: stream.keepAliveIntervalHintSeconds,
  })) {
    await handleConfiguredMessage(message, {
      execute: config.execute,
      stream,
      codexRunner: options.codexRunner,
      openclawRunner: options.openclawRunner,
      logger: options.logger,
    });
  }
}

export interface HandleMessageOptions {
  execute: boolean;
  runner: CodexRunner;
  logger: RelayLogger;
}

export interface HandleConfiguredMessageOptions {
  execute: boolean;
  stream: StreamConfig;
  codexRunner: CodexRunner;
  openclawRunner: CodexRunner;
  logger: RelayLogger;
}

export async function handleConfiguredMessage(
  message: EventEmissionMessage,
  options: HandleConfiguredMessageOptions,
): Promise<void> {
  const route = options.stream.routes.find((candidate) => candidate.eventName === message.event.event_name);
  if (route === undefined) {
    options.logger.info("ignored event", {
      streamId: options.stream.id,
      messageId: message.message_id,
      eventName: message.event.event_name,
      reason: "no matching route",
    });
    return;
  }

  const parsed = parseCodexRunRequest(message, route.eventName);
  if (!parsed.ok || parsed.request === undefined) {
    options.logger.info("ignored event", {
      streamId: options.stream.id,
      messageId: message.message_id,
      eventName: message.event.event_name,
      reason: parsed.reason,
    });
    return;
  }

  const request = applyRoute(parsed.request, route);
  const runnerKind = route.runner ?? (route.agent === undefined ? "codex" : "openclaw");
  const runner = runnerKind === "openclaw" ? options.openclawRunner : options.codexRunner;

  if (!options.execute) {
    options.logger.info("dry-run routed request", {
      streamId: options.stream.id,
      messageId: message.message_id,
      eventName: message.event.event_name,
      runner: runnerKind,
      agent: request.agent,
      cwd: request.cwd,
      model: request.model,
      prompt: request.prompt,
    });
    return;
  }

  options.logger.info("running routed request", {
    streamId: options.stream.id,
    messageId: message.message_id,
    eventName: message.event.event_name,
    runner: runnerKind,
    agent: request.agent,
    cwd: request.cwd,
    model: request.model,
  });

  const result = await runner.run(request);
  if (result.code === 0) {
    options.logger.info("routed request completed", {
      streamId: options.stream.id,
      messageId: message.message_id,
      stdout: result.stdout,
    });
    return;
  }

  options.logger.error("routed request failed", {
    streamId: options.stream.id,
    messageId: message.message_id,
    code: result.code,
    signal: result.signal,
    stderr: result.stderr,
  });
}

export async function handleMessage(message: EventEmissionMessage, options: HandleMessageOptions): Promise<void> {
  const parsed = parseCodexRunRequest(message);
  if (!parsed.ok || parsed.request === undefined) {
    options.logger.info("ignored event", {
      messageId: message.message_id,
      eventName: message.event.event_name,
      reason: parsed.reason,
    });
    return;
  }

  if (!options.execute) {
    options.logger.info("dry-run codex request", {
      messageId: message.message_id,
      cwd: parsed.request.cwd,
      model: parsed.request.model,
      prompt: parsed.request.prompt,
    });
    return;
  }

  options.logger.info("running codex request", {
    messageId: message.message_id,
    cwd: parsed.request.cwd,
    model: parsed.request.model,
  });

  const result = await options.runner.run(parsed.request);
  if (result.code === 0) {
    options.logger.info("codex request completed", {
      messageId: message.message_id,
      stdout: result.stdout,
    });
    return;
  }

  options.logger.error("codex request failed", {
    messageId: message.message_id,
    code: result.code,
    signal: result.signal,
    stderr: result.stderr,
  });
}

function applyRoute(request: CodexRunRequest, route: RouteConfig): CodexRunRequest {
  const routed: CodexRunRequest = { ...request };
  assignIfDefined(routed, "agent", route.agent ?? request.agent);
  assignIfDefined(routed, "cwd", route.cwd ?? request.cwd);
  assignIfDefined(routed, "model", route.model ?? request.model);
  assignIfDefined(routed, "thinking", route.thinking ?? request.thinking);
  assignIfDefined(routed, "sandbox", route.sandbox ?? request.sandbox);
  assignIfDefined(routed, "profile", route.profile ?? request.profile);
  assignIfDefined(routed, "json", route.json ?? request.json);
  return routed;
}

function assignIfDefined<Key extends keyof CodexRunRequest>(
  target: CodexRunRequest,
  key: Key,
  value: CodexRunRequest[Key] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
