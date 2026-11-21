/**
 * First names for the two household members, for on-screen labels only
 * (Settings, the consent screen). Pavel asked for names on screen; everything
 * that leaves the server (MCP answers, AI prompts) keeps the User 1 / User 2
 * labels, and tests/boundaries.test.ts stops src/mcp and src/core/ai from
 * importing this file.
 *
 * The mapping follows ALLOWED_EMAILS order: Pavel's address is first. If that
 * order changes, change this too.
 */
import type { OwnerLabel } from "./allowlist";

const DISPLAY: Record<OwnerLabel, string> = { "User 1": "Pavel", "User 2": "Raisa" };

export function memberDisplayName(label: OwnerLabel | string): string {
  return DISPLAY[label as OwnerLabel] ?? label;
}
