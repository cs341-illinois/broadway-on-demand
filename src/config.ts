// src/config.ts
import dotenv from "dotenv";
import { z } from "zod";

// Load env vars from .env file
dotenv.config();
function makeid(length: number) {
  var result = "";
  var characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
// Define schema
const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  AZURE_CLIENT_ID: z.string().min(1, "AZURE_CLIENT_ID is required"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  AZURE_CLIENT_SECRET: z.string().min(1, "AZURE_CLIENT_SECRET is required"),
  AZURE_TENANT_ID: z.string().min(1, "AZURE_TENANT_ID is required"),
  BASE_URL: z.optional(z.string()).default("/on-demand"),
  HOST: z.string().min(1),
  JENKINS_FACING_URL: z.optional(z.string().url()),
  COOKIE_SECRET: z.string().min(32).default(makeid(32)),
  PORT: z.coerce.number().min(1024).default(3000),
  GRADER_TOKEN: z.string().min(32),
  REDIS_URL: z.string().url().min(1, "REDIS_URL is required."),
});

// Validate and parse
const config = configSchema.parse(process.env);

export default config;
