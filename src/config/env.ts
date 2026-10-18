import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  APP_TIMEZONE: z.string().default('Asia/Karachi'),
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  PASSWORD_RESET_TTL_MIN: z.coerce.number().int().positive().default(30),
  UPLOADTHING_TOKEN: z.string().optional(),
  /**
   * true  → clinical files upload with ACL "private" and are served via short-lived signed URLs (requires a paid
   *         UploadThing plan). REQUIRED before going live with real patients.
   * false → (free plan) clinical files upload with the app's default (public) ACL; the URL is never stored or sent
   *         to the browser — bytes are streamed through the role-checked /api/files/:id/content proxy (D-030).
   */
  UPLOADTHING_PRIVATE_FILES: z.enum(['true', 'false']).default('false'),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(300),
  WHATSAPP_PROVIDER: z.string().default('console'),
  WHATSAPP_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Google service account key (the whole JSON key file, on one line, or base64 of it) for the Meta lead-sheet sync.
   * Server-side only: never returned by any API — the admin screen sees just the service account email (D-039).
   */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  WORKER_ID: z.string().default(`worker-${process.pid}`),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = {
  ...parsed.data,
  privateFiles: parsed.data.UPLOADTHING_PRIVATE_FILES === 'true',
  cookieSecure:
    parsed.data.COOKIE_SECURE === undefined
      ? parsed.data.NODE_ENV === 'production'
      : parsed.data.COOKIE_SECURE === 'true',
};
export type Env = typeof env;
