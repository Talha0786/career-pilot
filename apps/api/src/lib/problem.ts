import type { FastifyReply } from 'fastify';
import type { DomainError, DomainErrorCode } from '@careerpilot/domain';
import type { Problem } from '@careerpilot/contracts';

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  invalid_credentials: 401,
  invalid_transition: 409,
  budget_exceeded: 402,
};

/** Every error response on this API is application/problem+json — no exceptions. */
export async function sendProblem(reply: FastifyReply, status: number, problem: Problem): Promise<void> {
  await reply.code(status).type('application/problem+json').send(problem);
}

export async function sendDomainError(reply: FastifyReply, error: DomainError): Promise<void> {
  await sendProblem(reply, STATUS_BY_CODE[error.code], {
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}
