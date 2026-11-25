import "server-only";

/** The documents vault key and cipher now live in core (finance card pictures use them too). */
export { vaultConfigured, sealBytes, openBytes, type Sealed } from "@/core/secrets/file-vault";
