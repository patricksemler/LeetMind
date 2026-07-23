// Hardware/software environment capture — docs/measurements.md needs "the exact hardware/OS,
// Docker version" so a reader could reproduce the method, per PLAN.md M5.
import { execSync } from "node:child_process";
import os from "node:os";

export interface EnvInfo {
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemGb: number;
  nodeVersion: string;
  dockerVersion: string;
  dockerComposeVersion: string;
}

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch (err) {
    return `(unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export function captureEnvInfo(): EnvInfo {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    nodeVersion: process.version,
    dockerVersion: safeExec("docker --version"),
    dockerComposeVersion: safeExec("docker compose version"),
  };
}
