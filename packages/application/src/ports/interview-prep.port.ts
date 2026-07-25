/**
 * M7 (task 060, extended by 061). Backs the `interview_preps` table —
 * one repository for three related content kinds, discriminated by
 * `kind`. `save` is an upsert keyed by `id`: `generate-questions.ts` and
 * `research-company.ts` (060) each create one row per invocation;
 * `run-mock-interview-turn.ts` (061) repeatedly upserts the SAME row
 * (one id per session) as the transcript grows turn by turn, so the
 * transcript-so-far is durable even if the session ends early (budget
 * exhaustion, turn cap) rather than only being persisted once at the end.
 */
export type InterviewPrepKind = 'questions' | 'company_research' | 'mock_interview_transcript';

export interface InterviewPrepRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly kind: InterviewPrepKind;
  readonly content: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InterviewPrepRepository {
  save(record: { id: string; applicationId: string; kind: InterviewPrepKind; content: unknown }): Promise<InterviewPrepRecord>;
  findById(id: string): Promise<InterviewPrepRecord | null>;
  listForApplication(applicationId: string, kind?: InterviewPrepKind): Promise<InterviewPrepRecord[]>;
}
