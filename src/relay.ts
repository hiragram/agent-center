import { connectEventStream } from "@event-emission-protocol/client";
import type { EventEmissionMessage } from "@event-emission-protocol/core";
import type { RelayConfig } from "./config.js";
import { CliCodexRunner, type CodexRunner } from "./runner.js";
import { parseCodexRunRequest } from "./request.js";

export interface RelayLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface RunRelayOptions {
  config: RelayConfig;
  runner?: CodexRunner;
  logger?: RelayLogger;
}

export async function runRelay(options: RunRelayOptions): Promise<void> {
  const logger = options.logger ?? console;
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

export interface HandleMessageOptions {
  execute: boolean;
  runner: CodexRunner;
  logger: RelayLogger;
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
