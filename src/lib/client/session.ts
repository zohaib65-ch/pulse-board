/**
 * A pseudonymous session id for this browser tab, held in memory only.
 * Reloading the tab starts a new session, like a fresh visit.
 */
import { newId } from "./ids";

let sessionId: string | null = null;

export function getTabSessionId(): string {
  sessionId ??= newId();
  return sessionId;
}
