import { z } from "zod";

/**
 * Application configuration loaded and validated from environment variables
 * (TECH_STACK "Environment Variables"). All boundaries are Zod-validated.
 *
 * DATA_ENCRYPTION_KEY is optional only when NODE_ENV === "test"; otherwise the
 * process must fail to start without it (SPEC "Security Requirements").
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  baseUrl: string;
  clockifyAddonPublicKeyPem: string;
  clockifyAddonKey: string;
  sessionSecret: string;
  dataEncryptionKey?: string;
  databasePath: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

const envSchema = z.object({
  NODE_ENV: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive(),
  BASE_URL: z.string().min(1),
  CLOCKIFY_ADDON_PUBLIC_KEY_PEM: z.string().min(1),
  CLOCKIFY_ADDON_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  DATA_ENCRYPTION_KEY: z.string().min(1).optional(),
  DATABASE_PATH: z.string().min(1),
  LLM_BASE_URL: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const nodeEnv = parsed.NODE_ENV ?? "development";

  if (nodeEnv !== "test" && !parsed.DATA_ENCRYPTION_KEY) {
    throw new Error(
      "DATA_ENCRYPTION_KEY is required outside NODE_ENV=test (installation tokens must not be stored in plaintext).",
    );
  }

  return {
    nodeEnv,
    port: parsed.PORT,
    baseUrl: parsed.BASE_URL,
    clockifyAddonPublicKeyPem: parsed.CLOCKIFY_ADDON_PUBLIC_KEY_PEM,
    clockifyAddonKey: parsed.CLOCKIFY_ADDON_KEY,
    sessionSecret: parsed.SESSION_SECRET,
    dataEncryptionKey: parsed.DATA_ENCRYPTION_KEY,
    databasePath: parsed.DATABASE_PATH,
    llmBaseUrl: parsed.LLM_BASE_URL,
    llmApiKey: parsed.LLM_API_KEY,
    llmModel: parsed.LLM_MODEL,
  };
}
