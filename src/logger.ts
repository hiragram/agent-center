import type { RelayLogger } from "./relay.js";

type LogLevel = "info" | "warn" | "error";

export function createJsonLineLogger(output: NodeJS.WritableStream = process.stdout): RelayLogger {
  return {
    info(message, details) {
      writeLog(output, "info", message, details);
    },
    warn(message, details) {
      writeLog(output, "warn", message, details);
    },
    error(message, details) {
      writeLog(output, "error", message, details);
    },
  };
}

function writeLog(output: NodeJS.WritableStream, level: LogLevel, message: string, details: unknown): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(isRecord(details) ? details : details === undefined ? {} : { details }),
  };
  output.write(`${JSON.stringify(entry, jsonReplacer)}\n`);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
