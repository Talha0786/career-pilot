'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { StageSchema, type StageDto, type ApplicationCard, type BoardResponse } from '@careerpilot/contracts';
import { api, ApiError } from '@/lib/api-client';
import { useJobEmbeddedSocket } from '@/lib/ws-client';

const STAGES = StageSchema.options;

const STAGE_LABEL: Record<StageDto, string> = {
  discovered: 'Discovered',
  interested: 'Interested',
  applied: 'Applied',
  screening: 'Screening',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export default function BoardPage() {
  const router = useRouter();
  const [columns, setColumns] = useState<BoardResponse['columns'] | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadBoard = useCallback(async () => {
    const board = await api.getBoard();
    setColumns(board.columns);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setEmail(me.email);
        await loadBoard();
      } catch {
        router.push('/login');
      }
    })();
  }, [router, loadBoard]);

  // The whole point of M2: a card flips pending -> ready with no refresh.
  useJobEmbeddedSocket((event) => {
    setColumns((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      for (const stage of STAGES) {
        next[stage] = (next[stage] ?? []).map((card) =>
          card.jobPostingId === event.jobId ? { ...card, embeddingStatus: event.status } : card,
        );
      }
      return next;
    });
  });

  async function handlePaste(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Captured synchronously — React nulls out the synthetic event's
    // currentTarget once the dispatch finishes, so `e.currentTarget` is no
    // longer safe to read after the first `await` below.
    const formEl = e.currentTarget;
    setFormError(null);
    setSubmitting(true);
    const form = new FormData(formEl);
    const title = String(form.get('title') ?? '').trim();
    const descriptionMd = String(form.get('descriptionMd') ?? '').trim();
    const company = String(form.get('company') ?? '').trim();

    try {
      const job = await api.createJob({
        title,
        descriptionMd,
        ...(company ? { company } : {}),
      });
      await api.createApplication(job.jobId);
      await loadBoard();
      formEl.reset();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.problem.message : 'Could not create job');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDrop(card: ApplicationCard, toStage: StageDto) {
    if (card.stage === toStage) return;
    setBoardError(null);

    // Optimistic move — reverted on failure (e.g. an illegal transition).
    setColumns((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [card.stage]: (prev[card.stage] ?? []).filter((c) => c.applicationId !== card.applicationId),
        [toStage]: [...(prev[toStage] ?? []), { ...card, stage: toStage }],
      };
    });

    try {
      await api.updateStage(card.applicationId, toStage);
    } catch (err) {
      setBoardError(err instanceof ApiError ? err.problem.message : 'Could not move card');
      await loadBoard(); // snap back to server truth
    }
  }

  async function handleLogout() {
    await api.logout();
    router.push('/login');
  }

  if (!columns) return <main style={{ padding: 24 }}>Loading…</main>;

  return (
    <main style={{ padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>CareerPilot board</h1>
        <div>
          <span style={{ marginRight: 12, color: '#555' }}>{email}</span>
          <button onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <section style={{ background: 'white', padding: 16, borderRadius: 8, marginBottom: 24, maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>Paste a job</h2>
        <form onSubmit={handlePaste} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input name="title" placeholder="Job title" required style={{ padding: 8 }} />
          <input name="company" placeholder="Company (optional)" style={{ padding: 8 }} />
          <textarea name="descriptionMd" placeholder="Paste the job description…" required rows={5} style={{ padding: 8 }} />
          {formError && <p style={{ color: 'crimson', margin: 0 }}>{formError}</p>}
          <button type="submit" disabled={submitting} style={{ padding: 10, alignSelf: 'flex-start' }}>
            {submitting ? 'Adding…' : 'Add to board'}
          </button>
        </form>
      </section>

      {boardError && <p style={{ color: 'crimson' }}>{boardError}</p>}

      <div style={{ display: 'flex', gap: 12, overflowX: 'auto' }}>
        {STAGES.map((stage) => (
          <div
            key={stage}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const data = e.dataTransfer.getData('application/json');
              if (!data) return;
              handleDrop(JSON.parse(data) as ApplicationCard, stage);
            }}
            style={{ background: '#eee', borderRadius: 8, padding: 10, minWidth: 220, flexShrink: 0 }}
          >
            <h3 style={{ margin: '4px 0 10px', fontSize: 14, textTransform: 'uppercase', color: '#555' }}>
              {STAGE_LABEL[stage]} ({(columns[stage] ?? []).length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 40 }}>
              {(columns[stage] ?? []).map((card) => (
                <div
                  key={card.applicationId}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify(card))}
                  style={{
                    background: 'white', borderRadius: 6, padding: 10, cursor: 'grab',
                    borderLeft: `4px solid ${statusColor(card.embeddingStatus)}`,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{card.title}</div>
                  {card.company && <div style={{ fontSize: 13, color: '#666' }}>{card.company}</div>}
                  <div style={{ fontSize: 11, marginTop: 6, color: statusColor(card.embeddingStatus) }}>
                    {statusLabel(card.embeddingStatus)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function statusColor(status: ApplicationCard['embeddingStatus']): string {
  if (status === 'ready') return '#2e7d32';
  if (status === 'failed') return '#c62828';
  return '#f9a825';
}

function statusLabel(status: ApplicationCard['embeddingStatus']): string {
  if (status === 'ready') return 'Ready';
  if (status === 'failed') return 'Embedding failed';
  return 'Embedding…';
}
