// textarea <-> Y.Text binding.
//
//   const editor = createEditor({ doc, ytext, textarea, net, maxTextChars, toast });
//
// Invariant between events: mirror === ytext.toString() === textarea.value.
// Local typing flows textarea -> (splice) -> ytext with origin 'local'; everything else
// (remote updates, 'ui' edits, UndoManager) flows ytext -> textarea through the observer, applied
// per delta segment with setRangeText so the caret, selection and scroll position only ever move
// by the exact amount of text inserted or deleted before them.
import * as Y from './vendor/yjs.js';
import { splice, shiftSelection } from './textdiff.js';

const DESKTOP_MQ = '(hover: hover) and (pointer: fine)';

export function createEditor({ doc, ytext, textarea: ta, net, maxTextChars = Infinity, toast = () => {} }) {
  if (!doc || !ytext || !ta) throw new Error('createEditor: doc, ytext and textarea are required');
  const limit = Number.isFinite(maxTextChars) && maxTextChars > 0 ? maxTextChars : Infinity;
  const remoteClearHandlers = new Set();
  // A textarea's value can never contain '\r' (browsers normalise newlines), so any '\r' in the doc would break the
  // mirror === textarea invariant forever. Strip it at every entry point; whichever device sees one first converges the doc.
  function normalizeCR() {
    const s = ytext.toString();
    if (!s.includes('\r')) return false;
    doc.transact(() => {
      for (let i = s.length - 1; i >= 0; i--) {
        if (s.charCodeAt(i) !== 13) continue;
        ytext.delete(i, 1);
        if (s.charCodeAt(i + 1) !== 10) ytext.insert(i, '\n');
      }
    }, 'norm');
    return true;
  }
  normalizeCR();
  const flushPending = net && typeof net.flushPending === 'function' ? () => net.flushPending() : () => {};

  // Initial paint: the only direct .value write in normal operation.
  let mirror = ytext.toString();
  ta.value = mirror;

  let composing = false;
  const changeListeners = new Set();

  // Only this device's edits are undoable. Remote updates (origin 'remote') and the localStorage
  // restore ('load') are not tracked, so Ctrl+Z never touches the other device's text.
  const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set(['local', 'ui']), captureTimeout: 500 });

  function notify() {
    for (const fn of Array.from(changeListeners)) {
      try { fn(); } catch (err) { console.error('editor: change listener failed', err); }
    }
  }

  // ---------- local -> doc ----------
  ta.addEventListener('input', () => {
    const value = ta.value;
    const { index, remove, insert } = splice(mirror, value, ta.selectionStart);
    if (value.length > limit && value.length > mirror.length) {
      // Reject the edit outright: put the old text back and the caret where the edit was attempted.
      ta.value = mirror;
      const c = Math.min(index, mirror.length);
      try { ta.setSelectionRange(c, c); } catch { /* ignore */ }
      toast('Text too large');
      return;
    }
    if (!remove && !insert) return;
    doc.transact(() => {
      if (remove) ytext.delete(index, remove);
      if (insert) ytext.insert(index, insert);
    }, 'local');
    mirror = value;
  });

  // Caret placement after undo/redo: end of the first insert, else the (first) delete position.
  function caretAfterHistory(delta) {
    let pos = 0;
    for (const op of delta) {
      if (op.retain != null) pos += op.retain;
      else if (op.insert != null) return pos + (typeof op.insert === 'string' ? op.insert.length : 0);
      else if (op.delete != null) return pos;
    }
    return pos;
  }

  // ---------- doc -> DOM (everything that did not come from this textarea) ----------
  ytext.observe((ev, tr) => {
    if (tr.origin === 'local') { notify(); return; }
    if (tr.origin === 'norm') { mirror = ytext.toString(); notify(); return; }   // DOM is repainted by the caller
    const delta = ev.delta;
    const prevText = mirror;
    const wholeDelete = tr.origin === 'remote' && prevText.length > 0 && delta.length === 1 && delta[0].delete === prevText.length;
    const focused = document.activeElement === ta;
    const [s, e] = shiftSelection(ta.selectionStart, ta.selectionEnd, delta);
    const top = ta.scrollTop;
    let pos = 0;
    for (const op of delta) {
      if (op.retain != null) pos += op.retain;
      else if (op.insert != null) {
        const str = typeof op.insert === 'string' ? op.insert : '';
        ta.setRangeText(str, pos, pos, 'preserve');
        pos += str.length;
      } else if (op.delete != null) {
        ta.setRangeText('', pos, pos + op.delete, 'preserve');
      }
    }
    if (tr.origin === undo) {
      // Undo/redo came from this device: put the caret where the change happened, focused or not.
      const c = caretAfterHistory(delta);
      try { ta.setSelectionRange(c, c); } catch { /* ignore */ }
    } else if (focused) {
      ta.setSelectionRange(s, e);
    }
    ta.scrollTop = top;
    mirror = ytext.toString();
    if (mirror.includes('\r')) normalizeCR();
    mirror = ytext.toString();
    if (ta.value !== mirror) {                          // divergence guard (CR normalisation lands here by design)
      ta.value = mirror;
      if (focused) { try { ta.setSelectionRange(Math.min(s, mirror.length), Math.min(e, mirror.length)); } catch { /* ignore */ } }
    }
    if (wholeDelete) for (const fn of remoteClearHandlers) { try { fn(prevText); } catch (err) { console.warn('editor: remote-clear handler threw', err); } }
    notify();
  });

  // ---------- IME / composition ----------
  // Remote updates are queued at the network layer while composing (net checks editor.composing);
  // flushing after a setTimeout(0) lets a trailing `input` event land first in browsers that fire it
  // after compositionend, so the splice sees the final composed text.
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; setTimeout(flushPending, 0); });
  ta.addEventListener('blur', () => { composing = false; flushPending(); });

  // ---------- undo / redo ----------
  function doUndo() { undo.undo(); }
  function doRedo() { undo.redo(); }
  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    if (key === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    else if (key === 'y' && e.ctrlKey && !e.shiftKey) { e.preventDefault(); doRedo(); }
  });
  ta.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo') { e.preventDefault(); doUndo(); }
    else if (e.inputType === 'historyRedo') { e.preventDefault(); doRedo(); }
  });

  // ---------- programmatic local edits (origin 'ui': rendered via the observer, undoable) ----------
  // Each is its own undo step: stopCapturing() before and after prevents the 500 ms capture
  // window from merging it with typing on either side.
  function uiTransact(fn) {
    undo.stopCapturing();
    doc.transact(fn, 'ui');
    undo.stopCapturing();
  }

  function clear() {
    const text = ytext.toString();
    if (text.length === 0) return '';
    uiTransact(() => ytext.delete(0, ytext.length));
    return text;
  }

  function insertAtCaret(text) {
    if (typeof text !== 'string' || text.length === 0) return;
    text = text.replace(/\r\n?/g, '\n');
    const index = Math.max(0, Math.min(ta.selectionStart, ytext.length));
    if (ytext.length + text.length > limit) { toast('Text too large'); return; }
    uiTransact(() => ytext.insert(index, text));
    const c = index + text.length;
    try { ta.setSelectionRange(c, c); } catch { /* ignore */ }
  }

  function append(text) {
    if (typeof text !== 'string' || text.length === 0) return;
    text = text.replace(/\r\n?/g, '\n');
    const current = ytext.toString();
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    const ins = prefix + text;
    if (current.length + ins.length > limit) { toast('Text too large'); return; }
    uiTransact(() => ytext.insert(ytext.length, ins));
  }

  // ---------- clipboard ----------
  // navigator.clipboard needs a secure context; the execCommand fallback covers http://LAN-IP and
  // older iOS Safari. Selection is restored after the fallback.
  async function copyAll() {
    const text = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    try {
      if (!navigator.clipboard) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        ta.focus();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        ta.setSelectionRange(s, e);
        return !!ok;
      } catch {
        return false;
      }
    }
  }

  function focusDesktop() {
    let desktop = false;
    try { desktop = window.matchMedia(DESKTOP_MQ).matches; } catch { desktop = false; }
    if (!desktop) return;
    try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
  }

  // Fires when ANOTHER device wiped the whole box (prevText = what was there), so this UI can offer Undo too.
  function onRemoteClear(fn) { remoteClearHandlers.add(fn); return () => remoteClearHandlers.delete(fn); }
  // Put text back after a remote clear: at the start if the box is empty, otherwise appended.
  function restoreText(text) {
    if (typeof text !== 'string' || !text) return;
    text = text.replace(/\r\n?/g, '\n');
    if (ytext.length === 0) { if (text.length > limit) { toast('Text too large'); return; } uiTransact(() => ytext.insert(0, text)); }
    else append(text);
  }

  return {
    onRemoteClear,
    restoreText,
    get composing() { return composing; },
    undo: doUndo,
    redo: doRedo,
    undoManager: undo,
    clear,
    insertAtCaret,
    append,
    copyAll,
    getText: () => ytext.toString(),
    onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
    focusDesktop,
  };
}
