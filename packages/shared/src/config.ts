import os from "node:os";
import { z } from "zod";

/**
 * Config is parsed once at startup with zod. Missing/invalid required env vars fail loudly here,
 * never at first use. See docs/CONTRACTS.md §2 for the authoritative variable table.
 */

export const DEFAULT_SINGLE_USER_ID = "00000000000000000000000001";

function parseEnv<S extends z.ZodTypeAny>(schema: S, source: NodeJS.ProcessEnv): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid or missing environment variables:\n${issues}`);
  }
  return result.data;
}

/** Vars used by every TS service ("all" / "ts" in CONTRACTS §2). */
const BaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://leetmind:leetmind@localhost:5432/leetmind"),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.string().min(1).default("info"),
  NODE_ENV: z.string().min(1).default("development"),
  SINGLE_USER_ID: z.string().min(1).default(DEFAULT_SINGLE_USER_ID),
});

export interface BaseConfig {
  databaseUrl: string;
  pgPoolMax: number;
  logLevel: string;
  nodeEnv: string;
  singleUserId: string;
}

export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  const parsed = parseEnv(BaseEnvSchema, env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    pgPoolMax: parsed.PGPOOL_MAX,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    singleUserId: parsed.SINGLE_USER_ID,
  };
}

/** apps/api */
const ApiEnvSchema = BaseEnvSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(8080),
  API_HOST: z.string().min(1).default("0.0.0.0"),
});

export interface ApiConfig extends BaseConfig {
  apiPort: number;
  apiHost: string;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = parseEnv(ApiEnvSchema, env);
  return {
    ...loadBaseConfig(env),
    apiPort: parsed.API_PORT,
    apiHost: parsed.API_HOST,
  };
}

/** apps/judge */
const JudgeEnvSchema = BaseEnvSchema.extend({
  JUDGE_WORKER_ID: z.string().min(1).optional(),
  JUDGE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  SANDBOX_PYTHON_IMAGE: z.string().min(1).default("leetmind/runner-python:1"),
  SANDBOX_CPP_IMAGE: z.string().min(1).default("leetmind/runner-cpp:1"),
});

export interface JudgeConfig extends BaseConfig {
  judgeWorkerId: string;
  judgeConcurrency: number;
  sandboxPythonImage: string;
  sandboxCppImage: string;
}

export function loadJudgeConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  const parsed = parseEnv(JudgeEnvSchema, env);
  return {
    ...loadBaseConfig(env),
    judgeWorkerId: parsed.JUDGE_WORKER_ID ?? `${os.hostname()}-${process.pid}`,
    judgeConcurrency: parsed.JUDGE_CONCURRENCY,
    sandboxPythonImage: parsed.SANDBOX_PYTHON_IMAGE,
    sandboxCppImage: parsed.SANDBOX_CPP_IMAGE,
  };
}

/**
 * @leetmind/sandbox — the execution substrate config. Standalone (no DB/base fields): it's a
 * library consumed by judge (and, from Python, by the content worker), not a standalone service.
 */
const SandboxEnvSchema = z.object({
  SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(256),
  SANDBOX_CPUS: z.coerce.number().positive().default(1.0),
  SANDBOX_PIDS_LIMIT: z.coerce.number().int().positive().default(64),
  SANDBOX_WALL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  SANDBOX_OUTPUT_LIMIT_BYTES: z.coerce.number().int().positive().default(65536),
  SANDBOX_WORK_DIR: z.string().min(1).default("/tmp/leetmind-sandbox"),
  DOCKER_BIN: z.string().min(1).default("docker"),
});

export interface SandboxConfig {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  wallTimeoutMs: number;
  outputLimitBytes: number;
  workDir: string;
  dockerBin: string;
}

export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const parsed = parseEnv(SandboxEnvSchema, env);
  return {
    memoryMb: parsed.SANDBOX_MEMORY_MB,
    cpus: parsed.SANDBOX_CPUS,
    pidsLimit: parsed.SANDBOX_PIDS_LIMIT,
    wallTimeoutMs: parsed.SANDBOX_WALL_TIMEOUT_MS,
    outputLimitBytes: parsed.SANDBOX_OUTPUT_LIMIT_BYTES,
    workDir: parsed.SANDBOX_WORK_DIR,
    dockerBin: parsed.DOCKER_BIN,
  };
}
