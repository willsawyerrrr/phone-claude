/** Checks the `Authorization: Bearer <token>` header against `API_SECRET`. */
export function isAuthorized(request: Request): boolean {
  const secret = process.env.API_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;

  return header.slice("Bearer ".length) === secret;
}
