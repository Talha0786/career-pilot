import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStoragePort } from '@careerpilot/application';

/**
 * `ObjectStoragePort` over the local filesystem — the M3 implementation
 * `object-storage.port.ts`'s docstring describes (no MinIO/S3 in the
 * compose stack yet). `key` (e.g. `documents/{docId}/{versionId}.pdf`) maps
 * directly onto a path under `baseDir`; keys are validated to reject path
 * traversal (`..`) since they ultimately come from a `documentId`/
 * `versionId` pair the API layer controls, but defense in depth costs one
 * check.
 */
export class LocalFileObjectStorage implements ObjectStoragePort {
  constructor(private readonly baseDir: string) {}

  async put(key: string, bytes: Buffer): Promise<void> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private resolve(key: string): string {
    const normalized = path.normalize(key);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw new Error(`Invalid object storage key: ${key}`);
    }
    return path.join(this.baseDir, normalized);
  }
}
