export interface Config {
  pipelineUrl: string;
  ariUrl: string;
  ariUsername: string;
  ariPassword: string;
  sipEndpoint: string;
  dialplanContext: string;
  dialplanExtension: string;
  pollIntervalMs: number;
  maxWaitMs: number;
  pushWaitMs: number;
  ringTimeoutS: number;
}

const DEFAULT_PIPELINE_URL = "http://localhost:8080";
const DEFAULT_ARI_URL = "http://localhost:8088";
const DEFAULT_SIP_ENDPOINT = "phone";
const DEFAULT_DIALPLAN_CONTEXT = "ask-by-phone";
const DEFAULT_DIALPLAN_EXTENSION = "700";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1_000;
const DEFAULT_PUSH_WAIT_MS = 20_000;
const DEFAULT_RING_TIMEOUT_S = 60;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ariUsername = requireEnv(env, "ARI_USERNAME");
  const ariPassword = requireEnv(env, "ARI_PASSWORD");

  return {
    pipelineUrl: stripTrailingSlashes(env.PIPELINE_URL || DEFAULT_PIPELINE_URL),
    ariUrl: stripTrailingSlashes(env.ARI_URL || DEFAULT_ARI_URL),
    ariUsername,
    ariPassword,
    sipEndpoint: env.SIP_ENDPOINT || DEFAULT_SIP_ENDPOINT,
    dialplanContext: env.DIALPLAN_CONTEXT || DEFAULT_DIALPLAN_CONTEXT,
    dialplanExtension: env.DIALPLAN_EXTENSION || DEFAULT_DIALPLAN_EXTENSION,
    pollIntervalMs: positiveNumber(
      env,
      "POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
    ),
    maxWaitMs: positiveNumber(env, "MAX_WAIT_MS", DEFAULT_MAX_WAIT_MS),
    pushWaitMs: positiveNumber(env, "PUSH_WAIT_MS", DEFAULT_PUSH_WAIT_MS),
    ringTimeoutS: positiveNumber(env, "RING_TIMEOUT_S", DEFAULT_RING_TIMEOUT_S),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function positiveNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return value;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}
