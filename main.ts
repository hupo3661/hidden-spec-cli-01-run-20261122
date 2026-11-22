// mend: applies edits written by models to a tree of text files, in four
// formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool
// calls), as SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
  recordMove(oldP: string, newP: string): void {
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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

// ---- shared line matching (SPEC.md section 5) ----

/** A file's lines, its line break and whether it ends with one. */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinParts(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Positions at or after `from` where O occurs at one tier. */
function occurrencesAt(O: string[], lines: string[], tier: number, from: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndWS : trimWS;
  const nO = O.map(norm);
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(lines[i + j]!) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function findTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(O, lines, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of a hunk or chunk body. `oIndex` is the line's index in O (-1 for new lines). */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line followed this line: the file it comes from had no final line break here. */
  noNL: boolean;
  oIndex: number;
}

/** O is the context and old lines; N the context and new lines, in body order. */
function splitBody(items: BodyItem[]): { O: string[]; N: BodyItem[] } {
  const O: string[] = [];
  const N: BodyItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      it.oIndex = O.length;
      O.push(it.text);
      N.push(it);
    } else if (it.kind === 'old') {
      it.oIndex = O.length;
      O.push(it.text);
    } else {
      it.oIndex = -1;
      N.push(it);
    }
  }
  return { O, N };
}

/** The lines N writes: context lines as the file's own matched lines, other lines re-indented at tier 2. */
function buildReplacement(N: BodyItem[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  if (tier !== 2) return N.map((e) => (e.oIndex >= 0 ? fileLines[pos + e.oIndex]! : e.text));
  const F = leadingWS(fileLines[pos]!);
  const P = leadingWS(O[0]!);
  return N.map((e) => {
    if (e.oIndex >= 0) return fileLines[pos + e.oIndex]!;
    const t = e.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

/** Whether a `\` line follows the body's last context or new line. */
function lastNoNL(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.noNL;
  }
  return false;
}

// ---- unified diffs (SPEC.md section 6) ----

interface Hunk {
  /** Old-file start line, 1-based, from the header. */
  a: number;
  items: BodyItem[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(rest: string): string {
  return rest.split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed; `/dev/null` means no file. */
function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk's body, from the line after its header; returns the hunk and the next line index. */
function parseHunkBody(lines: string[], j: number, a: number): [Hunk, number] {
  const items: BodyItem[] = [];
  let k = j;
  while (k < lines.length) {
    const line = lines[k]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      items.push({ kind: 'ctx', text: '', noNL: false, oIndex: -1 });
      k++;
      continue;
    }
    const c = line[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: line.slice(1), noNL: false, oIndex: -1 });
      k++;
      continue;
    }
    if (c === '\\') {
      if (items.length > 0) items[items.length - 1]!.noNL = true;
      k++;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return [{ a, items }, k];
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let sawPaths = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      sawPaths = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !sawPaths) {
        cur.oldPath = stripAB(headerPath(line.slice(4)));
        cur.newPath = stripAB(headerPath(lines[i + 1]!.slice(4)));
        sawPaths = true;
        i += 2;
        continue;
      }
      cur = {
        oldPath: stripAB(headerPath(line.slice(4))),
        newPath: stripAB(headerPath(lines[i + 1]!.slice(4))),
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      sawPaths = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const [hunk, next] = parseHunkBody(lines, i + 1, parseInt(m[1]!, 10));
        cur.hunks.push(hunk);
        i = next;
        continue;
      }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const [hunk, next] = parseHunkBody(lines, i + 1, parseInt(m[1]!, 10));
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply one hunk to the working file; returns the new drift `d`. */
function applyUnifiedHunk(st: FileParts, hunk: Hunk, strict: boolean, d: number, path: string): number {
  const { O, N } = splitBody(hunk.items);
  const noNL = lastNoNL(hunk.items);
  if (O.length === 0) {
    const oldLen = st.lines.length;
    const at = Math.min(Math.max(hunk.a + d, 0), oldLen);
    st.lines.splice(at, 0, ...N.map((e) => e.text));
    if (at === oldLen) st.final = !noNL;
    return d + (N.length - O.length);
  }
  const found = findTier(O, st.lines, 0, strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const repl = buildReplacement(N, st.lines, best, found.tier, O);
  const toEnd = best + O.length === st.lines.length;
  st.lines.splice(best, O.length, ...repl);
  if (toEnd) st.final = !noNL;
  return d + (N.length - O.length);
}

function unifiedEdits(sections: UnifiedSection[], strict: boolean): Edit[] {
  return sections.map((sec) => (tree: Tree): void => {
    for (const p of [sec.oldPath, sec.newPath]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if ((sec.newFile || oldP === null) && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let last: BodyItem | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            last = it;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (last !== null && last.noNL ? '' : '\n'));
      return;
    }
    if ((sec.deletedFile || newP === null) && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const st = fileParts(before);
      let d = 0;
      for (const h of sec.hunks) d = applyUnifiedHunk(st, h, strict, d, oldP);
      tree.now.set(newP, joinParts(st.lines, st.br, st.final));
      tree.now.set(oldP, null);
      tree.recordMove(oldP, newP);
      return;
    }
    if (oldP !== null) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const st = fileParts(before);
      let d = 0;
      for (const h of sec.hunks) d = applyUnifiedHunk(st, h, strict, d, oldP);
      tree.now.set(oldP, joinParts(st.lines, st.br, st.final));
      return;
    }
  });
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const st = fileParts(before);
    const found = findTier(b.oldLines, st.lines, 0, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const N: BodyItem[] = b.newLines.map((t) => ({ kind: 'new' as const, text: t, noNL: false, oIndex: -1 }));
    const repl = buildReplacement(N, st.lines, pos, found.tier, b.oldLines);
    st.lines.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinParts(st.lines, st.br, st.final));
  });
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  /** 1-based line of the section header, for parse errors. */
  lineNo: number;
}

function parseV4aSection(kind: 'add' | 'delete' | 'update', path: string, raw: Array<{ text: string; no: number }>, lineNo: number): V4aSection {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
      else if (r.text === '') addLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return { kind, path, moveTo: null, addLines, chunks: [], lineNo };
  }
  if (kind === 'delete') {
    for (const r of raw) {
      if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
    }
    return { kind, path, moveTo: null, addLines: [], chunks: [], lineNo };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const l = r.text;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length === 0) cur = { anchor: null, eof: false, items: [] };
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const k = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
      cur.items.push({ kind: k, text: l === '' ? '' : l.slice(1), noNL: false, oIndex: -1 });
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
  return { kind, path, moveTo, addLines: [], chunks, lineNo };
}

function parseV4a(lines: string[]): V4aSection[] {
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
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    }
    i++;
    const raw: Array<{ text: string; no: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l)) break;
      if (l.trim() === '*** End Patch') break;
      raw.push({ text: l, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push(parseV4aSection(kind, path, raw, startLine + 1));
  }
  return sections;
}

/** Apply one V4A chunk; returns the cursor just after the lines written. */
function applyV4aChunk(st: FileParts, chunk: V4aChunk, path: string, strict: boolean, cursor: number): number {
  if (chunk.anchor !== null && chunk.anchor !== '') {
    let foundAt = -1;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      const norm = t === 0 ? (s: string): string => s : t === 1 ? trimEndWS : trimWS;
      const want = norm(chunk.anchor);
      for (let i = cursor; i < st.lines.length; i++) {
        if (norm(st.lines[i]!) === want) {
          foundAt = i;
          break;
        }
      }
      if (foundAt >= 0) break;
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cursor = foundAt + 1;
  }
  const { O, N } = splitBody(chunk.items);
  if (O.length === 0) {
    const at = chunk.eof ? st.lines.length : cursor;
    st.lines.splice(at, 0, ...N.map((e) => e.text));
    return at + N.length;
  }
  const found = findTier(O, st.lines, cursor, strict);
  if (!found) throw new Fail('no-match', path);
  let pos = found.positions[0]!;
  if (chunk.eof) {
    const ok = found.positions.filter((p) => p + O.length === st.lines.length);
    if (ok.length === 0) throw new Fail('no-match', path);
    pos = ok[0]!;
  }
  const repl = buildReplacement(N, st.lines, pos, found.tier, O);
  st.lines.splice(pos, O.length, ...repl);
  return pos + repl.length;
}

function v4aEdits(sections: V4aSection[], strict: boolean): Edit[] {
  return sections.map((sec) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const st = fileParts(before);
    let cursor = 0;
    for (const ch of sec.chunks) cursor = applyV4aChunk(st, ch, sec.path, strict, cursor);
    const out = joinParts(st.lines, st.br, st.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.recordMove(sec.path, sec.moveTo);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

// ---- running (SPEC.md sections 1, 2 and 10) ----

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
          ? unifiedEdits(parseUnified(lines), strict)
          : kind === 'search-replace'
            ? srEdits(parseSearchReplace(lines), strict)
            : v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
