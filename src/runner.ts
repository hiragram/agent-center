import { spawn } from "node:child_process";
import type { CodexRunRequest } from "./request.js";

export interface CodexRunner {
  run(request: CodexRunRequest): Promise<CodexRunResult>;
}

export interface CodexRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class CliCodexRunner implements CodexRunner {
  constructor(private readonly codexBin: string) {}

  run(request: CodexRunRequest): Promise<CodexRunResult> {
    const args = buildCodexArgs(request);
    const child = spawn(this.codexBin, args, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    });
  }
}

export function buildCodexArgs(request: CodexRunRequest): string[] {
  const args = ["exec"];

  if (request.model !== undefined) {
    args.push("--model", request.model);
  }

  if (request.thinking !== undefined) {
    args.push("-c", `model_reasoning_effort="${request.thinking}"`);
  }

  if (request.sandbox !== undefined) {
    args.push("--sandbox", request.sandbox);
  }

  if (request.cwd !== undefined) {
    args.push("--cd", request.cwd);
  }

  if (request.profile !== undefined) {
    args.push("--profile", request.profile);
  }

  if (request.json === true) {
    args.push("--json");
  }

  args.push(request.prompt);
  return args;
}
