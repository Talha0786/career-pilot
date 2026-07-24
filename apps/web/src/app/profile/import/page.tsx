'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GetResumeImportDraftResponse, ProfileSectionKindDto } from '@careerpilot/contracts';
import { AppHeader, Card, CardHeader, CardTitle, CardContent, Button, Alert, Badge, Checkbox } from '@careerpilot/ui';
import { api, ApiError } from '@/lib/api-client';
import { profileApi, fileToBase64 } from '@/lib/api/profile';

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const KIND_LABEL: Record<ProfileSectionKindDto, string> = {
  experience: 'Experience',
  education: 'Education',
  project: 'Project',
  skill_group: 'Skills',
  certification: 'Certification',
  summary: 'Summary',
};

/** >=0.7 confident / >=0.4 review-worthy / below that, flag clearly — task 025 acceptance: low-confidence fields must be obviously reviewable. */
function confidenceBadge(confidence: number) {
  if (confidence >= 0.7) return <Badge variant="success">high confidence</Badge>;
  if (confidence >= 0.4) return <Badge variant="warning">review</Badge>;
  return <Badge variant="danger">low confidence</Badge>;
}

function sectionHeading(kind: ProfileSectionKindDto, content: Record<string, unknown>): string {
  switch (kind) {
    case 'experience': return String(content.title ?? '');
    case 'education': return String(content.institution ?? '');
    case 'project': return String(content.name ?? '');
    case 'skill_group': return String(content.groupName ?? '');
    case 'certification': return String(content.name ?? '');
    case 'summary': return 'Summary';
  }
}
function sectionDetail(kind: ProfileSectionKindDto, content: Record<string, unknown>): string {
  switch (kind) {
    case 'experience': return `${String(content.organization ?? '')}  ·  ${String(content.startDate ?? '')} – ${content.endDate ? String(content.endDate) : 'Present'}`;
    case 'education': return String(content.credential ?? '');
    case 'project': return String(content.description ?? '');
    case 'skill_group': return Array.isArray(content.skills) ? (content.skills as string[]).join(', ') : '';
    case 'certification': return String(content.issuer ?? '');
    case 'summary': return String(content.text ?? '');
  }
}

export default function ResumeImportPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GetResumeImportDraftResponse | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setEmail(me.email);
      } catch {
        router.push('/login');
      }
    })();
  }, [router]);

  // Poll the draft while it's still processing (task 023: worker parses async).
  useEffect(() => {
    if (!draftId) return;
    if (draft && draft.status !== 'processing') return;

    const timer = setInterval(async () => {
      try {
        const d = await profileApi.getImportDraft(draftId);
        setDraft(d);
      } catch {
        clearInterval(timer);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [draftId, draft]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setUploadError('Choose a PDF or DOCX file first');
      return;
    }
    const mimeType = file.type || (file.name.endsWith('.docx') ? DOCX_MIME : PDF_MIME);
    if (mimeType !== PDF_MIME && mimeType !== DOCX_MIME) {
      setUploadError('Only PDF and DOCX files are supported');
      return;
    }

    setUploading(true);
    try {
      const fileBase64 = await fileToBase64(file);
      const { draftId: id } = await profileApi.importResume({ filename: file.name, mimeType, fileBase64 });
      setDraftId(id);
      const d = await profileApi.getImportDraft(id);
      setDraft(d);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.problem.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirm() {
    if (!draftId || !draft?.draft) return;
    setConfirmError(null);
    setConfirming(true);
    try {
      const sections = draft.draft.sections
        .map((s, i) => ({ i, kind: s.kind, content: s.content }))
        .filter((s) => !excluded.has(s.i))
        .map(({ kind, content }) => ({ kind, content }));

      await profileApi.confirmImport(draftId, { sections } as never);
      router.push('/profile');
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.problem.message : 'Could not confirm import');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader
        title="Import resume"
        right={
          <>
            <a href="/profile" className="text-sm text-neutral-500 hover:text-neutral-800">Profile</a>
            <span className="text-sm text-neutral-500">{email}</span>
          </>
        }
      />

      <main className="mx-auto max-w-3xl p-6">
        {!draftId && (
          <Card className="max-w-xl">
            <CardHeader>
              <CardTitle>Upload a resume</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUpload} className="flex flex-col gap-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="text-sm"
                />
                {uploadError && <Alert variant="danger">{uploadError}</Alert>}
                <Button type="submit" disabled={uploading} loading={uploading} className="self-start">
                  Upload &amp; parse
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {draft && draft.status === 'processing' && (
          <Alert variant="warning" className="max-w-xl">Parsing your resume…</Alert>
        )}

        {draft && draft.status === 'failed' && (
          <Alert variant="danger" className="max-w-xl">
            Could not parse this file: {draft.error}. <a href="/profile/import" className="underline">Try another file</a>.
          </Alert>
        )}

        {draft && draft.status === 'ready' && draft.draft && (
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Contact info</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-16 text-neutral-500">Name</span>
                    <span>{draft.draft.contact.name.value ?? <em className="text-neutral-400">not found</em>}</span>
                    {confidenceBadge(draft.draft.contact.name.confidence)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-16 text-neutral-500">Email</span>
                    <span>{draft.draft.contact.email.value ?? <em className="text-neutral-400">not found</em>}</span>
                    {confidenceBadge(draft.draft.contact.email.confidence)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-16 text-neutral-500">Phone</span>
                    <span>{draft.draft.contact.phone.value ?? <em className="text-neutral-400">not found</em>}</span>
                    {confidenceBadge(draft.draft.contact.phone.confidence)}
                  </div>
                </div>
              </CardContent>
            </Card>

            {draft.draft.summary.value && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    Summary {confidenceBadge(draft.draft.summary.confidence)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-neutral-700">{draft.draft.summary.value}</p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Parsed sections ({draft.draft.sections.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-sm text-neutral-500">
                  Review each section — uncheck anything that looks wrong or low-confidence before confirming.
                </p>
                <div className="flex flex-col gap-3">
                  {draft.draft.sections.map((section, i) => {
                    const content = section.content as Record<string, unknown>;
                    return (
                      <label
                        key={i}
                        className="flex items-start gap-3 rounded-md border border-neutral-200 p-3 has-[:checked]:bg-neutral-50"
                      >
                        <Checkbox
                          checked={!excluded.has(i)}
                          onCheckedChange={(checked) => {
                            setExcluded((prev) => {
                              const next = new Set(prev);
                              if (checked) next.delete(i);
                              else next.add(i);
                              return next;
                            });
                          }}
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Badge variant="neutral">{KIND_LABEL[section.kind]}</Badge>
                            <span className="font-medium text-neutral-900">{sectionHeading(section.kind, content)}</span>
                            {confidenceBadge(section.confidence)}
                          </div>
                          <p className="mt-1 text-sm text-neutral-600">{sectionDetail(section.kind, content)}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {confirmError && <Alert variant="danger">{confirmError}</Alert>}
            <div className="flex gap-2">
              <Button onClick={handleConfirm} disabled={confirming} loading={confirming}>
                Confirm &amp; add to profile
              </Button>
              <a href="/profile/import">
                <Button type="button" variant="outline">Start over</Button>
              </a>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
