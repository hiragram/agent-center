import { readFileSync } from "node:fs";

export interface RelayConfig {
  mode: "single";
  url: string;
  execute: boolean;
  codexBin: string;
  keepAliveIntervalHintSeconds?: number;
}

export interface AgentCenterConfig {
  mode: "configured";
  execute: boolean;
  codexBin: string;
  openclawBin: string;
  streams: StreamConfig[];
}

export interface StreamConfig {
  id: string;
  url: string;
  keepAliveIntervalHintSeconds?: number;
  routes: RouteConfig[];
}

export interface RouteConfig {
  eventName: string;
  agent?: string;
  runner?: "codex" | "openclaw";
  cwd?: string;
  model?: string;
  thinking?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  profile?: string;
  json?: boolean;
}

export type RuntimeConfig = RelayConfig | AgentCenterConfig;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  let configPath = env.AGENT_CENTER_CONFIG;
  let url = env.EEP_STREAM_URL;
  let execute = env.CODEX_RELAY_EXECUTE === "1";
  let codexBin = env.CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex";
  let openclawBin = env.OPENCLAW_BIN ?? "openclaw";
  let keepAliveIntervalHintSeconds = parseOptionalInteger(env.CODEX_RELAY_KEEP_ALIVE_SECONDS);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      configPath = requireValue(argv, index);
      index += 1;
    } else if (arg === "--url") {
      url = requireValue(argv, index);
      index += 1;
    } else if (arg === "--execute") {
      execute = true;
    } else if (arg === "--dry-run") {
      execute = false;
    } else if (arg === "--codex-bin") {
      codexBin = requireValue(argv, index);
      index += 1;
    } else if (arg === "--openclaw-bin") {
      openclawBin = requireValue(argv, index);
      index += 1;
    } else if (arg === "--keep-alive-seconds") {
      keepAliveIntervalHintSeconds = parseRequiredInteger(requireValue(argv, index), arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (configPath !== undefined && configPath.trim() !== "") {
    return loadConfigFile(configPath, { execute, codexBin, openclawBin });
  }

  if (url === undefined || url.trim() === "") {
    throw new Error("missing SSE endpoint URL; pass --url, --config, EEP_STREAM_URL, or AGENT_CENTER_CONFIG");
  }

  return {
    mode: "single",
    url,
    execute,
    codexBin,
    keepAliveIntervalHintSeconds,
  };
}

export function loadConfigFile(
  path: string,
  defaults: Pick<AgentCenterConfig, "execute" | "codexBin" | "openclawBin"> = {
    execute: process.env.CODEX_RELAY_EXECUTE === "1",
    codexBin: process.env.CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex",
    openclawBin: process.env.OPENCLAW_BIN ?? "openclaw",
  },
): AgentCenterConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("config file must contain a JSON object");
  }

  const execute = parsed.execute === undefined ? defaults.execute : requireBoolean(parsed.execute, "execute");
  const codexBin = parsed.codexBin === undefined ? defaults.codexBin : requireString(parsed.codexBin, "codexBin");
  const openclawBin = parsed.openclawBin === undefined
    ? defaults.openclawBin
    : requireString(parsed.openclawBin, "openclawBin");
  const streamsValue = parsed.streams;
  if (!Array.isArray(streamsValue) || streamsValue.length === 0) {
    throw new Error("config streams must be a non-empty array");
  }

  return {
    mode: "configured",
    execute,
    codexBin,
    openclawBin,
    streams: streamsValue.map(parseStreamConfig),
  };
}

export class HelpRequested extends Error {
  constructor() {
    super("help requested");
  }
}

export function usage(): string {
  return [
    "Usage: agent-center --url <sse-url> [--execute]",
    "       agent-center --config <agent-center.config.json> [--execute]",
    "",
    "Options:",
    "  --config <path>              JSON config with streams and routes",
    "  --url <url>                  Event Emission Protocol SSE endpoint",
    "  --execute                    Run Codex; default is dry-run",
    "  --dry-run                    Log requests without running Codex",
    "  --codex-bin <path>           Codex CLI path",
    "  --openclaw-bin <path>        OpenClaw CLI path",
    "  --keep-alive-seconds <n>     Preferred SSE keep-alive interval hint",
  ].join("\n");
}

function parseStreamConfig(value: unknown, index: number): StreamConfig {
  if (!isRecord(value)) {
    throw new Error(`streams[${index}] must be an object`);
  }

  const routes = value.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error(`streams[${index}].routes must be a non-empty array`);
  }

  return {
    id: requireString(value.id, `streams[${index}].id`),
    url: requireString(value.url, `streams[${index}].url`),
    keepAliveIntervalHintSeconds: parseMaybePositiveInteger(
      value.keepAliveIntervalHintSeconds,
      `streams[${index}].keepAliveIntervalHintSeconds`,
    ),
    routes: routes.map((route, routeIndex) => parseRouteConfig(route, index, routeIndex)),
  };
}

function parseRouteConfig(value: unknown, streamIndex: number, routeIndex: number): RouteConfig {
  if (!isRecord(value)) {
    throw new Error(`streams[${streamIndex}].routes[${routeIndex}] must be an object`);
  }

  const prefix = `streams[${streamIndex}].routes[${routeIndex}]`;
  const route: RouteConfig = {
    eventName: requireString(value.eventName, `${prefix}.eventName`),
  };

  if (value.agent !== undefined) {
    route.agent = requireString(value.agent, `${prefix}.agent`);
  }

  if (value.runner !== undefined) {
    if (value.runner !== "codex" && value.runner !== "openclaw") {
      throw new Error(`${prefix}.runner must be "codex" or "openclaw"`);
    }
    route.runner = value.runner;
  }

  if (value.cwd !== undefined) route.cwd = requireString(value.cwd, `${prefix}.cwd`);
  if (value.model !== undefined) route.model = requireString(value.model, `${prefix}.model`);
  if (value.profile !== undefined) route.profile = requireString(value.profile, `${prefix}.profile`);
  if (value.json !== undefined) route.json = requireBoolean(value.json, `${prefix}.json`);
  if (value.thinking !== undefined) route.thinking = requireThinking(value.thinking, `${prefix}.thinking`);
  if (value.sandbox !== undefined) route.sandbox = requireSandbox(value.sandbox, `${prefix}.sandbox`);

  return route;
}

function requireValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${argv[index]}`);
  }
  return value;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return parseRequiredInteger(value, "environment variable");
}

function parseRequiredInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseMaybePositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function requireThinking(value: unknown, name: string): RouteConfig["thinking"] {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error(`${name} is unsupported`);
}

function requireSandbox(value: unknown, name: string): RouteConfig["sandbox"] {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  throw new Error(`${name} is unsupported`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
