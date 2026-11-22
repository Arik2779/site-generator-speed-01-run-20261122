// A fast, dependency-free reimplementation of makefun-site 1.0.0's build.
// Written fresh in this session from the README spec in the kit; the vendor
// code was read only as the behavioral reference. No vendor code is copied:
// the structure, the scanners and the renderers below are my own.
//
// Speed comes from: a single-pass Markdown scanner over the source's lines
// (no token array, no per-line regex chain, no per-character escaping);
// templates compiled once per case into a node tree and rendered with a flat
// scope object that for-loops mutate and restore (no scope chain to walk, no
// object allocated per loop element); output built in chunk arrays joined
// once; slug/date results memoized per case (never across cases).

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ escaping

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `s` with & < > " ' escaped. */
function escStr(s) {
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** `s[a..b)` escaped, pushed as one chunk into `out`. */
function escPush(s, a, b, out) {
  if (a < b) out.push(s.slice(a, b).replace(ESC_RE, (c) => ESCAPES[c]));
}

// ------------------------------------------------------------------ text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The slug of `text` (NFKD, combining marks dropped, runs of non [a-z0-9] to one '-', cut to 64, 'untitled' when empty). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const buf = [];
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      gap = buf.length > 0;
      continue;
    }
    if (gap) buf.push('-');
    gap = false;
    buf.push(String.fromCharCode(keep));
  }
  let s = buf.join('');
  if (s.length > 64) s = s.slice(0, 64);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 45) end--;
  if (end < s.length) s = s.slice(0, end);
  if (s === '') s = 'untitled';
  cache.set(text, s);
  return s;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, v);
  return v;
}

// ------------------------------------------------------------------ front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** One key's value, or why it is refused (error already carries the `key "x": ` prefix where it applies). */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // a slug may not open on '-', and never holds '--'
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else ok = false;
      }
      if (prevDash) ok = false; // trailing '-'
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter: { data, lines, close } (lines are the source's lines, close the index of the closing
 * '---'), or { error } with the first refusal reason. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e < raw.length) raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, close };
}

// ------------------------------------------------------------------ line classifiers

/** Only spaces/tabs (or empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Spaces/tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** JavaScript \s (needed for the list-continuation rule). */
function isWS(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 5760 || (code >= 8192 && code <= 8202) ||
    code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence-open line: its language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** A fence-close line. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line: { depth, text }, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** A thematic-break line: '---' or '***', then spaces/tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text (after '- ' or '* '), or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item: { num, text }, or null. */
function orderedOf(line) {
  let i = 0;
  let num = 0;
  let digits = 0;
  while (i < line.length && digits < 9) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) { num = num * 10 + (c - 48); digits++; i++; }
    else break;
  }
  if (digits === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num, text: line.slice(i + 2) };
}

/** A list continuation: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWS(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

// ------------------------------------------------------------------ inline Markdown

const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;
const isEscapable = (code) => code < 128 && ESCAPABLE[code] === 1;
const WS_RE = /\s/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j + wl <= end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const SPEC_RE = /[\\`*[]/g;

/** The next index at or after `i` (before `end`) holding \ ` * or [, or `end`. */
function nextSpecial(s, i, end) {
  SPEC_RE.lastIndex = i;
  const m = SPEC_RE.exec(s);
  if (m === null || m.index >= end) return end;
  return m.index;
}

/** `s[start..end)` rendered inline into `out`; `env.link(target)` is a link's href. */
function inlineStr(s, start, end, env, out) {
  let i = start;
  while (i < end) {
    const j = nextSpecial(s, i, end);
    if (j > i) escPush(s, i, j, out);
    if (j >= end) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < end && isEscapable(s.charCodeAt(j + 1))) { out.push(s[j + 1]); i = j + 2; }
      else { out.push('\\'); i = j + 1; }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        out.push('<code>');
        escPush(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, end);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>');
          inlineStr(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, end);
        if (k !== -1 && k > j + 1) {
          out.push('<em>');
          inlineStr(s, j + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, end);
    let m = -1;
    if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) {
      const r = s.indexOf(')', k + 2);
      if (r !== -1 && r < end) m = r;
    }
    if (m !== -1) {
      const target = s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="');
        out.push(escStr(env.link(target)));
        out.push('">');
        inlineStr(s, j + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
    }
    out.push('[');
    i = j + 1;
  }
}

// ------------------------------------------------------------------ block Markdown

/**
 * `lines` rendered: its HTML (each block followed by "\n"), its table of contents (level 2 and 3 headings:
 * level, id and inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderBody(lines, env, S) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let hasExcerpt = false;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      out.push(`<pre><code${lang === '' ? '' : ` class="language-${escStr(lang)}"`}>`);
      while (i < n && !fenceClose(lines[i])) {
        escPush(lines[i], 0, lines[i].length, out);
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, S.slugCache), ids);
      if (hd.depth === 2 || hd.depth === 3) {
        const inner = [];
        inlineStr(hd.text, 0, hd.text.length, env, inner);
        const html = inner.join('');
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        toc.push({ level: hd.depth, id, html });
      } else {
        out.push(`<h${hd.depth} id="${id}">`);
        inlineStr(hd.text, 0, hd.text.length, env, out);
        out.push(`</h${hd.depth}>\n`);
      }
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const q = lines[i];
        const t = trimLine(q.charCodeAt(1) === 32 ? q.slice(2) : q.slice(1));
        if (t !== '') parts.push(t);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = parts.join('\n');
        out.push('<blockquote>\n<p>');
        inlineStr(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = o.num;
      else items.push(trimLine(b));
      if (isOrdered) items.push(trimLine(o.text));
      i++;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push(trimLine(m.text)); i++; continue; }
        } else {
          const m = bulletOf(l);
          if (m !== null) { items.push(trimLine(m)); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1] += `\n${trimLine(l)}`; i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const item of items) {
        out.push('<li>');
        inlineStr(item, 0, item.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const plines = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) { plines.push(trimLine(lines[i])); i++; }
    const text = plines.join('\n');
    if (!hasExcerpt) {
      const inner = [];
      inlineStr(text, 0, text.length, env, inner);
      excerpt = inner.join('');
      hasExcerpt = true;
      out.push(`<p>${excerpt}</p>\n`);
    } else {
      out.push('<p>');
      inlineStr(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt };
}

// ------------------------------------------------------------------ templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Only spaces/tabs in `s[a..b)`. */
function onlySpaces(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }} / {{{ }}} and {% %}; a standalone tag's line is taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) { text += src.slice(i); break; }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include, 6 root.
/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 6, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push({ k: 0, s: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 4, name: m[1], p: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 3, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.k !== 3 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 6 ? parent.body : parent.k === 4 ? parent.body : (parent.els !== null ? parent.els : parent.then);
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ k: 5, name: m[1] });
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the flat scope `vars`: its first name an own property, then own properties. */
function lookup(vars, path) {
  let v = Object.hasOwn(vars, path[0]) ? vars[path[0]] : undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out`, in the flat scope `vars` (for-loops bind and restore on it). */
function renderNodes(nodes, vars, templates, depth, out) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    switch (nd.k) {
      case 0:
        out.push(nd.s);
        break;
      case 1: {
        const v = textOf(lookup(vars, nd.p));
        if (v !== '') out.push(escStr(v));
        break;
      }
      case 2: {
        const v = textOf(lookup(vars, nd.p));
        if (v !== '') out.push(v);
        break;
      }
      case 3: {
        const v = truthy(lookup(vars, nd.p));
        const br = v !== nd.not ? nd.then : nd.els;
        if (br !== null) renderNodes(br, vars, templates, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(vars, nd.p);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const name = nd.name;
        const hadName = Object.hasOwn(vars, name);
        const oldName = vars[name];
        const hadLoop = Object.hasOwn(vars, 'loop');
        const oldLoop = vars.loop;
        for (let k = 0; k < len; k++) {
          if (name === '__proto__') Object.defineProperty(vars, name, { value: xs[k], writable: true, enumerable: true, configurable: true });
          else vars[name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderNodes(nd.body, vars, templates, depth, out);
        }
        if (hadName) {
          if (name === '__proto__') Object.defineProperty(vars, name, { value: oldName, writable: true, enumerable: true, configurable: true });
          else vars[name] = oldName;
        } else delete vars[name];
        if (hadLoop) vars.loop = oldLoop;
        else delete vars.loop;
        break;
      }
      case 5: {
        const t = templates.get(nd.name);
        if (t !== undefined && depth < 8) renderNodes(t, vars, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ the build

const RESERVED = ['posts', 'tags', 'page'];
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body: its runs of characters other than whitespace. Counted per line (a '\n' join is whitespace, so the sum is the same). */
function wordsOfLines(lines) {
  let n = 0;
  for (const line of lines) {
    let i = 0;
    const len = line.length;
    while (i < len) {
      while (i < len && isWS(line.charCodeAt(i))) i++;
      if (i >= len) break;
      n++;
      while (i < len && !isWS(line.charCodeAt(i))) i++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const S = { slugCache: new Map(), dateCache: new Map() };
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.lines.slice(fm.close + 1);
    s.post = s.path.startsWith('posts/');
    s.dir = dirOf(s.path);
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : s.dir;
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, S.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = s.dir;
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderBody(s.bodyLines, env, S);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slugify(name, S.slugCache);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, S.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, S.slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages through theirs.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, S.dateCache) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date, S.dateCache),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.bodyLines) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One scope object per case: the per-render values (page, posts, pager, tag) are assigned on it before each
  // render. A key holding undefined reads exactly like an absent key to every template lookup, and for-loops
  // save and restore whatever they shadow, so this is indistinguishable from a fresh scope per render.
  const scope = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, templates, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    scope.page = pageOf(s);
    scope.posts = undefined;
    scope.pager = undefined;
    scope.tag = undefined;
    output[`${s.outDir}/index.html`] = render(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    scope.page = undefined;
    scope.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    scope.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    scope.tag = undefined;
    const html = render('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    scope.page = undefined;
    scope.posts = undefined;
    scope.pager = undefined;
    scope.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  scope.page = undefined;
  scope.posts = undefined;
  scope.pager = undefined;
  scope.tag = undefined;
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
