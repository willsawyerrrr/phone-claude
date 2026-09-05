export interface Config {
  apiUrl: string;
  apiSecret: string;
  userPhoneNumber: string;
  pollIntervalMs: number;
  maxWaitMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiUrl = requireEnv(env, "PHONE_CLAUDE_API_URL");
  const apiSecret = requireEnv(env, "PHONE_CLAUDE_API_SECRET");
  const userPhoneNumber = requireEnv(env, "USER_PHONE_NUMBER");

  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    apiSecret,
    userPhoneNumber,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    maxWaitMs: Number(env.MAX_WAIT_MS) || DEFAULT_MAX_WAIT_MS,
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
