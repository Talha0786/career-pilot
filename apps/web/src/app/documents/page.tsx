'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DocumentDto, DocumentKindDto, DocumentListItemDto } from '@careerpilot/contracts';
import {
  AppHeader, Card, CardHeader, CardTitle, CardContent, Input, Textarea, Button, Alert, Badge,
  FormField, Select, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell,
} from '@careerpilot/ui';
import { api, ApiError } from '@/lib/api-client';
import { documentsApi } from '@/lib/api/documents';

const KIND_OPTIONS: { value: DocumentKindDto; label: string }[] = [
  { value: 'resume', label: 'Resume' },
  { value: 'cover_letter', label: 'Cover letter' },
  { value: 'other', label: 'Other' },
];

export default function DocumentsPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [items, setItems] = useState<DocumentListItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await documentsApi.list();
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not load documents');
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

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader
        title="Documents"
        right={
          <>
            <a href="/board" className="text-sm text-neutral-500 hover:text-neutral-800">Board</a>
            <a href="/profile" className="text-sm text-neutral-500 hover:text-neutral-800">Profile</a>
            <span className="text-sm text-neutral-500">{email}</span>
            <Button variant="outline" size="sm" onClick={handleLogout}>Log out</Button>
          </>
        }
      />

      <main className="mx-auto max-w-4xl p-6">
        {error && <Alert variant="danger" className="mb-4">{error}</Alert>}

        <div className="mb-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Cancel' : '+ New document'}
          </Button>
        </div>

        {creating && (
          <CreateDocumentCard
            onCreated={() => {
              setCreating(false);
              load();
            }}
          />
        )}

        {!items ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-neutral-500">No documents yet.</p>
        ) : (
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>Title</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell />
              </tr>
            </TableHead>
            <TableBody>
              {items.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  expanded={expandedId === doc.id}
                  onToggle={() => setExpandedId((cur) => (cur === doc.id ? null : doc.id))}
                  onChanged={load}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </main>
    </div>
  );
}

function DocumentRow({
  doc, expanded, onToggle, onChanged,
}: {
  doc: DocumentListItemDto; expanded: boolean; onToggle: () => void; onChanged: () => void;
}) {
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="font-medium text-neutral-900">{doc.title}</TableCell>
        <TableCell className="capitalize">{doc.kind.replace('_', ' ')}</TableCell>
        <TableCell>{doc.currentVersion ?? '—'}</TableCell>
        <TableCell>{new Date(doc.updatedAt).toLocaleString()}</TableCell>
        <TableCell>
          {/* task 025 acceptance: visible stale indicator driven by profile_facts_hash mismatch */}
          {doc.isStale ? <Badge variant="warning">stale</Badge> : <Badge variant="success">up to date</Badge>}
        </TableCell>
        <TableCell>{expanded ? '▲' : '▼'}</TableCell>
      </TableRow>
      {expanded && (
        <tr>
          <td colSpan={6} className="bg-neutral-50 px-4 py-4">
            <DocumentDetail documentId={doc.id} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function DocumentDetail({ documentId, onChanged }: { documentId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<DocumentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingVersion, setAddingVersion] = useState(false);
  const [renderingKey, setRenderingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await documentsApi.get(documentId);
      setDetail(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not load document');
    }
  }, [documentId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRender(versionId: string, format: 'pdf' | 'docx', template: 'classic' | 'modern') {
    setRenderingKey(`${versionId}:${format}`);
    try {
      await documentsApi.render(documentId, versionId, { format, template });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Render failed');
    } finally {
      setRenderingKey(null);
    }
  }

  if (error) return <Alert variant="danger">{error}</Alert>;
  if (!detail) return <p className="text-sm text-neutral-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      {detail.versions.length === 0 ? (
        <p className="text-sm text-neutral-500">No versions yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...detail.versions].reverse().map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-neutral-0 p-3 text-sm">
              <Badge variant="neutral">v{v.version}</Badge>
              <span className="text-neutral-500">{v.source}</span>
              <span className="text-neutral-400">{new Date(v.createdAt).toLocaleString()}</span>
              {v.renderedPdfKey ? (
                <a
                  href={documentsApi.downloadUrl(documentId, v.id)}
                  className="ml-auto text-primary-600 hover:underline"
                >
                  Download {v.renderedPdfKey.endsWith('.docx') ? 'DOCX' : 'PDF'}
                </a>
              ) : (
                <span className="ml-auto flex gap-2">
                  <Button
                    size="sm" variant="outline"
                    disabled={renderingKey === `${v.id}:pdf`}
                    loading={renderingKey === `${v.id}:pdf`}
                    onClick={() => handleRender(v.id, 'pdf', 'classic')}
                  >
                    Render PDF
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    disabled={renderingKey === `${v.id}:docx`}
                    loading={renderingKey === `${v.id}:docx`}
                    onClick={() => handleRender(v.id, 'docx', 'modern')}
                  >
                    Render DOCX
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {addingVersion ? (
        <AddVersionForm
          documentId={documentId}
          kind={detail.kind}
          onDone={() => {
            setAddingVersion(false);
            load();
            onChanged();
          }}
          onCancel={() => setAddingVersion(false)}
        />
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={() => setAddingVersion(true)}>
          + Add version
        </Button>
      )}
    </div>
  );
}

function CreateDocumentCard({ onCreated }: { onCreated: () => void }) {
  const [kind, setKind] = useState<DocumentKindDto>('resume');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await documentsApi.create({ kind, title });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not create document');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>New document</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <FormField label="Kind" className="sm:w-48">
            <Select options={KIND_OPTIONS} value={kind} onValueChange={(v) => setKind(v as DocumentKindDto)} />
          </FormField>
          <FormField label="Title" required className="flex-1">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </FormField>
          <Button type="submit" disabled={submitting} loading={submitting}>Create</Button>
        </form>
        {error && <Alert variant="danger" className="mt-3">{error}</Alert>}
      </CardContent>
    </Card>
  );
}

function AddVersionForm({
  documentId, kind, onDone, onCancel,
}: {
  documentId: string; kind: DocumentKindDto; onDone: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [summary, setSummary] = useState('');
  const [heading, setHeading] = useState('Experience');
  const [entryTitle, setEntryTitle] = useState('');
  const [entrySubtitle, setEntrySubtitle] = useState('');
  const [entryDates, setEntryDates] = useState('');
  const [entryBullets, setEntryBullets] = useState('');
  const [salutation, setSalutation] = useState('Dear Hiring Manager,');
  const [bodyText, setBodyText] = useState('');
  const [closing, setClosing] = useState('Sincerely,');
  const [bodyMd, setBodyMd] = useState('');
  const [otherTitle, setOtherTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function buildContent(): unknown {
    if (kind === 'resume') {
      return {
        schemaVersion: 1, kind: 'resume',
        contact: { name, email: contactEmail },
        summary: summary || null,
        sections: entryTitle
          ? [{
              heading,
              entries: [{
                title: entryTitle, subtitle: entrySubtitle, dateRange: entryDates || null,
                bullets: entryBullets.split('\n').map((b) => b.trim()).filter(Boolean),
              }],
            }]
          : [],
      };
    }
    if (kind === 'cover_letter') {
      return {
        schemaVersion: 1, kind: 'cover_letter',
        contact: { name, email: contactEmail },
        recipient: null,
        salutation,
        bodyParagraphs: bodyText.split('\n\n').map((p) => p.trim()).filter(Boolean),
        closing,
      };
    }
    return { schemaVersion: 1, kind: 'other', title: otherTitle, bodyMd };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await documentsApi.addVersion(documentId, { source: 'edited', content: buildContent() } as never);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not add version');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-0 p-4">
      {kind === 'other' ? (
        <>
          <FormField label="Title" required>
            <Input value={otherTitle} onChange={(e) => setOtherTitle(e.target.value)} required />
          </FormField>
          <FormField label="Body">
            <Textarea value={bodyMd} onChange={(e) => setBodyMd(e.target.value)} rows={5} />
          </FormField>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Full name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </FormField>
            <FormField label="Email" required>
              <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} required />
            </FormField>
          </div>

          {kind === 'resume' && (
            <>
              <FormField label="Summary">
                <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} />
              </FormField>
              <p className="text-xs text-neutral-500">Optional: one section with one entry</p>
              <FormField label="Section heading">
                <Input value={heading} onChange={(e) => setHeading(e.target.value)} />
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Entry title">
                  <Input value={entryTitle} onChange={(e) => setEntryTitle(e.target.value)} />
                </FormField>
                <FormField label="Entry subtitle">
                  <Input value={entrySubtitle} onChange={(e) => setEntrySubtitle(e.target.value)} />
                </FormField>
              </div>
              <FormField label="Date range">
                <Input value={entryDates} onChange={(e) => setEntryDates(e.target.value)} placeholder="Jan 2020 - Present" />
              </FormField>
              <FormField label="Bullets" hint="One per line">
                <Textarea value={entryBullets} onChange={(e) => setEntryBullets(e.target.value)} rows={3} />
              </FormField>
            </>
          )}

          {kind === 'cover_letter' && (
            <>
              <FormField label="Salutation">
                <Input value={salutation} onChange={(e) => setSalutation(e.target.value)} />
              </FormField>
              <FormField label="Body" hint="Separate paragraphs with a blank line">
                <Textarea value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={5} />
              </FormField>
              <FormField label="Closing">
                <Input value={closing} onChange={(e) => setClosing(e.target.value)} />
              </FormField>
            </>
          )}
        </>
      )}

      {error && <Alert variant="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting} loading={submitting}>Add version</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
