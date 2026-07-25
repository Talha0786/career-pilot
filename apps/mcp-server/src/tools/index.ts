import type { McpRegistry } from '../registry.js';
import type { McpDeps } from '../di.js';
import { pingTool } from './ping.js';
import { makeSearchJobsTool } from './search-jobs.js';
import { makeGetJobTool } from './get-job.js';
import { makeGetProfileTool } from './get-profile.js';
import { makeMatchJobTool } from './match-job.js';
import { makeListApplicationsTool } from './list-applications.js';
import { makeGetPipelineAnalyticsTool } from './get-pipeline-analytics.js';
import { makeUpdateApplicationStageTool } from './update-application-stage.js';
import { makeAddApplicationNoteTool } from './add-application-note.js';
import { makeTailorDocumentTool } from './tailor-document.js';
import { makeGetGenerationStatusTool } from './get-generation-status.js';
import { makePrepareApplicationTool } from './prepare-application.js';
import { makeGenerateInterviewPrepTool } from './generate-interview-prep.js';

/**
 * Single place the full tool catalog is assembled. Task 058's
 * registry-catalog test asserts this list's `name`s exactly match
 * `docs/04-mcp-design.md` §3 — a positive proof that no destructive tool
 * (`submit_application`, `delete_*`, `set_credentials`, `enable_connector`)
 * has ever been wired in, alongside `ping` (transport plumbing, not part
 * of §3's catalog).
 */
export function registerAllTools(registry: McpRegistry, deps: McpDeps): void {
  registry.registerTool(pingTool);
  registry.registerTool(makeSearchJobsTool(deps));
  registry.registerTool(makeGetJobTool(deps));
  registry.registerTool(makeGetProfileTool(deps));
  registry.registerTool(makeMatchJobTool(deps));
  registry.registerTool(makeListApplicationsTool(deps));
  registry.registerTool(makeGetPipelineAnalyticsTool(deps));
  registry.registerTool(makeUpdateApplicationStageTool(deps));
  registry.registerTool(makeAddApplicationNoteTool(deps));
  registry.registerTool(makeTailorDocumentTool(deps));
  registry.registerTool(makeGetGenerationStatusTool(deps));
  registry.registerTool(makePrepareApplicationTool(deps));
  registry.registerTool(makeGenerateInterviewPrepTool(deps));
}

/** The exact §3 catalog names (excludes `ping`) — reused by task 058's registry-catalog test. */
export const DOCUMENTED_TOOL_CATALOG = [
  'search_jobs',
  'get_job',
  'get_profile',
  'match_job',
  'list_applications',
  'update_application_stage',
  'add_application_note',
  'tailor_document',
  'get_generation_status',
  'prepare_application',
  'generate_interview_prep',
  'get_pipeline_analytics',
] as const;
