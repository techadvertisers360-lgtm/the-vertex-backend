/** Errors carry a stable `code` for the frontend and a user-facing message (spec §24 Roman Urdu kept verbatim). */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Session expire ho gaya. Dobara sign in karein.', code = 'UNAUTHENTICATED') {
    super(401, code, message);
  }
}

export interface DenialContext {
  recordType: string;
  recordId?: string;
  rule: string;
}

/** 403. The error handler writes an AUTHZ_DENIED audit event using `denial`. */
export class ForbiddenError extends AppError {
  constructor(
    public readonly denial: DenialContext,
    message = 'Aap ko is record ki ijazat nahi hai.',
  ) {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Record') {
    super(404, 'NOT_FOUND', `${what} nahi mila.`);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

/** A business lock (spec §4) prevented the action. */
export class LockedError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(423, code, message, details);
  }
}
