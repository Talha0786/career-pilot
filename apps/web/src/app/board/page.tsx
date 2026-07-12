'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { StageSchema, type StageDto, type ApplicationCard, type BoardResponse } from '@careerpilot/contracts';
import { AppHeader, Card, CardHeader, CardTitle, CardContent, Input, Textarea, Button, Alert, KanbanColumn, KanbanCard } from '@careerpilot/ui';
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

  if (!columns) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-neutral-500">Loading…</div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader
        title="CareerPilot board"
        right={
          <>
            <span className="text-sm text-neutral-500">{email}</span>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              Log out
            </Button>
          </>
        }
      />

      <main className="p-6">
        <Card className="mb-6 max-w-xl">
          <CardHeader>
            <CardTitle>Paste a job</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePaste} className="flex flex-col gap-3">
              <Input name="title" placeholder="Job title" required />
              <Input name="company" placeholder="Company (optional)" />
              <Textarea name="descriptionMd" placeholder="Paste the job description…" required rows={5} />
              {formError && <Alert variant="danger">{formError}</Alert>}
              <Button type="submit" disabled={submitting} loading={submitting} className="self-start">
                {submitting ? 'Adding…' : 'Add to board'}
              </Button>
            </form>
          </CardContent>
        </Card>

        {boardError && <Alert variant="danger" className="mb-4 max-w-xl">{boardError}</Alert>}

        <div className="flex gap-3 overflow-x-auto pb-2">
          {STAGES.map((stage) => (
            <KanbanColumn
              key={stage}
              title={STAGE_LABEL[stage]}
              count={(columns[stage] ?? []).length}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const data = e.dataTransfer.getData('application/json');
                if (!data) return;
                handleDrop(JSON.parse(data) as ApplicationCard, stage);
              }}
            >
              {(columns[stage] ?? []).map((card) => (
                <KanbanCard
                  key={card.applicationId}
                  title={card.title}
                  {...(card.company ? { subtitle: card.company } : {})}
                  statusLabel={statusLabel(card.embeddingStatus)}
                  statusTone={statusTone(card.embeddingStatus)}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify(card))}
                />
              ))}
            </KanbanColumn>
          ))}
        </div>
      </main>
    </div>
  );
}

function statusTone(status: ApplicationCard['embeddingStatus']): 'pending' | 'ready' | 'failed' {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function statusLabel(status: ApplicationCard['embeddingStatus']): string {
  if (status === 'ready') return 'Ready';
  if (status === 'failed') return 'Embedding failed';
  return 'Embedding…';
}
