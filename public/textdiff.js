// Pure text helpers shared by the editor binding. No DOM, no imports: importable from node for tests.
//
//   splice(oldS, newS, caret)        -> { index, remove, insert }  minimal edit turning oldS into newS
//   shiftSelection(s, e, delta)      -> [s, e]  selection moved across a Y.Text delta
//   findUrls(text, max = 20)         -> string[] http(s) URLs found in text, deduped, in order

// Compute the single contiguous edit that turns `oldS` into `newS`.
// `caret` (the caret position in newS after the edit) bounds the common prefix so that
// 'aa' -> 'aaa' with the caret at 2 yields index 2 (the character was typed there), not index 0/1.
// Never splits a UTF-16 surrogate pair: the edit is widened to include the whole pair.
export function splice(oldS, newS, caret = newS.length) {
  const oldLen = oldS.length, newLen = newS.length, minLen = Math.min(oldLen, newLen);
  let p = 0; const pMax = Math.min(minLen, caret);
  while (p < pMax && oldS.charCodeAt(p) === newS.charCodeAt(p)) p++;
  let s = 0; const sMax = minLen - p;
  while (s < sMax && oldS.charCodeAt(oldLen - 1 - s) === newS.charCodeAt(newLen - 1 - s)) s++;
  const hi = c => c >= 0xd800 && c <= 0xdbff, lo = c => c >= 0xdc00 && c <= 0xdfff;
  if (p > 0 && hi(oldS.charCodeAt(p - 1))) p--;              // never split a surrogate pair
  if (s > 0 && lo(newS.charCodeAt(newLen - s))) s--;
  return { index: p, remove: oldLen - p - s, insert: newS.slice(p, newLen - s) };
}

// Shift a selection [s,e] across a Y.Text delta ({retain}|{insert:string}|{delete:n}).
// Positions in the delta are expressed against the document *before* the change, so `pos`
// walks the old text while s/e are updated to their positions in the new text.
export function shiftSelection(s, e, delta) {
  const collapsed = s === e; let pos = 0;
  for (const op of delta) {
    if (op.retain != null) { pos += op.retain; continue; }
    if (op.insert != null) {
      const n = op.insert.length;
      if (pos <= s) s += n;                                   // remote insert at the caret lands BEFORE it
      if (pos < e || (collapsed && pos <= e)) e += n;         // a selection's end does not swallow remote text
      pos += n; continue;
    }
    if (op.delete != null) {
      const n = op.delete;
      if (pos < s) s -= Math.min(n, s - pos);
      if (pos < e) e -= Math.min(n, e - pos);
    }
  }
  return [s, e];
}

// Characters that end a URL when they appear last: sentence punctuation and quotes.
const TRAILING = '.,;:!?\'"';
// Closing brackets are trimmed only when unbalanced, so https://en.wikipedia.org/wiki/Foo_(bar) survives.
const BRACKETS = { ')': '(', ']': '[', '}': '{' };
// Characters that can never be part of a URL in running text (beyond whitespace, which \S excludes).
const STOP = '<>"\'`';

function count(str, ch) {
  let n = 0;
  for (let i = 0; i < str.length; i++) if (str[i] === ch) n++;
  return n;
}

// Cut a \S+ run at the first character that cannot belong to a URL (quotes, angle brackets, C0/DEL controls).
function cutAtStop(run) {
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || STOP.includes(run[i])) return run.slice(0, i);
  }
  return run;
}

// Every http(s) URL in `text`, first-occurrence order, deduplicated, at most `max` entries.
export function findUrls(text, max = 20) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0 || max <= 0) return out;
  const seen = new Set();
  // A fresh regex per call: a shared /g regex would carry lastIndex state between calls.
  const re = /https?:\/\/\S+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let u = cutAtStop(m[0]);
    for (;;) {
      const last = u[u.length - 1];
      if (TRAILING.includes(last)) { u = u.slice(0, -1); continue; }
      const open = BRACKETS[last];
      if (open && count(u, open) < count(u, last)) { u = u.slice(0, -1); continue; }
      break;
    }
    if (!/^https?:\/\/[^/]/i.test(u)) continue;      // bare scheme with nothing after it
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}
