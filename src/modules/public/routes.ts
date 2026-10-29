import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { formatClinic } from '../../lib/time';
import { audit } from '../../services/audit';

/**
 * Patient-facing, unauthenticated endpoints (spec §1 "Patient-facing view"): only the patient's own feedback
 * form via an unguessable token. Returns no internal staff data, phone numbers or clinical information.
 */
export const publicRouter = Router();

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: env.NODE_ENV === 'test' ? 1000 : 60, standardHeaders: 'draft-7', legacyHeaders: false });
publicRouter.use(limiter);

const tokenParam = z.object({ token: z.string().min(16).max(64) });

async function findByToken(req: Request) {
  const p = tokenParam.safeParse(req.params);
  if (!p.success) throw new NotFoundError('Feedback link');
  const f = await prisma.feedback.findUnique({ where: { token: p.data.token } });
  if (!f) throw new NotFoundError('Feedback link');
  return f;
}

publicRouter.get('/feedback/:token', async (req, res) => {
  const f = await findByToken(req);
  const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: f.appointmentId }, select: { startAt: true, doctorId: true, patient: { select: { name: true } } } });
  const doctor = appt.doctorId ? await prisma.user.findUnique({ where: { id: appt.doctorId }, select: { displayName: true } }) : null;
  res.json({
    clinic: 'The Vertex Health',
    patientFirstName: appt.patient.name.split(' ')[0],
    visitDate: formatClinic(appt.startAt, 'dd LLL yyyy'),
    doctorName: doctor?.displayName ?? null,
    alreadySubmitted: !!f.submittedAt,
  });
});

const body = z.object({
  doctorRating: z.number().int().min(1).max(5),
  staffRating: z.number().int().min(1).max(5),
  clinicRating: z.number().int().min(1).max(5),
  suggestion: z.string().max(2000).optional(),
});

publicRouter.post('/feedback/:token', async (req, res) => {
  const f = await findByToken(req);
  const parsed = body.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Har sawal ki rating dein (1–5).', parsed.error.flatten());
  const { count } = await prisma.feedback.updateMany({ where: { id: f.id, submittedAt: null }, data: { ...parsed.data, suggestion: parsed.data.suggestion ?? null, skipped: false, submittedAt: new Date() } });
  if (!count) throw new ConflictError('FEEDBACK_DONE', 'Aap ka feedback pehle hi mil chuka hai. Shukriya!');
  await audit(prisma, { id: null, role: null, displayName: 'Patient (feedback link)' }, { action: 'FEEDBACK_SUBMITTED', recordType: 'Appointment', recordId: f.appointmentId });
  res.json({ ok: true, message: 'Shukriya! Aap ka feedback mil gaya.' });
});
