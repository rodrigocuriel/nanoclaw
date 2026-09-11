/**
 * Project-doc composition for surfaces-providing providers (Codex's AGENTS.md).
 *
 * Lean, self-contained version written for this behind-trunk core: trunk's
 * project-doc-compose pulls in a persona module and newer container-config
 * exports this install doesn't have. Codex only needs a flat, byte-capped
 * project doc composed from: the shared runtime-contract base, the group's own
 * memory (its existing `CLAUDE.local.md`), and the spec's extra sections.
 *
 * Flat (fully inlined), not `@import`-based — Codex reads AGENTS.md as one
 * document with a hard byte cap (`project_doc_max_bytes`, 32KB). Over the cap
 * we degrade by dropping the largest optional sections (never the base), so a
 * spawn is never blocked.
 */
import fs from 'fs';
import path from 'path';

import type { AgentGroup } from './types.js';

export interface ProjectDocSection {
  name: string;
  body: string;
}

export interface ProjectDocSpec {
  /** Output file written into the group dir (e.g. `AGENTS.md`). */
  fileName: string;
  /** Project-root-relative path to the shared runtime-contract base doc. */
  baseDocPath: string;
  /** Extra sections appended after the base + group memory. */
  extraSections: ProjectDocSection[];
  /** Hard byte cap for the composed doc. */
  maxBytes: number;
}

export const DEFAULT_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'AGENTS.md',
  baseDocPath: path.join('container', 'AGENTS.md'),
  extraSections: [],
  maxBytes: 32 * 1024,
};

const HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group memory. -->';

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Compose `<groupDir>/<spec.fileName>` from the base contract, the group's
 * `CLAUDE.local.md` memory (inlined), and the spec's extra sections. Async to
 * match the provider-contribution contract; all IO here is sync under the hood.
 */
export async function composeGroupProjectDoc(
  group: AgentGroup,
  groupDir: string,
  spec: ProjectDocSpec,
): Promise<void> {
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

  // Ordered sections. The base contract is mandatory (never dropped); the rest
  // are optional and shed largest-first if we blow the byte cap.
  const mandatory: string[] = [HEADER];

  const basePath = path.resolve(process.cwd(), spec.baseDocPath);
  if (fs.existsSync(basePath)) {
    mandatory.push(fs.readFileSync(basePath, 'utf8').trim());
  }

  const optional: ProjectDocSection[] = [];

  // Group memory: this core keeps per-group memory in CLAUDE.local.md. Inline
  // it so Codex (which reads only AGENTS.md) sees the group's persona/memory.
  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (fs.existsSync(localFile)) {
    const local = fs.readFileSync(localFile, 'utf8').trim();
    if (local) optional.push({ name: 'Group Memory', body: local });
  }

  for (const s of spec.extraSections) optional.push(s);

  const render = (secs: ProjectDocSection[]): string => {
    const parts = [...mandatory];
    for (const s of secs) parts.push(`## ${s.name}\n\n${s.body}`);
    return parts.join('\n\n---\n\n') + '\n';
  };

  // Shed largest optional sections until under the cap.
  let sections = [...optional];
  while (byteLen(render(sections)) > spec.maxBytes && sections.length > 0) {
    let largest = 0;
    for (let i = 1; i < sections.length; i++) {
      if (byteLen(sections[i].body) > byteLen(sections[largest].body)) largest = i;
    }
    sections.splice(largest, 1);
  }

  let doc = render(sections);
  // Last resort: even the mandatory base exceeds the cap — hard-truncate.
  if (byteLen(doc) > spec.maxBytes) doc = doc.slice(0, spec.maxBytes);

  fs.writeFileSync(path.join(groupDir, spec.fileName), doc);
}
