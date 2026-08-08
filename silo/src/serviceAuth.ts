import { timingSafeEqual } from "node:crypto";

const TOKEN_RE = /^[A-Za-z0-9._~-]+$/;
const MIN_TOKEN_LENGTH = 32;

/**
 * Validates a service token read from the environment (mirrors the `CODEX_CLOUD_TOKEN`
 * convention already used by deploy/railway/start.sh): URL-safe characters only, at least 32
 * of them. Throws with a clear message if misconfigured — fail loudly at boot, not silently at
 * the first request.
 */
export function requireServiceToken(rawValue: string | undefined, envVarName = "SILO_SERVICE_TOKEN"): string {
  if (!rawValue || !TOKEN_RE.test(rawValue) || rawValue.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${envVarName} must be set to at least ${MIN_TOKEN_LENGTH} URL-safe characters.`);
  }
  return rawValue;
}

/** Constant-time comparison of an `Authorization: Bearer <token>` header against the configured service token. */
export function isAuthorized(authorizationHeader: string | undefined, serviceToken: string): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(authorizationHeader.slice("Bearer ".length));
  const expected = Buffer.from(serviceToken);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
