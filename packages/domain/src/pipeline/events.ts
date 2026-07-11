export const PIPELINE_EVENTS = {
  APPLICATION_CREATED: 'pipeline.application_created',
  STAGE_CHANGED: 'pipeline.stage_changed',
} as const;

export type PipelineEventType =
  (typeof PIPELINE_EVENTS)[keyof typeof PIPELINE_EVENTS];
