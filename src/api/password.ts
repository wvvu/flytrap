import { createHash, timingSafeEqual } from "node:crypto";

/** Compare both sides in constant time, including when the lengths differ. */
export function credentialsMatch(username: string, password: string, expectedUser: string, expectedPassword: string): boolean {
  const userOk = digestEqual(username, expectedUser);
  const passOk = digestEqual(password, expectedPassword);
  return userOk && passOk;
}

function digestEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
