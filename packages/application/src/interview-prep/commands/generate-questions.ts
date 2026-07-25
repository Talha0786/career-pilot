import { z } from 'zod';
import {
  asUserId, asApplicationId, asJobPostingId, compileFactList, uuidv7,
  notFound, validationFailed, type Result, ok, err, type DomainError,
} from '@careerpilot/domain';
import type { ApplicationRepository, JobPostingRepository, ProfileRepository, Actor } from '../../ports/repositories.js';
import type { InterviewPrepRepository } from '../../ports/interview-prep.port.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';

const QuestionValidator = z.object({
  question: z.string().min(1).max(1000),
  category: z.enum(['behavioral', 'technical', 'role_specific', 'company_culture']),
  rationale: z.string().max(1000).optional(),
});
const QuestionSetValidator = z.object({ questions: z.array(QuestionValidator).min(1).max(20) });
export type GeneratedQuestionSet = z.infer<typeof QuestionSetValidator>;

export interface GenerateQuestionsInput {
  applicationId: string;
}
export interface GenerateQuestionsOutput {
  interviewPrepId: string;
  questions: GeneratedQuestionSet['questions'];
}

/**
 * Task 060 — `docs/06-agent-design.md` §3 "Interview Q&A generation |
 * pipeline | mid | QuestionSet schema". A deterministic pipeline (JD +
 * compiled profile facts -> guarded LLM call -> validate -> one repair
 * attempt -> typed failure), the exact same ADR-006 shape every other
 * M5 pipeline call site (038/039/040) already uses -- reusing
 * `compileFactList` (task 037) rather than re-deriving facts from the
 * profile.
 */
export function makeGenerateQuestionsUseCase(deps: {
  applications: ApplicationRepository;
  jobPostings: JobPostingRepository;
  profiles: ProfileRepository;
  interviewPreps: InterviewPrepRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
}) {
  return async function generateQuestions(
    actor: Actor,
    input: GenerateQuestionsInput,
  ): Promise<Result<GenerateQuestionsOutput, DomainError>> {
    const userId = asUserId(actor.userId);
    const applicationId = asApplicationId(input.applicationId);

    const app = await deps.applications.findByIdForUser(applicationId, userId);
    if (app === null) return err(notFound('Application not found'));

    const job = await deps.jobPostings.findByIdForUser(asJobPostingId(app.jobPostingId), userId);
    if (job === null) return err(notFound('Job posting not found'));

    const profile = await deps.profiles.findActiveForUser(userId);
    if (profile === null) return err(notFound('No career profile exists yet'));

    const promptResult = await deps.prompts.load('interview-questions');
    if (!promptResult.ok) return err(validationFailed(`Could not load interview-questions prompt: ${promptResult.error.message}`));
    const prompt = promptResult.value;

    const facts = compileFactList(profile);
    const factsText = facts.length > 0 ? facts.map((f) => `${f.id}: ${f.text}`).join('\n') : '(no profile facts yet)';

    const vars = {
      profile_facts: factsText,
      job_title: job.title,
      job_company: job.company ?? 'Unknown',
      job_description: job.descriptionMd,
    };
    const basePrompt = prompt.render(vars);

    const attempt = async (promptText: string): Promise<Result<GeneratedQuestionSet, DomainError>> => {
      const completion = await deps.llm.complete(
        { model: deps.model, prompt: promptText, jsonSchema: { type: 'object' }, temperature: prompt.frontmatter.temperature },
        { userId: actor.userId, refId: input.applicationId, context: 'interview' },
      );
      if (!completion.ok) return err(validationFailed(`LLM call failed: ${completion.error.message}`));

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractJsonObject(completion.value.text));
      } catch {
        return err(validationFailed('LLM response was not valid JSON'));
      }
      const validated = QuestionSetValidator.safeParse(parsedJson);
      if (!validated.success) {
        return err(validationFailed(`LLM response did not match QuestionSetSchema: ${validated.error.issues.map((i) => i.message).join('; ')}`));
      }
      return ok(validated.data);
    };

    let result = await attempt(basePrompt);
    if (!result.ok) {
      const repairPrompt = `${basePrompt}\n\nYour previous response did not match the required JSON schema. Return ONLY the corrected JSON object, no other text.`;
      result = await attempt(repairPrompt);
    }
    if (!result.ok) return result;

    const id = uuidv7();
    await deps.interviewPreps.save({ id, applicationId: input.applicationId, kind: 'questions', content: result.value });

    return ok({ interviewPrepId: id, questions: result.value.questions });
  };
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}
