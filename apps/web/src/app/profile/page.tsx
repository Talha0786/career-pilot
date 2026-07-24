'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CareerProfileDto, ProfileSectionKindDto } from '@careerpilot/contracts';
import {
  AppHeader, Card, CardHeader, CardTitle, CardContent, Input, Textarea, Button, Alert, Badge,
  FormField, Select, Divider,
} from '@careerpilot/ui';
import { api, ApiError } from '@/lib/api-client';
import { profileApi } from '@/lib/api/profile';

const KIND_OPTIONS: { value: ProfileSectionKindDto; label: string }[] = [
  { value: 'experience', label: 'Experience' },
  { value: 'education', label: 'Education' },
  { value: 'project', label: 'Project' },
  { value: 'skill_group', label: 'Skills' },
  { value: 'certification', label: 'Certification' },
  { value: 'summary', label: 'Summary' },
];

const KIND_LABEL: Record<ProfileSectionKindDto, string> = {
  experience: 'Experience',
  education: 'Education',
  project: 'Project',
  skill_group: 'Skills',
  certification: 'Certification',
  summary: 'Summary',
};

/** Splits a newline/comma list into trimmed, non-empty items — used for bullets/skills/details fields. */
function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function ProfilePage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<CareerProfileDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const p = await profileApi.getProfile();
      setProfile(p);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setProfile(null);
        setLoadError(null);
      } else {
        setLoadError(err instanceof ApiError ? err.problem.message : 'Could not load profile');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setEmail(me.email);
        await load();
      } catch {
        router.push('/login');
      }
    })();
  }, [router, load]);

  async function handleLogout() {
    await api.logout();
    router.push('/login');
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-neutral-500">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader
        title="My profile"
        right={
          <>
            <a href="/board" className="text-sm text-neutral-500 hover:text-neutral-800">Board</a>
            <a href="/documents" className="text-sm text-neutral-500 hover:text-neutral-800">Documents</a>
            <span className="text-sm text-neutral-500">{email}</span>
            <Button variant="outline" size="sm" onClick={handleLogout}>Log out</Button>
          </>
        }
      />

      <main className="mx-auto max-w-3xl p-6">
        {loadError && <Alert variant="danger" className="mb-4">{loadError}</Alert>}

        {profile ? (
          <ProfileEditor profile={profile} onChanged={load} />
        ) : (
          <CreateProfileForm onCreated={load} />
        )}
      </main>
    </div>
  );
}

function CreateProfileForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await profileApi.putProfile({ title, ...(summary ? { summary } : {}) });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not create profile');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Create your career profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormField label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. My Career" required />
          </FormField>
          <FormField label="Summary" hint="Optional — a short professional summary">
            <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
          </FormField>
          {error && <Alert variant="danger">{error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting} loading={submitting}>Create profile</Button>
            <a href="/profile/import">
              <Button type="button" variant="outline">Import from resume instead</Button>
            </a>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ProfileEditor({ profile, onChanged }: { profile: CareerProfileDto; onChanged: () => void }) {
  const [title, setTitle] = useState(profile.title);
  const [summary, setSummary] = useState(profile.summary ?? '');
  const [savingHeader, setSavingHeader] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [addingSection, setAddingSection] = useState(false);

  async function handleSaveHeader(e: React.FormEvent) {
    e.preventDefault();
    setHeaderError(null);
    setSavingHeader(true);
    try {
      await profileApi.putProfile({ title, summary: summary || null });
      onChanged();
    } catch (err) {
      setHeaderError(err instanceof ApiError ? err.problem.message : 'Could not save');
    } finally {
      setSavingHeader(false);
    }
  }

  const sortedSections = [...profile.sections].sort((a, b) => a.sort - b.sort);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveHeader} className="flex flex-col gap-4">
            <FormField label="Title" required>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </FormField>
            <FormField label="Summary">
              <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
            </FormField>
            <div className="flex items-center gap-3">
              <span className="text-xs text-neutral-500">
                Embedding: <Badge variant={profile.isEmbeddingStale ? 'warning' : 'success'}>
                  {profile.isEmbeddingStale ? 'stale' : 'up to date'}
                </Badge>
              </span>
            </div>
            {headerError && <Alert variant="danger">{headerError}</Alert>}
            <Button type="submit" disabled={savingHeader} loading={savingHeader} className="self-start">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sections ({sortedSections.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            {sortedSections.length === 0 && (
              <p className="text-sm text-neutral-500">
                No sections yet. Add one below, or <a href="/profile/import" className="text-primary-600 hover:underline">import from a resume</a>.
              </p>
            )}
            {sortedSections.map((section) => (
              <SectionSummaryCard key={section.id} kind={section.kind} content={section.content} />
            ))}

            <Divider />

            {addingSection ? (
              <AddSectionForm
                onDone={() => {
                  setAddingSection(false);
                  onChanged();
                }}
                onCancel={() => setAddingSection(false)}
              />
            ) : (
              <Button variant="outline" className="self-start" onClick={() => setAddingSection(true)}>
                + Add section
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SectionSummaryCard({ kind, content }: { kind: ProfileSectionKindDto; content: unknown }) {
  const c = content as Record<string, unknown>;
  let heading = '';
  let detail = '';

  switch (kind) {
    case 'experience':
      heading = String(c.title ?? '');
      detail = `${String(c.organization ?? '')} · ${String(c.startDate ?? '')} – ${c.endDate ? String(c.endDate) : 'Present'}`;
      break;
    case 'education':
      heading = String(c.institution ?? '');
      detail = String(c.credential ?? '');
      break;
    case 'project':
      heading = String(c.name ?? '');
      detail = String(c.description ?? '');
      break;
    case 'skill_group':
      heading = String(c.groupName ?? '');
      detail = Array.isArray(c.skills) ? (c.skills as string[]).join(', ') : '';
      break;
    case 'certification':
      heading = String(c.name ?? '');
      detail = String(c.issuer ?? '');
      break;
    case 'summary':
      heading = 'Summary';
      detail = String(c.text ?? '');
      break;
  }

  return (
    <div className="rounded-md border border-neutral-200 p-3">
      <div className="flex items-center gap-2">
        <Badge variant="neutral">{KIND_LABEL[kind]}</Badge>
        <span className="font-medium text-neutral-900">{heading}</span>
      </div>
      {detail && <p className="mt-1 text-sm text-neutral-600">{detail}</p>}
    </div>
  );
}

function AddSectionForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<ProfileSectionKindDto>('experience');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Generic fields, interpreted per-kind on submit.
  const [primary, setPrimary] = useState(''); // title / institution / name / groupName / name / (unused for summary)
  const [secondary, setSecondary] = useState(''); // organization / credential / description / (skills list) / issuer
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [listField, setListField] = useState(''); // bullets / details / skills (newline or comma separated)
  const [text, setText] = useState(''); // summary text

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const content = buildContent(kind, { primary, secondary, startDate, endDate, listField, text });
      await profileApi.addSection({ kind, content } as never);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not add section');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
      <FormField label="Kind" required>
        <Select
          options={KIND_OPTIONS}
          value={kind}
          onValueChange={(v) => setKind(v as ProfileSectionKindDto)}
        />
      </FormField>

      {kind === 'summary' ? (
        <FormField label="Summary text" required>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} required />
        </FormField>
      ) : (
        <>
          <FormField label={primaryLabel(kind)} required>
            <Input value={primary} onChange={(e) => setPrimary(e.target.value)} required />
          </FormField>
          {kind !== 'skill_group' && (
            <FormField label={secondaryLabel(kind)} required={kind !== 'certification'}>
              <Input value={secondary} onChange={(e) => setSecondary(e.target.value)} required={kind !== 'certification'} />
            </FormField>
          )}
          {(kind === 'experience' || kind === 'education') && (
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Start date" hint="e.g. 2020-01" required>
                <Input value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
              </FormField>
              <FormField label="End date" hint="blank = present">
                <Input value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </FormField>
            </div>
          )}
          {kind === 'skill_group' && (
            <FormField label="Skills" hint="Comma or newline separated" required>
              <Textarea value={secondary} onChange={(e) => setSecondary(e.target.value)} rows={2} required />
            </FormField>
          )}
          {(kind === 'experience' || kind === 'education' || kind === 'project') && (
            <FormField label={kind === 'project' ? 'Bullets' : 'Bullets / details'} hint="One per line">
              <Textarea value={listField} onChange={(e) => setListField(e.target.value)} rows={3} />
            </FormField>
          )}
        </>
      )}

      {error && <Alert variant="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting} loading={submitting}>Add</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function primaryLabel(kind: ProfileSectionKindDto): string {
  switch (kind) {
    case 'experience': return 'Job title';
    case 'education': return 'Institution';
    case 'project': return 'Project name';
    case 'skill_group': return 'Group name';
    case 'certification': return 'Certification name';
    default: return 'Title';
  }
}
function secondaryLabel(kind: ProfileSectionKindDto): string {
  switch (kind) {
    case 'experience': return 'Organization';
    case 'education': return 'Credential';
    case 'project': return 'Description';
    case 'certification': return 'Issuer';
    default: return '';
  }
}

function buildContent(
  kind: ProfileSectionKindDto,
  fields: { primary: string; secondary: string; startDate: string; endDate: string; listField: string; text: string },
): unknown {
  const { primary, secondary, startDate, endDate, listField, text } = fields;
  switch (kind) {
    case 'experience':
      return {
        schemaVersion: 1, title: primary, organization: secondary,
        startDate, endDate: endDate || null, bullets: splitList(listField),
      };
    case 'education':
      return {
        schemaVersion: 1, institution: primary, credential: secondary,
        startDate, endDate: endDate || null,
        ...(listField ? { details: splitList(listField) } : {}),
      };
    case 'project':
      return { schemaVersion: 1, name: primary, description: secondary, bullets: splitList(listField) };
    case 'skill_group':
      return { schemaVersion: 1, groupName: primary, skills: splitList(secondary) };
    case 'certification':
      return { schemaVersion: 1, name: primary, issuer: secondary || 'Unknown' };
    case 'summary':
      return { schemaVersion: 1, text };
  }
}
