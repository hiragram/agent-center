export interface RelayConfig {
  url: string;
  execute: boolean;
  codexBin: string;
  keepAliveIntervalHintSeconds?: number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RelayConfig {
  let url = env.EEP_STREAM_URL;
  let execute = env.CODEX_RELAY_EXECUTE === "1";
  let codexBin = env.CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex";
  let keepAliveIntervalHintSeconds = parseOptionalInteger(env.CODEX_RELAY_KEEP_ALIVE_SECONDS);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      url = requireValue(argv, index);
      index += 1;
    } else if (arg === "--execute") {
      execute = true;
    } else if (arg === "--dry-run") {
      execute = false;
    } else if (arg === "--codex-bin") {
      codexBin = requireValue(argv, index);
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

  if (url === undefined || url.trim() === "") {
    throw new Error("missing SSE endpoint URL; pass --url or set EEP_STREAM_URL");
  }

  return {
    url,
    execute,
    codexBin,
    keepAliveIntervalHintSeconds,
  };
}

export class HelpRequested extends Error {
  constructor() {
    super("help requested");
  }
}

export function usage(): string {
  return [
    "Usage: event-emission-codex-relay --url <sse-url> [--execute]",
    "",
    "Options:",
    "  --url <url>                  Event Emission Protocol SSE endpoint",
    "  --execute                    Run Codex; default is dry-run",
    "  --dry-run                    Log requests without running Codex",
    "  --codex-bin <path>           Codex CLI path",
    "  --keep-alive-seconds <n>     Preferred SSE keep-alive interval hint",
  ].join("\n");
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
