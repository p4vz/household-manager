import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpCaller } from "@/core/oauth/server";
import { forAssistant } from "./sanitize";
import { TOOLS, serverInstructions } from "./tools";

/**
 * Handles one MCP request, statelessly: a fresh server per request, JSON
 * responses, no sessions to hijack. The caller was already resolved from
 * its bearer token by the route; tools never read identity from arguments.
 */
export async function handleMcpRequest(req: Request, caller: McpCaller): Promise<Response> {
  const server = new McpServer(
    { name: "household-manager", version: "1.0.0" },
    { instructions: serverInstructions(caller.owner), capabilities: { tools: {} } },
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = forAssistant(await tool.run(args ?? {}, { owner: caller.owner, now: new Date() }), tool.scrub);
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
