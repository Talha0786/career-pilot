/**
 * Rendered-artifact storage (task 024). No object-storage service exists in
 * the compose stack yet (checked docker-compose.yml — no MinIO/S3) — per
 * the task's own guidance ("local volume + signed API route if none exists
 * yet"), the M3 implementation is a local-filesystem adapter behind this
 * port, served through an auth-gated download route rather than a
 * cryptographically pre-signed URL (no S3-compatible presign capability to
 * generate one from). Swapping to real object storage later means adding
 * one new adapter, not touching any use case.
 */
export interface ObjectStoragePort {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}
