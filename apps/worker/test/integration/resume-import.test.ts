import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import pino from 'pino';
import PDFKitDocument from 'pdfkit';
import { DocumentTextExtractor, RedisDraftStore } from '@careerpilot/infrastructure';
import { RESUME_IMPORT_QUEUE, type ResumeImportDraftRecord } from '@careerpilot/application';
import { createParseResumeWorker } from '../../src/handlers/parse-resume.handler.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';
const PDF_MIME = 'application/pdf';

function makePdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFKitDocument({ size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.text(text);
    doc.end();
  });
}

/**
 * The REAL pipeline end to end: enqueue a job the same way `import-resume`'s
 * use case does, let the ACTUAL `createParseResumeWorker` (same code
 * `apps/worker/src/main.ts` runs in production) consume it against a real
 * Redis, and assert the draft it writes is correct — not a use-case-level
 * fake, and not the API test's manually-seeded draft (which only proves the
 * confirm route reads Redis correctly, not that parsing actually happens).
 */
describe('Resume import — REAL worker consuming a REAL generated PDF (task 023)', () => {
  let redis: IORedis;
  let queueConnection: IORedis;

  beforeEach(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
    queueConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterEach(async () => {
    await redis.quit();
    await queueConnection.quit();
  });

  it('parses a real PDF end to end: enqueue -> worker -> extractor -> field mapper -> Redis draft', async () => {
    const pdfBytes = await makePdf('Ada Lovelace\nada@example.com\n\nSummary\nComputing pioneer.');
    const draftStore = new RedisDraftStore(redis);
    const worker = createParseResumeWorker({
      connection: redis,
      extractor: new DocumentTextExtractor(),
      drafts: draftStore,
      logger: pino({ level: 'silent' }),
    });

    const queue = new Queue(RESUME_IMPORT_QUEUE, { connection: queueConnection });
    const draftId = 'e2e-test-draft-1';

    try {
      await queue.add(RESUME_IMPORT_QUEUE, {
        draftId,
        userId: 'e2e-user',
        filename: 'resume.pdf',
        mimeType: PDF_MIME,
        fileBase64: pdfBytes.toString('base64'),
      });

      const deadline = Date.now() + 10_000;
      let record: ResumeImportDraftRecord | null = null;
      while (Date.now() < deadline) {
        record = await draftStore.get<ResumeImportDraftRecord>(`resume-import:${draftId}`);
        if (record?.status === 'ready' || record?.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(record).not.toBeNull();
      expect(record!.status).toBe('ready');
      expect(record!.draft).not.toBeNull();
      expect(record!.draft!.contact.email.value).toBe('ada@example.com');
      expect(record!.draft!.contact.name.value).toBe('Ada Lovelace');
      expect(record!.draft!.summary.value).toContain('Computing pioneer');
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 15_000);

  it('a corrupt file fails with a typed error on the draft, not a crash — worker keeps running', async () => {
    const draftStore = new RedisDraftStore(redis);
    const worker = createParseResumeWorker({
      connection: redis,
      extractor: new DocumentTextExtractor(),
      drafts: draftStore,
      logger: pino({ level: 'silent' }),
    });

    const queue = new Queue(RESUME_IMPORT_QUEUE, { connection: queueConnection });
    const draftId = 'e2e-test-draft-corrupt';

    try {
      await queue.add(RESUME_IMPORT_QUEUE, {
        draftId,
        userId: 'e2e-user',
        filename: 'not-a-real.pdf',
        mimeType: PDF_MIME,
        fileBase64: Buffer.from('this is not a pdf').toString('base64'),
      });

      const deadline = Date.now() + 10_000;
      let record: ResumeImportDraftRecord | null = null;
      while (Date.now() < deadline) {
        record = await draftStore.get<ResumeImportDraftRecord>(`resume-import:${draftId}`);
        if (record?.status === 'ready' || record?.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(record).not.toBeNull();
      expect(record!.status).toBe('failed');
      expect(record!.error).toBeTruthy();
      expect(record!.draft).toBeNull();
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 15_000);
});
