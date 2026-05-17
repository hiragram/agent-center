import { connectEventStream } from "@event-emission-protocol/client";
import type { EventEmissionMessage } from "@event-emission-protocol/core";
import type { AgentCenterConfig, CommandConfig, RelayConfig, RouteConfig, RuntimeConfig, StreamConfig } from "./config.js";
import {
  buildCommandRequest,
  CliCodexRunner,
  OpenClawAgentRunner,
  SpawnCommandRunner,
  type CodexRunner,
  type CommandRunRequest,
  type CommandRunner,
} from "./runner.js";
import { createRunRequestFromEvent, parseCodexRunRequest } from "./request.js";
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
  commandRunner?: CommandRunner;
  logger?: RelayLogger;
}

const reconnectDelayMs = 1000;

export async function runRelay(options: RunRelayOptions): Promise<void> {
  const logger = options.logger ?? console;
  if (options.config.mode === "configured") {
    await runConfiguredRelay(options.config, {
      codexRunner: options.runner ?? new CliCodexRunner(options.config.codexBin),
      openclawRunner: options.openclawRunner ?? new OpenClawAgentRunner(options.config.openclawBin),
      commandRunner: options.commandRunner ?? new SpawnCommandRunner(),
      logger,
    });
    return;
  }

  const runner = options.runner ?? new CliCodexRunner(options.config.codexBin);

  for (;;) {
    logger.info("connecting to event stream", {
      url: options.config.url,
      execute: options.config.execute,
    });

    try {
      for await (const message of connectEventStream(options.config.url, {
        keepAliveIntervalHintSeconds: options.config.keepAliveIntervalHintSeconds,
      })) {
        await handleMessage(message, {
          execute: options.config.execute,
          runner,
          logger,
        });
      }
      logger.warn("event stream ended; reconnecting", { url: options.config.url });
    } catch (error) {
      logger.error("event stream failed; reconnecting", {
        url: options.config.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await sleep(reconnectDelayMs);
  }
}

async function runConfiguredRelay(
  config: AgentCenterConfig,
  options: {
    codexRunner: CodexRunner;
    openclawRunner: CodexRunner;
    commandRunner: CommandRunner;
    logger: RelayLogger;
  },
): Promise<void> {
  await Promise.all(config.streams.map((stream) => runStream(stream, config, options)));
}

async function runStream(
  stream: StreamConfig,
  config: AgentCenterConfig,
  options: {
    codexRunner: CodexRunner;
    openclawRunner: CodexRunner;
    commandRunner: CommandRunner;
    logger: RelayLogger;
  },
): Promise<void> {
  for (;;) {
    options.logger.info("connecting to event stream", {
      streamId: stream.id,
      url: stream.url,
      execute: config.execute,
    });

    try {
      for await (const message of connectEventStream(stream.url, {
        headers: stream.headers,
        keepAliveIntervalHintSeconds: stream.keepAliveIntervalHintSeconds,
      })) {
        await handleConfiguredMessage(message, {
          execute: config.execute,
          stream,
          codexRunner: options.codexRunner,
          openclawRunner: options.openclawRunner,
          commandRunner: options.commandRunner,
          logger: options.logger,
        });
      }
      options.logger.warn("event stream ended; reconnecting", { streamId: stream.id, url: stream.url });
    } catch (error) {
      options.logger.error("event stream failed; reconnecting", {
        streamId: stream.id,
        url: stream.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await sleep(reconnectDelayMs);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
  commandRunner: CommandRunner;
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
      data: message.event.data,
    });
    return;
  }

  const request = applyRoute(
    createRunRequestFromEvent(renderPrompt(message, route, options.stream)),
    route,
  );
  const templateContext = createTemplateContext(message, route, options.stream, request.prompt);

  if (route.router !== undefined) {
    await runRouterRoute(renderCommand(route.router, templateContext), message, route, templateContext, options);
    return;
  }

  if (route.command !== undefined) {
    const command = renderCommand(route.command, templateContext);
    await runCommandRoute(command, message, route, options);
    return;
  }

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
      data: message.event.data,
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
    data: message.event.data,
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

async function runRouterRoute(
  router: CommandRunRequest,
  message: EventEmissionMessage,
  route: RouteConfig,
  templateContext: Record<string, unknown>,
  options: HandleConfiguredMessageOptions,
): Promise<void> {
  const input = `${JSON.stringify(templateContext)}\n`;
  const timeoutMs = router.timeoutMs ?? 5000;
  options.logger.info("running event router", {
    streamId: options.stream.id,
    messageId: message.message_id,
    eventName: message.event.event_name,
    bin: router.bin,
    args: router.args,
    cwd: router.cwd,
    timeoutMs,
  });

  const result = await options.commandRunner.run({
    ...router,
    input,
    timeoutMs,
  });

  if (result.code !== 0) {
    options.logger.error("event router failed", {
      streamId: options.stream.id,
      messageId: message.message_id,
      eventName: message.event.event_name,
      code: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return;
  }

  const parsed = parseRouterOutput(result.stdout);
  if (!parsed.ok) {
    options.logger.error("event router failed", {
      streamId: options.stream.id,
      messageId: message.message_id,
      eventName: message.event.event_name,
      reason: parsed.reason,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return;
  }

  if (parsed.ignore) {
    options.logger.info("event router ignored event", {
      streamId: options.stream.id,
      messageId: message.message_id,
      eventName: message.event.event_name,
      reason: parsed.reason,
      stderr: result.stderr,
    });
    return;
  }

  options.logger.info("event router selected command", {
    streamId: options.stream.id,
    messageId: message.message_id,
    eventName: message.event.event_name,
    command: parsed.command,
    stderr: result.stderr,
  });
  await runCommandRoute(parsed.command, message, route, options);
}

async function runCommandRoute(
  command: CommandRunRequest,
  message: EventEmissionMessage,
  route: RouteConfig,
  options: HandleConfiguredMessageOptions,
): Promise<void> {
  if (!options.execute) {
    options.logger.info("dry-run command request", {
      streamId: options.stream.id,
      messageId: message.message_id,
      eventName: message.event.event_name,
      command,
      data: message.event.data,
    });
    return;
  }

  options.logger.info("running command request", {
    streamId: options.stream.id,
    messageId: message.message_id,
    eventName: message.event.event_name,
    bin: command.bin,
    args: command.args,
    cwd: command.cwd,
    data: message.event.data,
  });

  const result = await options.commandRunner.run(command);
  if (result.code === 0) {
    options.logger.info("command request completed", {
      streamId: options.stream.id,
      messageId: message.message_id,
      stdout: result.stdout,
    });
    return;
  }

  options.logger.error("command request failed", {
    streamId: options.stream.id,
    messageId: message.message_id,
    route: route.eventName,
    code: result.code,
    signal: result.signal,
    stderr: result.stderr,
  });
}

type RouterOutput =
  | { ok: true; ignore: true; reason?: string }
  | { ok: true; ignore: false; command: CommandRunRequest }
  | { ok: false; reason: string };

function parseRouterOutput(stdout: string): RouterOutput {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return { ok: false, reason: "router stdout was empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      reason: `router stdout was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false, reason: "router output must be an object" };
  }

  if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
    return { ok: false, reason: parsed.error };
  }

  if (parsed.ignore === true) {
    return {
      ok: true,
      ignore: true,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }

  if (parsed.command === undefined) {
    return { ok: false, reason: "router output must include command or ignore=true" };
  }

  const command = parseRouterCommand(parsed.command);
  if (!command.ok) {
    return command;
  }
  return {
    ok: true,
    ignore: false,
    command: command.command,
  };
}

function parseRouterCommand(value: unknown): { ok: true; command: CommandRunRequest } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "router command must be an object" };
  }
  if (typeof value.bin !== "string" || value.bin.trim() === "") {
    return { ok: false, reason: "router command.bin must be a non-empty string" };
  }

  const command: CommandRunRequest = {
    bin: value.bin,
    args: [],
  };

  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
      return { ok: false, reason: "router command.args must be an array of strings" };
    }
    command.args = value.args;
  }

  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string" || value.cwd.trim() === "") {
      return { ok: false, reason: "router command.cwd must be a non-empty string" };
    }
    command.cwd = value.cwd;
  }

  if (value.env !== undefined) {
    if (!isRecord(value.env)) {
      return { ok: false, reason: "router command.env must be an object" };
    }
    const env: Record<string, string> = {};
    for (const [key, envValue] of Object.entries(value.env)) {
      if (typeof envValue !== "string") {
        return { ok: false, reason: `router command.env.${key} must be a string` };
      }
      env[key] = envValue;
    }
    command.env = env;
  }

  return { ok: true, command };
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

export function renderPrompt(message: EventEmissionMessage, route: RouteConfig, stream: StreamConfig): string {
  if (route.promptTemplate !== undefined) {
    return renderTemplate(route.promptTemplate, createTemplateContext(message, route, stream));
  }

  return [
    `An event was emitted by service stream "${stream.id}".`,
    "",
    "Decide what, if anything, should be done in response.",
    "",
    "Event:",
    JSON.stringify(message, null, 2),
  ].join("\n");
}

export function renderCommand(command: CommandConfig, context: Record<string, unknown>): CommandRunRequest {
  return buildCommandRequest({
    bin: renderTemplate(command.bin, context),
    args: command.args?.map((arg) => renderTemplate(arg, context)),
    cwd: command.cwd === undefined ? undefined : renderTemplate(command.cwd, context),
    env: command.env === undefined ? undefined : Object.fromEntries(
      Object.entries(command.env).map(([key, value]) => [key, renderTemplate(value, context)]),
    ),
    timeoutMs: "timeoutMs" in command && typeof command.timeoutMs === "number" ? command.timeoutMs : undefined,
  });
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    const value = lookupPath(context, path);
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  });
}

function createTemplateContext(
  message: EventEmissionMessage,
  route: RouteConfig,
  stream: StreamConfig,
  prompt?: string,
): Record<string, unknown> {
  return {
    stream,
    route,
    message,
    event: message.event,
    data: message.event.data,
    prompt,
  };
}

function lookupPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
