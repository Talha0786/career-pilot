import { describe, it, expect } from 'vitest';
import { makeGetBoardUseCase } from '../../src/pipeline/queries/get-board.js';
import { FakeJobPostingRepository, FakeApplicationRepository } from '../fake-repos.js';
import { JobPosting, Application, asUserId } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

describe('getBoard', () => {
  it('groups applications by stage and hydrates job details', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const applications = new FakeApplicationRepository();
    const getBoard = makeGetBoardUseCase({ jobPostings, applications });

    const jobResult = JobPosting.createManual({
      userId: USER,
      title: 'Platform Engineer',
      descriptionMd: 'desc',
      company: 'Acme',
    });
    if (!jobResult.ok) throw new Error('setup failed');
    await jobPostings.save(jobResult.value);

    const app = Application.create({ userId: USER, jobPostingId: jobResult.value.id });
    await applications.save(app);

    const board = await getBoard({ userId: USER });

    expect(board.discovered).toHaveLength(1);
    expect(board.discovered[0]).toMatchObject({
      title: 'Platform Engineer',
      company: 'Acme',
      stage: 'discovered',
      embeddingStatus: 'pending',
    });
    expect(board.applied).toHaveLength(0);
  });

  it('skips an application whose job posting is missing rather than throwing', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const applications = new FakeApplicationRepository();
    const getBoard = makeGetBoardUseCase({ jobPostings, applications });

    const app = Application.create({
      userId: USER,
      jobPostingId: '018f0000-0000-7000-8000-0000000000ff' as never,
    });
    await applications.save(app);

    const board = await getBoard({ userId: USER });
    expect(board.discovered).toHaveLength(0); // orphan skipped, no crash
  });

  it('returns an empty board for a user with nothing yet', async () => {
    const getBoard = makeGetBoardUseCase({
      jobPostings: new FakeJobPostingRepository(),
      applications: new FakeApplicationRepository(),
    });
    const board = await getBoard({ userId: USER });
    expect(Object.values(board).every((col) => col.length === 0)).toBe(true);
  });
});
