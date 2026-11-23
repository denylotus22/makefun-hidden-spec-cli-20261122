// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that reads AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to one written specification, finds the lines
// each edit names at the first of three matching tiers, and changes every file or none. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a line break (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, in order: used to print `R old -> new` lines. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One body line of a hunk or chunk: context (in both O and N), deleted (O only) or added (N only). */
type Op = { kind: 'ctx' | 'del' | 'add'; text: string };

const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

const normLine = (s: string, tier: number): string => {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
};

/** 0-based positions at which O occurs in F at one tier, searching from `from` (SPEC.md section 5). */
function occurrences(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2) at which O occurs in F at or after `from`, with its positions. */
function findTier(O: string[], F: string[], from: number, maxTier: number): { tier: number; pos: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrences(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * The lines of N built from ops at position `at` in the file: a context line is written as the file's own matched
 * line, never the patch's; at tier 2 every other line is re-indented (SPEC.md section 5).
 */
function replaceLines(file: FileModel, ops: Op[], at: number, tier: number): string[] {
  const O = ops.filter((o) => o.kind !== 'add').map((o) => o.text);
  const fLead = leadOf(file.lines[at] ?? '');
  const pLead = O.length > 0 ? leadOf(O[0]!) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file.lines[at + oIdx]!);
      oIdx += 1;
    } else if (op.kind === 'del') {
      oIdx += 1;
    } else if (tier === 2 && op.text.trim() !== '' && op.text.startsWith(pLead)) {
      out.push(fLead + op.text.slice(pLead.length));
    } else {
      out.push(op.text);
    }
  }
  return [...file.lines.slice(0, at), ...out, ...file.lines.slice(at + O.length)];
}

/* Unified diffs (SPEC.md section 6). */

interface Hunk {
  A: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusBs: boolean;
  hasPlus: boolean;
  /** Length of O (context + deleted lines) and of N (context + added lines). */
  oLen: number;
  nLen: number;
}

/** A hunk body: the lines after the header, up to the first other line (SPEC.md section 6). */
function parseHunk(lines: string[], i: number, A: number): { hunk: Hunk; next: number } {
  const ops: Op[] = [];
  const bs: boolean[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      ops.push({ kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add', text: l.slice(1) });
      bs.push(false);
      j += 1;
      continue;
    }
    if (l === '') {
      ops.push({ kind: 'ctx', text: '' });
      bs.push(false);
      j += 1;
      continue;
    }
    if (l.startsWith('\\')) {
      if (ops.length > 0) bs[ops.length - 1] = true;
      j += 1;
      continue;
    }
    break;
  }
  while (ops.length > 0 && ops[ops.length - 1]!.kind === 'ctx' && ops[ops.length - 1]!.text === '') {
    ops.pop();
    bs.pop();
  }
  const noEol = ops.length > 0 && ops[ops.length - 1]!.kind !== 'del' && bs[bs.length - 1] === true;
  let lastPlus = -1;
  for (let k = 0; k < ops.length; k++) if (ops[k]!.kind === 'add') lastPlus = k;
  return {
    hunk: {
      A,
      ops,
      noEol,
      plusBs: lastPlus >= 0 && bs[lastPlus] === true,
      hasPlus: lastPlus >= 0,
      oLen: ops.filter((o) => o.kind !== 'add').length,
      nLen: ops.filter((o) => o.kind !== 'del').length,
    },
    next: j,
  };
}

/** A hunk applied to a file: O is matched at the occurrence nearest A-1+d, or N is inserted after A+d lines. */
function applyHunk(file: FileModel, hunk: Hunk, d: number, target: string, strict: boolean): FileModel {
  if (hunk.oLen === 0) {
    if (hunk.nLen === 0) return file;
    const idx = Math.max(0, Math.min(hunk.A + d, file.lines.length));
    const add = hunk.ops.filter((o) => o.kind === 'add').map((o) => o.text);
    const lines = [...file.lines.slice(0, idx), ...add, ...file.lines.slice(idx)];
    return { lines, br: file.br, final: idx === file.lines.length ? !hunk.noEol : file.final };
  }
  const O = hunk.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
  const found = findTier(O, file.lines, 0, strict ? 0 : 2);
  if (found === null) throw new Fail('no-match', target);
  const targetPos = hunk.A - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - targetPos) < Math.abs(best - targetPos)) best = p;
  }
  const lines = replaceLines(file, hunk.ops, best, found.tier);
  return { lines, br: file.br, final: best + O.length === file.lines.length ? !hunk.noEol : file.final };
}

/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the first tab, trimmed. */
function patchPath(s: string): string {
  const p = s.split('\t')[0]!.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** One section of a unified diff: create, delete, move, or change of one path (SPEC.md section 6). */
function makeSectionEdit(
  oldP: string | null,
  newP: string | null,
  newFile: boolean,
  deletedFile: boolean,
  hunks: Hunk[],
  strict: boolean,
): Edit {
  const isCreate = newFile || oldP === '/dev/null';
  const isDelete = deletedFile || newP === '/dev/null';
  return (tree) => {
    if (isCreate) {
      const target = newP!;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of hunks) {
        for (const op of h.ops) if (op.kind === 'add') plus.push(op.text);
        if (h.hasPlus) lastPlusBs = h.plusBs;
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (oldP !== newP) {
      const from = oldP!;
      const to = newP!;
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const cur = tree.get(from);
      if (cur === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      let file = splitFile(cur);
      let d = 0;
      for (const h of hunks) {
        file = applyHunk(file, h, d, from, strict);
        d += h.nLen - h.oLen;
      }
      tree.move(from, to, joinFile(file));
      return;
    }
    const target = oldP!;
    if (!safe(target)) throw new Fail('unsafe', target);
    const cur = tree.get(target);
    if (cur === null) throw new Fail('missing', target);
    let file = splitFile(cur);
    let d = 0;
    for (const h of hunks) {
      file = applyHunk(file, h, d, target, strict);
      d += h.nLen - h.oLen;
    }
    tree.now.set(target, joinFile(file));
  };
}

/** One section, starting just after its `diff --git` line, or at its `--- ` line; returns where to resume. */
function parseSection(
  lines: string[],
  start: number,
  diffOld: string | null,
  diffNew: string | null,
  edits: Edit[],
  strict: boolean,
): number {
  let i = start;
  let headerOld: string | null = null;
  let headerNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let newFile = false;
  let deletedFile = false;
  const hunks: Hunk[] = [];
  let inHeader = true;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader) {
        headerOld = patchPath(l.slice(4));
        headerNew = patchPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      break;
    }
    if (l.startsWith('--- ') && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const r = parseHunk(lines, i, parseInt(m[1]!, 10));
      hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('rename from ')) renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) newFile = true;
      else if (l.startsWith('deleted file mode')) deletedFile = true;
    }
    i += 1;
  }
  const oldP = headerOld ?? renameFrom ?? diffOld;
  const newP = headerNew ?? renameTo ?? diffNew;
  edits.push(makeSectionEdit(oldP, newP, newFile, deletedFile, hunks, strict));
  return i;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseSection(lines, i + 1, m[1]!.trim(), m[2]!.trim(), edits, strict);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      i = parseSection(lines, i, null, null, edits, strict);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

/* SEARCH/REPLACE blocks (SPEC.md section 7). */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let after = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= after; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        eq = j;
        break;
      }
      if (l === '>>>>>>> REPLACE' || l === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${sLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (l === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${sLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const file = splitFile(cur);
      const found = findTier(oldLines, file.lines, 0, strict ? 0 : 2);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const ops: Op[] = [
        ...oldLines.map((t) => ({ kind: 'del' as const, text: t })),
        ...newLines.map((t) => ({ kind: 'add' as const, text: t })),
      ];
      tree.now.set(p, joinFile({ lines: replaceLines(file, ops, found.pos[0]!, found.tier), br: file.br, final: file.final }));
    });
    prevPath = path;
    after = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* V4A patches (SPEC.md section 8). */

interface VChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

/** The lines of one section: from `from` up to the next section's start or the End Patch line, trailing blanks off. */
function collectSection(lines: string[], from: number, last: number): { body: string[]; next: number } {
  let next = last;
  for (let j = from; j < last; j++) {
    const l = lines[j]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      next = j;
      break;
    }
  }
  const body = lines.slice(from, next);
  while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
  return { body, next };
}

function v4aUpdateEdit(path: string, body: string[], updateLine: number, strict: boolean): Edit {
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  while (idx < body.length) {
    const l = body[idx]!;
    const ln = updateLine + 1 + idx;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
      idx += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), ops: [], eof: false };
      chunks.push(cur);
      idx += 1;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, ops: [], eof: false };
        chunks.push(cur);
      }
      cur.ops.push({ kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add', text: l === '' ? '' : l.slice(1) });
      idx += 1;
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const a = findTier([ch.anchor], file.lines, cursor, strict ? 0 : 2);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.pos[0]! + 1;
      }
      const O = ch.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
      const N = ch.ops.filter((o) => o.kind !== 'del').map((o) => o.text);
      if (O.length === 0) {
        const at = ch.eof ? file.lines.length : cursor;
        const lines = [...file.lines.slice(0, at), ...N, ...file.lines.slice(at)];
        file = { lines, br: file.br, final: file.final };
        cursor = at + N.length;
        continue;
      }
      const found = findTier(O, file.lines, cursor, strict ? 0 : 2);
      if (found === null) throw new Fail('no-match', path);
      let at: number;
      if (ch.eof) {
        const ok = found.pos.filter((p) => p + O.length === file.lines.length);
        if (ok.length === 0) throw new Fail('no-match', path);
        at = ok[0]!;
      } else {
        at = found.pos[0]!;
      }
      file = { lines: replaceLines(file, ch.ops, at, found.tier), br: file.br, final: file.final };
      cursor = at + N.length;
    }
    const text = joinFile(file);
    if (moveTo !== null) tree.move(path, moveTo, text);
    else tree.now.set(path, text);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const { body, next } = collectSection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = next;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const { body, next } = collectSection(lines, i + 1, last);
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = next;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const { body, next } = collectSection(lines, i + 1, last);
      edits.push(v4aUpdateEdit(path, body, i + 1, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* JSON tool calls (SPEC.md section 9). */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* The command line (SPEC.md sections 1, 2 and 10). */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rKeys = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null) {
      rKeys.add(oldP);
      rKeys.add(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, { was, now }] of changed) {
    if (rKeys.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, { now }] of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
