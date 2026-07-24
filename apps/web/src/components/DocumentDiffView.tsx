'use client';

import type { DocumentContentDto } from '@careerpilot/contracts';
import { Badge } from '@careerpilot/ui';

/**
 * Task 041 — "a semantic diff against the base document" (docs/06-agent-
 * design.md §4 point 4). Deliberately a PLAIN structural diff over the
 * `ResumeDocumentContent`/`CoverLetterDocumentContent` JSON — added/removed/
 * unchanged per bullet or paragraph — not a heavyweight text-diff library
 * (task 041's own scope note: "do not pull in a heavyweight text-diff
 * library for a two-line change if the repo doesn't already have one").
 * `base` is the immediately-PRECEDING version's content, or `null` when
 * this is the document's first version (nothing to diff against — every
 * line renders as "added").
 */
export function DocumentDiffView({ base, current }: { base: DocumentContentDto | null; current: DocumentContentDto }) {
  if (current.kind === 'resume') {
    const baseResume = base && base.kind === 'resume' ? base : null;
    return (
      <div className="flex flex-col gap-4 text-sm">
        <DiffField label="Summary" before={baseResume?.summary ?? null} after={current.summary} />
        {current.sections.map((section, i) => {
          const baseSection = baseResume?.sections.find((s) => s.heading === section.heading) ?? baseResume?.sections[i];
          return (
            <div key={`${section.heading}-${i}`} className="rounded-md border border-neutral-200 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{section.heading}</p>
              {section.entries.map((entry, j) => {
                const baseEntry = baseSection?.entries.find((e) => e.title === entry.title) ?? baseSection?.entries[j];
                return (
                  <div key={`${entry.title}-${j}`} className="mb-3 last:mb-0">
                    <p className="font-medium text-neutral-900">{entry.title} <span className="font-normal text-neutral-500">— {entry.subtitle}</span></p>
                    <BulletDiffList before={baseEntry?.bullets ?? []} after={entry.bullets} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  if (current.kind === 'cover_letter') {
    const baseLetter = base && base.kind === 'cover_letter' ? base : null;
    return (
      <div className="flex flex-col gap-4 text-sm">
        <DiffField label="Salutation" before={baseLetter?.salutation ?? null} after={current.salutation} />
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Body</p>
          <BulletDiffList before={baseLetter?.bodyParagraphs ?? []} after={current.bodyParagraphs} />
        </div>
        <DiffField label="Closing" before={baseLetter?.closing ?? null} after={current.closing} />
      </div>
    );
  }

  return <p className="text-sm text-neutral-500">No structured diff available for this document kind.</p>;
}

function DiffField({ label, before, after }: { label: string; before: string | null; after: string | null }) {
  const changed = before !== after;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
      {!changed ? (
        <p className="text-neutral-700">{after ?? <span className="italic text-neutral-400">empty</span>}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {before && <p className="rounded bg-danger-50 px-2 py-1 text-danger-600 line-through">{before}</p>}
          {after && <p className="rounded bg-success-50 px-2 py-1 text-success-600">{after}</p>}
        </div>
      )}
    </div>
  );
}

/** Bullet/paragraph-level added/removed/unchanged — matched by exact text (no stable per-bullet id exists on plain `bullets: string[]`/`bodyParagraphs: string[]`, see this file's module doc comment). */
function BulletDiffList({ before, after }: { before: readonly string[]; after: readonly string[] }) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const removed = before.filter((b) => !afterSet.has(b));

  return (
    <ul className="flex flex-col gap-1">
      {after.map((line, i) => {
        const unchanged = beforeSet.has(line);
        return (
          <li
            key={`${line}-${i}`}
            className={unchanged ? 'text-neutral-700' : 'rounded bg-success-50 px-2 py-1 text-success-600'}
          >
            {!unchanged && <Badge variant="success" className="mr-2">added</Badge>}
            {line}
          </li>
        );
      })}
      {removed.map((line, i) => (
        <li key={`removed-${line}-${i}`} className="rounded bg-danger-50 px-2 py-1 text-danger-600 line-through">
          <Badge variant="danger" className="mr-2 no-underline">removed</Badge>
          {line}
        </li>
      ))}
    </ul>
  );
}
