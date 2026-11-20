/** Runs once when the Node server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail fast in production if a required secret is missing or malformed.
    if (process.env.NODE_ENV === "production") {
      const { env } = await import("./core/env");
      env();
    }
    const { registerModules } = await import("./modules/registry");
    registerModules();
  }
}
