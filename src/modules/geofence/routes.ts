import { Router, type Request } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../lib/errors';
import { toJsonSafe } from '../../lib/misc';
import { check, getConfig, CLAIM_TTL_MS } from '../../services/geofence';

/**
 * Clinic location check (D-062), for every signed-in user — reachable even without an on-site claim. The person
 * checked is whoever holds the session (the developer's own account while viewing as someone).
 */
export const geofenceRouter = Router();

const RECHECK_MS = 10 * 60_000;
const holder = (req: Request) => ({ userId: req.user!.impersonator?.id ?? req.user!.id, sessionId: req.user!.sessionId, ip: req.ip });

/** Does this person need to prove they are at the clinic, and until when is the current claim good? */
geofenceRouter.get('/status', async (req, res) => {
  const cfg = await getConfig();
  const required = cfg.enabled && req.user!.geo.required;
  const claimUntil = req.user!.geo.claimUntil && req.user!.geo.claimUntil > new Date() ? req.user!.geo.claimUntil : null;
  res.json(toJsonSafe({ required, claimUntil, recheckMs: RECHECK_MS, claimTtlMs: CLAIM_TTL_MS }));
});

const checkBody = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(1_000_000).optional(),
  error: z.string().max(40).optional(),
});

/** Post the browser's location (or the reason there is none); on site → a 15-minute claim on this session. */
geofenceRouter.post('/check', async (req, res) => {
  const r = checkBody.safeParse(req.body);
  if (!r.success) throw new ValidationError('Location data sahi nahi.', r.error.flatten());
  if ((r.data.latitude === undefined) !== (r.data.longitude === undefined)) throw new ValidationError('Latitude aur longitude dono bhejein.');
  res.json(toJsonSafe(await check(req.actor!, holder(req), r.data)));
});
