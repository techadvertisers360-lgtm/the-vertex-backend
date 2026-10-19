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
  /**
   * Live updates transport (D-042). `socketio` = local API process with Socket.IO (default).
   * `supabase` = Vercel/serverless: events go to Supabase Realtime Broadcast on private per-user channels.
   */
  REALTIME_PROVIDER: z.enum(['socketio', 'supabase']).default('socketio'),
  SUPABASE_URL: z.string().url().optional(),
  /** Supabase secret key (sb_secret_…) or legacy service_role key — server-only, used to broadcast. */
  SUPABASE_SECRET_KEY: z.string().optional(),
  /** Supabase JWT secret (legacy HS256) used to sign the short-lived per-user Realtime token. */
  SUPABASE_JWT_SECRET: z.string().optional(),
  REALTIME_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(300),
  /** Secret for GET/POST /api/cron/tick (external scheduler such as cron-job.org). Unset = endpoint disabled. */
  CRON_SECRET: z.string().min(24, 'CRON_SECRET must be at least 24 chars').optional(),
  /** Aiven (or other) CA certificate as PEM text or base64 — written to a temp file for Prisma's sslcert. */
  DATABASE_CA_CERT: z.string().optional(),
  /** Express "trust proxy" (hops or true). Behind Vercel use "true". */
  TRUST_PROXY: z.string().default('1'),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema
  .superRefine((e, ctx) => {
    if (e.REALTIME_PROVIDER === 'supabase') {
      for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_JWT_SECRET'] as const) {
        if (!e[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required when REALTIME_PROVIDER=supabase` });
      }
    }
  })
  .safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = {
  ...parsed.data,
  privateFiles: parsed.data.UPLOADTHING_PRIVATE_FILES === 'true',
  trustProxy: parsed.data.TRUST_PROXY === 'true' ? true : parsed.data.TRUST_PROXY === 'false' ? false : Number(parsed.data.TRUST_PROXY) || 1,
  cookieSecure:
    parsed.data.COOKIE_SECURE === undefined
      ? parsed.data.NODE_ENV === 'production'
      : parsed.data.COOKIE_SECURE === 'true',
};
export type Env = typeof env;
