import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpCaller } from "@/core/oauth/server";
import { legalNamesFromEnv } from "@/core/ai/sanitize";
import { oauthConfig } from "@/core/oauth/policy";
import { connectorToolList, runConnectorTool } from "@/assistant/connector";
import * as family from "@/modules/family/api";
import * as trips from "@/modules/trips/api";
import { forAssistant } from "./sanitize";
import { serverInstructions, toolsFor, type AssistantTool } from "./tools";

/**
 * Names that are scrubbed from every answer: the household's legal names
 * plus everyone in the travellers list (children included), so a name typed
 * into a trip note or a card nickname never leaves the server.
 */
async function namesToScrub(): Promise<string[]> {
  const [travellers, kids] = await Promise.all([trips.listTravelers().catch(() => []), family.listKids().catch(() => [])]);
  // Kids' first names, as on the chore board, may pass (the "Make changes"
  // tools manage kids by first name); the rest of a traveller's name is still removed.
  const kidNames = new Set(kids.map((k) => k.name.trim().toLowerCase()));
  const travellerParts = travellers.flatMap((t) => {
    const parts = t.name.trim().split(/\s+/);
    return parts.some((p) => kidNames.has(p.toLowerCase())) ? parts.filter((p) => !kidNames.has(p.toLowerCase())) : [t.name];
  });
  return [...legalNamesFromEnv(), ...travellerParts].filter((n) => n.trim().length >= 2);
}

/** Ask Claude's tools for connections given a "Make changes" permission (src/assistant/connector.ts). */
function connectorTools(permissions: ReadonlySet<string>, caller: McpCaller): AssistantTool[] {
  return connectorToolList()
    .filter(({ requires }) => requires.every((p) => permissions.has(p)))
    .map(({ tool, requires }) => ({
      name: tool.name,
      title: tool.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      description: tool.description,
      input: tool.input,
      requires,
      scrub: tool.scrub,
      writes: tool.kind === "edit",
      run: (args) => runConnectorTool(tool, args, { grantId: caller.grantId, email: caller.email, owner: caller.owner }),
    }));
}

/**
 * Handles one MCP request, statelessly: a fresh server per request, JSON
 * responses, no sessions to hijack. The caller was already resolved from
 * its bearer token by the route; tools never read identity from arguments.
 */
export async function handleMcpRequest(req: Request, caller: McpCaller): Promise<Response> {
  const permissions = new Set(caller.permissions);
  const appUrl = oauthConfig()?.issuer ?? null;
  // Only tools whose permissions were all granted are even advertised.
  const tools = [...toolsFor(permissions), ...connectorTools(permissions, caller)];
  const server = new McpServer(
    { name: "household-manager", version: "1.0.0" },
    { instructions: serverInstructions(caller.owner, tools), capabilities: { tools: {} } },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.writes
          ? { title: tool.title, readOnlyHint: false, destructiveHint: "action" in tool.input, idempotentHint: false, openWorldHint: false }
          : { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const raw = await tool.run(args ?? {}, { owner: caller.owner, now: new Date(), permissions, appUrl });
          const result = forAssistant(raw, tool.scrub, await namesToScrub());
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 1) }] };
        } catch (err) {
          const message = err instanceof Error && err.message.length < 200 ? err.message : "Tool failed";
          console.error(`[mcp] ${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
          return { content: [{ type: "text" as const, text: String(forAssistant(message, "reference")) }], isError: true };
        }
      },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 256 * 1024,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, {
      authInfo: { token: "redacted", clientId: caller.clientId, scopes: caller.scopes, expiresAt: caller.expiresAt },
    });
  } finally {
    // Stateless: nothing outlives the request.
    void server.close().catch(() => undefined);
  }
}
