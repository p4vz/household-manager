"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { MAX_STATE, checkAuthorizeRequest, clientRedirect } from "@/core/oauth/authorize";
import { oauthConfig } from "@/core/oauth/policy";
import { createAuthorizationCode } from "@/core/oauth/server";

const Input = z.object({
  decision: z.enum(["approve", "deny"]),
  client_id: z.string().max(200),
  redirect_uri: z.string().max(2048),
  code_challenge: z.string().max(200),
  code_challenge_method: z.string().max(10),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2048).optional(),
  state: z.string().max(MAX_STATE).optional(),
  response_type: z.string().max(20),
  perm: z.array(z.string().max(60)).max(50),
});

/**
 * The only place access is ever granted. Every field round-tripped through
 * the browser, so the whole request is validated again here.
 */
const decide = authedAction(Input, async ({ decision, perm, ...params }, user) => {
  const config = oauthConfig();
  if (!config) throw new Error("Assistant access is turned off");
  const check = await checkAuthorizeRequest(params, config);
  if (check.kind === "fatal") throw new Error(check.message);
  if (check.kind === "redirect") return check.url;
  const r = check.request;
  if (decision === "deny") return clientRedirect(r.redirectUri, { error: "access_denied", state: r.state }, config);
  const code = await createAuthorizationCode({ ...r, permissions: perm }, user.email);
  return clientRedirect(r.redirectUri, { code, state: r.state }, config);
});

export async function decideAuthorization(form: FormData) {
  const raw = Object.fromEntries([...form.entries()].filter(([k, v]) => k !== "perm" && typeof v === "string"));
  redirect(await decide({ ...raw, perm: form.getAll("perm").filter((v) => typeof v === "string") }));
}
