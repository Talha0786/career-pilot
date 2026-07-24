import { z } from 'zod';

export const ConnectorHealthSchema = z.enum(['healthy', 'degraded', 'disabled']);

/**
 * Deliberately has NO `credentialsRef` field (task 032 acceptance:
 * "PATCH /connectors/:id for BYO-key config never returns the stored key
 * value in any response body"). It's write-only — accepted on the PATCH
 * request, never echoed back on any response, GET or PATCH.
 */
export const ConnectorConfigDtoSchema = z.object({
  id: z.string().uuid(),
  connectorKey: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  scheduleCron: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  health: ConnectorHealthSchema,
  consecutiveFailures: z.number().int(),
  lastSuccessAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConnectorConfigDto = z.infer<typeof ConnectorConfigDtoSchema>;

export const ListConnectorsResponseSchema = z.object({ items: z.array(ConnectorConfigDtoSchema) });
export type ListConnectorsResponse = z.infer<typeof ListConnectorsResponseSchema>;

export const UpdateConnectorConfigRequestSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  scheduleCron: z.string().min(1).max(100).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Write-only — a reference into the secrets store, never the raw key (security model §4). */
  credentialsRef: z.string().min(1).max(500).nullable().optional(),
});
export type UpdateConnectorConfigRequest = z.infer<typeof UpdateConnectorConfigRequestSchema>;
