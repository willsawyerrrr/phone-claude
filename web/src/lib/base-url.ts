/**
 * Builds an absolute URL under `PUBLIC_BASE_URL`, this app's publicly
 * reachable origin, for Twilio to request (TwiML) or POST back to
 * (webhooks). Also used to reconstruct the exact URL a Twilio request
 * signed, so it must match the deployment's actual public URL exactly.
 */
export function appUrl(path: string): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error("Missing required env var: PUBLIC_BASE_URL");
  return `${base.replace(/\/$/, "")}${path}`;
}
