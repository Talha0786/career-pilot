/**
 * `audit_log` (database design §2, security model §6): "auth events,
 * credential changes, job creation." Document version creation is an
 * adjacent auditable event (task 022 acceptance: "Written for: ... exports")
 * — a durable record of what content a user committed to a document and
 * when, independent of the append-only `document_versions` row itself.
 */
export interface AuditRecord {
  readonly userId: string;
  readonly action: string;
  readonly subjectType?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly detail?: Record<string, unknown> | undefined;
}

export interface AuditPort {
  record(entry: AuditRecord): Promise<void>;
}
