/**
 * Handoff parser — `docs/handoffs/<slug>/phase-NN-<title>.md`.
 *
 * The handoff is the baton a finishing phase hands to the next session, so the
 * console surfaces three things from it: the front-matter contract
 * (status/depends_on/blocks/skills/key_files), the body sections, and the
 * fenced boot prompts under `▶ Start next phase(s)` which are copied verbatim.
 */

import {
  parseFrontMatter, stripFrontMatter, fmString, fmList, fmPhaseList,
  type FrontMatter,
} from './frontmatter.ts';
import { sections, findSection, fences, type Section } from './markdown.ts';

export type HandoffStatus = 'complete' | 'in-progress' | 'blocked' | 'pending' | 'unknown';

export type BootPrompt = {
  /** Phase the prompt starts, when it can be read out of the text. */
  phase?: number;
  gated: boolean;
  text: string;
};

export type Handoff = {
  slug: string;
  phase: number;
  file: string;
  path: string;
  title: string;
  status: HandoffStatus;
  rawStatus?: string;
  completed?: string;
  nextPhase?: string;
  dependsOn: number[];
  blocks: number[];
  parallelSafe: number[];
  skillsUsed: string[];
  keyFiles: string[];
  memoryKey?: string;
  frontMatter: FrontMatter;
  sections: Section[];
  whatItDid?: string;
  stateNow?: string;
  filesChanged?: string;
  decisions?: string;
  outstanding?: string;
  prompts: BootPrompt[];
  /** True for `## 🏁 Final phase — closeout` handoffs. */
  finalPhase: boolean;
  body: string;
  bytes: number;
  mtime: number;
};

const KNOWN: HandoffStatus[] = ['complete', 'in-progress', 'blocked', 'pending'];

export function normaliseStatus(raw?: string): HandoffStatus {
  const v = (raw ?? '').trim().toLowerCase();
  return (KNOWN as string[]).includes(v) ? (v as HandoffStatus) : 'unknown';
}

/** `phase-07-front-admin-review-console.md` → `{ phase: 7, title: 'front-admin-review-console' }` */
export function parseHandoffFilename(file: string): { phase?: number; title: string } {
  const m = /^phase-(\d+)-(.+)\.md$/.exec(file);
  if (!m) return { title: file.replace(/\.md$/, '') };
  return { phase: Number.parseInt(m[1], 10), title: m[2] };
}

function extractPrompts(section?: Section): BootPrompt[] {
  if (!section) return [];
  return fences(section.body).map((f) => {
    const phase = /start Phase (\d+)/i.exec(f.code)?.[1];
    return {
      phase: phase ? Number(phase) : undefined,
      gated: /GATED phase/i.test(f.code),
      text: f.code.trim(),
    };
  }).filter((p) => p.text.length > 0);
}

export function parseHandoff(
  text: string,
  slug: string,
  file: string,
  path: string,
  stat: { size: number; mtimeMs: number },
): Handoff {
  const frontMatter = parseFrontMatter(text);
  const body = stripFrontMatter(text, frontMatter);
  const secs = sections(body);
  const fromName = parseHandoffFilename(file);

  const rawStatus = fmString(frontMatter, 'status');
  const startNext = secs.find((s) => /start next phase/i.test(s.title));
  const closeout = secs.find((s) => /final phase|closeout/i.test(s.title));

  return {
    slug,
    phase: Number(fmString(frontMatter, 'phase') ?? fromName.phase ?? 0),
    file,
    path,
    title: fmString(frontMatter, 'title') ?? fromName.title,
    status: normaliseStatus(rawStatus),
    rawStatus,
    completed: fmString(frontMatter, 'completed'),
    nextPhase: fmString(frontMatter, 'next_phase'),
    dependsOn: fmPhaseList(frontMatter, 'depends_on'),
    blocks: fmPhaseList(frontMatter, 'blocks'),
    parallelSafe: fmPhaseList(frontMatter, 'parallel_safe'),
    skillsUsed: fmList(frontMatter, 'skills_used'),
    keyFiles: fmList(frontMatter, 'key_files'),
    memoryKey: fmString(frontMatter, 'memory'),
    frontMatter,
    sections: secs,
    whatItDid: findSection(secs, 'What this phase')?.body,
    stateNow: findSection(secs, 'State now')?.body,
    filesChanged: findSection(secs, 'Files changed')?.body,
    decisions: findSection(secs, 'Key decisions')?.body,
    outstanding: findSection(secs, 'Outstanding')?.body,
    prompts: extractPrompts(startNext ?? closeout),
    finalPhase: Boolean(closeout),
    body,
    bytes: stat.size,
    mtime: stat.mtimeMs,
  };
}
