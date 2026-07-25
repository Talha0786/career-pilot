import { asApplicationId, notFound, uuidv7, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { ApplicationRepository, ApplicationNoteRepository, Actor } from '../../ports/repositories.js';

export interface AddApplicationNoteInput {
  applicationId: string;
  noteMd: string;
  /** Defaults to 'user' — the MCP tool (task 058) passes 'agent' since a token-authenticated MCP call is a non-human actor, same posture as `update_application_stage`. */
  actor?: 'user' | 'system' | 'agent' | undefined;
}
export interface AddApplicationNoteOutput {
  noteId: string;
  createdAt: string;
}

export function makeAddApplicationNoteUseCase(deps: {
  applications: ApplicationRepository;
  notes: ApplicationNoteRepository;
}) {
  return async function addApplicationNote(
    actor: Actor,
    input: AddApplicationNoteInput,
  ): Promise<Result<AddApplicationNoteOutput, DomainError>> {
    const applicationId = asApplicationId(input.applicationId);
    const app = await deps.applications.findByIdForUser(applicationId, actor.userId);
    if (app === null) return err(notFound('Application not found'));

    const id = uuidv7();
    await deps.notes.add({
      id,
      applicationId: input.applicationId,
      noteMd: input.noteMd,
      actor: input.actor ?? 'user',
    });

    return ok({ noteId: id, createdAt: new Date().toISOString() });
  };
}
