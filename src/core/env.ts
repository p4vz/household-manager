import "server-only";
import { z } from "zod";

/**
 * Server-only environment. Importing this file from a Client Component is a
 * build error (`server-only`), which is how secrets are kept out of the
 * browser bundle. Nothing here may use the public (client-exposed) env prefix.
 */
const emailList = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.email()).min(1).max(2));

const schema = z.object({
  ALLOWED_EMAILS: emailList,
  AUTH_SECRET: z.string().min(32),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  CRON_SECRET: z.string().min(32),
  SIMPLEFIN_ACCESS_URL: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  HOUSEHOLD_LEGAL_NAMES: z.string().optional().default(""),
  HOUSEHOLD_TIMEZONE: z.string().optional().default("America/New_York"),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

/** Parsed lazily so `next build` works without production secrets present. */
export function env(): ServerEnv {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid server environment: ${fields}`);
    }
    cached = parsed.data;
  }
  return cached;
}
