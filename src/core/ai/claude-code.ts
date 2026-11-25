import "server-only";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { KeyTestResult } from "./keys";

/**
 * Claude on the household's subscription, the way Agents UI does it: the
 * token from `claude setup-token` signs in Claude Code, which the Claude
 * Agent SDK runs as a child process. Calls count against the plan's usage
 * limits instead of being billed per token.
 *
 * Locked down for this app:
 * - None of Claude Code's own tools (files, shell, web), except WebSearch
 *   for the card-catalog research step. The in-app assistant adds its
 *   household tools as an in-process SDK MCP server (never HTTP), allowed
 *   by exact name. No settings files, no saved sessions, an empty working
 *   directory.
 * - The child gets a minimal environment: the token and what it needs to
 *   run. DATABASE_URL, AUTH_SECRET and every other secret stay out.
 * - Non-essential traffic (telemetry, update checks) is off, so the child
 *   only talks to api.anthropic.com, the host already on the allowlist.
 * - The token is never logged; error text is cut short and scrubbed.
 */

const PASS_THROUGH = ["PATH", "LANG", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

function sandboxDir(): string {
  const home = join(tmpdir(), "household-claude");
  const work = join(home, "work");
  if (!existsSync(work)) mkdirSync(work, { recursive: true, mode: 0o700 });
  // Claude Code's first-run onboarding can block headless use of the token.
  const cfg = join(home, ".claude.json");
  if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  return home;
}

export function childEnv(token: string, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "household-manager",
  };
}

export class ClaudeCodeError extends Error {}

function scrub(text: string, token: string): string {
  return text.split(token).join("[token]").replace(/sk-ant-[A-Za-z0-9_-]+/g, "[token]").slice(0, 300);
}

type RunOpts = {
  token: string;
  model: string;
  system: string;
  prompt: string;
  /** JSON Schema for structured output; the parsed object comes back as `output`. */
  jsonSchema?: Record<string, unknown>;
  webSearch?: boolean;
  /**
   * In-process tools (the in-app assistant): an SDK MCP server that runs
   * inside this Node process, never over HTTP. Only the listed tool names
   * are allowed; Claude Code's own tools (files, shell, web) stay off.
   */
  inProcessTools?: { server: McpSdkServerConfigWithInstance; name: string; allow: string[] };
  maxTurns?: number;
  timeoutMs?: number;
};

export async function runClaudeCode(opts: RunOpts): Promise<{ text: string; output: unknown }> {
  const home = sandboxDir();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  let text = "";
  let output: unknown = undefined;
  let error = "";
  try {
    for await (const msg of query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        systemPrompt: opts.system,
        cwd: join(home, "work"),
        env: childEnv(opts.token, home),
        tools: opts.webSearch ? ["WebSearch"] : [],
        allowedTools: [
          ...(opts.webSearch ? ["WebSearch"] : []),
          ...(opts.inProcessTools?.allow.map((t) => `mcp__${opts.inProcessTools!.name}__${t}`) ?? []),
        ],
        ...(opts.inProcessTools ? { mcpServers: { [opts.inProcessTools.name]: opts.inProcessTools.server }, strictMcpConfig: true } : {}),
        settingSources: [],
        persistSession: false,
        permissionMode: "dontAsk",
        maxTurns: opts.maxTurns ?? (opts.webSearch ? 8 : 3),
        abortController: controller,
        ...(opts.jsonSchema ? { outputFormat: { type: "json_schema" as const, schema: opts.jsonSchema } } : {}),
      },
    })) {
      if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error) {
          text = msg.result;
          output = msg.structured_output;
        } else {
          error = "errors" in msg && Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join("; ") : msg.subtype;
          if (msg.subtype === "success") error = msg.result || "error";
        }
      }
    }
  } catch (e) {
    error = controller.signal.aborted ? "timed out" : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  if (error) throw new ClaudeCodeError(`Claude (subscription) failed: ${scrub(error, opts.token)}`);
  if (opts.jsonSchema && output === undefined) throw new ClaudeCodeError("Claude (subscription) returned no structured output");
  return { text, output };
}

/** Structured call: Zod schema in, parsed object out. */
export async function runClaudeCodeStructured<S extends z.ZodType>(opts: Omit<RunOpts, "jsonSchema"> & { schema: S }): Promise<z.infer<S>> {
  const { schema, ...rest } = opts;
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
  const { output } = await runClaudeCode({ ...rest, jsonSchema });
  return schema.parse(output);
}

/**
 * One tiny call on the fast model to prove the token signs in. Uses a sliver
 * of plan usage; sends no household data.
 */
export async function testSubscriptionToken(token: string): Promise<KeyTestResult> {
  try {
    const { text } = await runClaudeCode({
      token,
      model: "haiku",
      system: "Reply with exactly: OK",
      prompt: "Reply with exactly: OK",
      maxTurns: 1,
      timeoutMs: 60_000,
    });
    return text.trim().length > 0
      ? { ok: true, message: "Token works. Claude calls will use your subscription." }
      : { ok: false, message: "Claude answered with nothing. Try again." };
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (/auth|401|403|invalid|expired|log ?in/i.test(m)) {
      return { ok: false, rejected: true, message: "Claude rejected this token. Run claude setup-token again and paste the new one." };
    }
    if (/limit|429|usage/i.test(m)) return { ok: true, message: "Token signs in, but your plan's usage limit is reached right now." };
    return { ok: false, message: "Couldn't run Claude with this token. Try again in a minute." };
  }
}
