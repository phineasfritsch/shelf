// Live presence overlay for the shared textarea: remote carets, selection bands, label chips, and a
// "typing…" hint next to the peers badge.
//
//   const presence = createPresence({ textarea, net, typingHint });
//
// This module ONLY renders OTHER devices' carets, delivered as net 'presence' / 'presence-gone'
// events. Sending this device's own caret is wired in app.js via net.sendPresence().
//
// It is PURELY ADDITIVE: it never reads or writes the textarea's value, selection, scroll, or focus —
// it only reads geometry (value length, scrollTop/Left, clientWidth, getComputedStyle, getBoundingRect).
// A <textarea> cannot style ranges, so offsets are turned into pixels with the classic mirror-div
// technique (see the well-known textarea-caret-position approach): a hidden div is styled to wrap text
// exactly like the textarea, the text up to the offset is copied in, and a marker span's
// offsetLeft/offsetTop give the caret coordinates. If any measurement fails we draw nothing.

const CHIP_FADE_MS = 2200;      // the label chip fades this long after a caret last moved
const TYPING_CLEAR_MS = 1500;   // a peer's typing flag self-clears if no fresh typing:true arrives
const HINT_FADE_MS = 300;       // must match the CSS opacity transition on .typing-hint
const CHIP_FLIP_PX = 22;        // when a caret is within this many px of the top, put the chip BELOW it

// Text-layout properties copied to the mirror so it wraps EXACTLY like the textarea. Width, box-sizing
// and border are handled separately (see refreshMirrorStyle) to sidestep box-sizing/scrollbar pitfalls.
const MIRROR_PROPS = [
  'direction', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
  'fontFamily', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textTransform', 'textIndent',
  'textRendering', 'whiteSpace', 'overflowWrap', 'wordWrap', 'wordBreak', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
];

export function createPresence({ textarea: ta, net, typingHint = null } = {}) {
  if (!ta || !net) throw new Error('createPresence: textarea and net are required');

  let reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* default */ }

  // ---- overlay (covers the textarea's border box, clips anything scrolled out of view) ----
  const overlay = document.createElement('div');
  overlay.className = 'presence-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  const host = ta.parentNode;                     // .box — made position:relative in app.css
  if (host) host.insertBefore(overlay, ta.nextSibling);

  // ---- one reused, off-screen measurement mirror ----
  const mirror = document.createElement('div');
  mirror.className = 'presence-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  const marker = document.createElement('span');
  document.body.appendChild(mirror);

  // getComputedStyle returns a LIVE object, so a single reference tracks the textarea's current values;
  // only the copied-into-the-mirror properties need an explicit refresh (on resize).
  const cs = getComputedStyle(ta);

  function refreshMirrorStyle() {
    for (const p of MIRROR_PROPS) { try { mirror.style[p] = cs[p]; } catch { /* unknown/ro prop */ } }
    mirror.style.whiteSpace = 'pre-wrap';         // a textarea always wraps; never let the mirror go nowrap
    mirror.style.boxSizing = 'content-box';
    mirror.style.border = '0';
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    // clientWidth = content + padding (excludes border AND any scrollbar). Setting the mirror's CONTENT
    // width to clientWidth - padding makes it wrap at the same column as the textarea regardless of
    // box-sizing or a visible scrollbar.
    mirror.style.width = Math.max(0, ta.clientWidth - padL - padR) + 'px';
  }
  refreshMirrorStyle();

  // Turn a character offset into { top, left, height } relative to the textarea's border-box top-left,
  // BEFORE scroll is subtracted. Throws only if the DOM is in an unexpected state; callers guard it.
  function measure(offset) {
    const value = ta.value;
    const pos = Math.max(0, Math.min(offset, value.length));
    mirror.textContent = value.slice(0, pos);
    marker.textContent = value.slice(pos) || '.';  // a non-empty tail so an end/trailing-newline caret still lays out
    mirror.appendChild(marker);
    const bTop = parseFloat(cs.borderTopWidth) || 0;
    const bLeft = parseFloat(cs.borderLeftWidth) || 0;
    // The mirror has no border but the same padding; offsetTop/Left are relative to the mirror's border
    // edge (which coincides with its padding edge here), so adding the textarea's border width converts
    // them into the textarea's border-box coordinate space.
    const top = marker.offsetTop + bTop;
    const left = marker.offsetLeft + bLeft;
    const height = parseFloat(cs.lineHeight) || Math.round((parseFloat(cs.fontSize) || 16) * 1.5);
    mirror.removeChild(marker);                    // keep the mirror clean for the next measurement
    return { top, left, height };
  }

  // Text content bounds (in the same pre-scroll coordinate space measure() returns), for full-width bands.
  function contentBounds() {
    const bLeft = parseFloat(cs.borderLeftWidth) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const left = bLeft + padL;
    return { left, right: left + Math.max(0, ta.clientWidth - padL - padR) };
  }

  // ---- overlay box sync (position/size the overlay exactly over the textarea's border box) ----
  function syncOverlayBox() {
    if (!host) return;
    const tr = ta.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    // host (.box) has no border/padding, so its client rect origin is its padding-box origin — which is
    // what an absolutely-positioned child is offset from.
    overlay.style.left = (tr.left - hr.left) + 'px';
    overlay.style.top = (tr.top - hr.top) + 'px';
    overlay.style.width = tr.width + 'px';
    overlay.style.height = tr.height + 'px';
  }

  // ---- peers: cid -> { color, label, a, h, typing, root, caret, chip, bands[], chipTimer, typingTimer } ----
  const peers = new Map();

  function createPeer(cid) {
    const root = document.createElement('div');
    root.className = 'presence-peer';
    const bands = [];
    for (let i = 0; i < 3; i++) {                  // at most first-line / middle / last-line bands
      const b = document.createElement('div');
      b.className = 'presence-band';
      b.hidden = true;
      bands.push(b);
      root.appendChild(b);
    }
    const caret = document.createElement('div');
    caret.className = 'presence-caret';
    caret.hidden = true;
    const chip = document.createElement('div');
    chip.className = 'presence-chip presence-chip--hidden';
    root.appendChild(caret);
    root.appendChild(chip);
    overlay.appendChild(root);
    return { cid, color: '#888', label: 'A device', a: 0, h: 0, typing: false, root, caret, chip, bands, chipTimer: 0, typingTimer: 0 };
  }

  function applyColor(p) {
    p.caret.style.background = p.color;
    p.chip.style.background = p.color;
    p.chip.textContent = p.label;
    for (const b of p.bands) b.style.background = p.color;
  }

  // Show the label chip and (re)arm its fade — called on every update, so a chip that keeps moving stays lit.
  function showChip(p) {
    p.chip.classList.remove('presence-chip--hidden');
    if (p.chipTimer) clearTimeout(p.chipTimer);
    p.chipTimer = setTimeout(() => { p.chip.classList.add('presence-chip--hidden'); p.chipTimer = 0; }, CHIP_FADE_MS);
  }

  function hidePeer(p) {
    p.caret.hidden = true;
    for (const b of p.bands) b.hidden = true;
  }

  // ---- rendering (coalesced to one rAF; positions every peer against the current scroll) ----
  let rafId = 0;
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(render);
  }
  function render() {
    rafId = 0;
    if (peers.size === 0) return;
    syncOverlayBox();
    const scrollTop = ta.scrollTop;
    const scrollLeft = ta.scrollLeft;
    for (const p of peers.values()) positionPeer(p, scrollTop, scrollLeft);
  }

  function positionPeer(p, scrollTop, scrollLeft) {
    let hCoord, aCoord;
    try {
      hCoord = measure(p.h);
      aCoord = (p.a === p.h) ? hCoord : measure(p.a);
    } catch {
      hidePeer(p);                                 // measurement failed: draw nothing, never touch the textarea
      return;
    }
    // Caret bar at the head position.
    const cx = hCoord.left - scrollLeft;
    const cy = hCoord.top - scrollTop;
    p.caret.style.left = cx + 'px';
    p.caret.style.top = cy + 'px';
    p.caret.style.height = hCoord.height + 'px';
    p.caret.hidden = false;
    positionChip(p, cx, cy, hCoord.height);
    // Selection band(s) when the range is not collapsed.
    if (p.a === p.h) { for (const b of p.bands) b.hidden = true; return; }
    drawBands(p, aCoord, hCoord, scrollTop, scrollLeft);
  }

  function positionChip(p, cx, cy, caretH) {
    p.chip.style.left = cx + 'px';
    if (cy < CHIP_FLIP_PX) {                        // near the top edge: below the caret so it isn't clipped
      p.chip.classList.add('presence-chip--below');
      p.chip.style.top = (cy + caretH + 3) + 'px';
    } else {
      p.chip.classList.remove('presence-chip--below');
      p.chip.style.top = cy + 'px';                 // CSS translateY lifts it just above the caret
    }
  }

  // A selection can span lines: draw a band on the first line (from anchor to the content right edge),
  // an optional full-width band across whole middle lines, and a band on the last line (to the head).
  function drawBands(p, c1, c2, scrollTop, scrollLeft) {
    let start = c1, end = c2;
    if (c1.top > c2.top || (c1.top === c2.top && c1.left > c2.left)) { start = c2; end = c1; }
    const { left: cLeft, right: cRight } = contentBounds();
    const rects = [];
    if (start.top === end.top) {
      rects.push({ left: start.left, top: start.top, width: Math.max(1, end.left - start.left), height: start.height });
    } else {
      rects.push({ left: start.left, top: start.top, width: Math.max(1, cRight - start.left), height: start.height });
      const midTop = start.top + start.height;
      if (end.top - midTop > 0.5) rects.push({ left: cLeft, top: midTop, width: Math.max(1, cRight - cLeft), height: end.top - midTop });
      rects.push({ left: cLeft, top: end.top, width: Math.max(1, end.left - cLeft), height: end.height });
    }
    for (let i = 0; i < p.bands.length; i++) {
      const b = p.bands[i];
      const r = rects[i];
      if (!r) { b.hidden = true; continue; }
      b.style.left = (r.left - scrollLeft) + 'px';
      b.style.top = (r.top - scrollTop) + 'px';
      b.style.width = r.width + 'px';
      b.style.height = r.height + 'px';
      b.hidden = false;
    }
  }

  // ---- "typing…" hint (shown while any remote peer is typing) ----
  let hintOn = false, hintHideTimer = 0;
  function setHint(on) {
    if (!typingHint || on === hintOn) return;
    hintOn = on;
    if (on) {
      if (hintHideTimer) { clearTimeout(hintHideTimer); hintHideTimer = 0; }
      typingHint.hidden = false;
      requestAnimationFrame(() => { if (hintOn) typingHint.classList.add('typing-hint--on'); });
    } else {
      typingHint.classList.remove('typing-hint--on');
      if (reduceMotion) { typingHint.hidden = true; }
      else { hintHideTimer = setTimeout(() => { if (!hintOn) typingHint.hidden = true; hintHideTimer = 0; }, HINT_FADE_MS); }
    }
  }
  function updateTypingHint() {
    let any = false;
    for (const p of peers.values()) { if (p.typing) { any = true; break; } }
    setHint(any);
  }

  // ---- net events ----
  net.on('presence', ({ cid, color, label, a, h, typing }) => {
    let p = peers.get(cid);
    if (!p) { p = createPeer(cid); peers.set(cid, p); }
    p.color = color; p.label = label; p.a = a; p.h = h; p.typing = typing;
    applyColor(p);
    showChip(p);
    if (p.typingTimer) { clearTimeout(p.typingTimer); p.typingTimer = 0; }
    // Guard against a lost typing:false frame: a peer's typing state expires on its own.
    if (typing) p.typingTimer = setTimeout(() => { p.typing = false; p.typingTimer = 0; updateTypingHint(); }, TYPING_CLEAR_MS);
    updateTypingHint();
    scheduleRender();
  });

  net.on('presence-gone', ({ cid }) => {
    const p = peers.get(cid);
    if (!p) return;
    if (p.chipTimer) clearTimeout(p.chipTimer);
    if (p.typingTimer) clearTimeout(p.typingTimer);
    if (p.root.parentNode) p.root.parentNode.removeChild(p.root);
    peers.delete(cid);
    updateTypingHint();
    scheduleRender();
  });

  // A remote text edit shifts every offset's pixel position; re-render so carets track the new layout.
  net.on('remote', scheduleRender);

  // ---- keep the overlay/carets in sync with scroll and resize ----
  ta.addEventListener('scroll', scheduleRender, { passive: true });
  ta.addEventListener('input', scheduleRender);   // local edits also move remote carets' pixel positions
  function onResize() { refreshMirrorStyle(); scheduleRender(); }
  window.addEventListener('resize', onResize);
  let ro = null;
  try { ro = new ResizeObserver(onResize); ro.observe(ta); } catch { /* no ResizeObserver: window resize still covers it */ }

  return {
    // Drop every remote caret (e.g. on logout). Purely visual; touches nothing on the textarea.
    clear() {
      for (const p of peers.values()) {
        if (p.chipTimer) clearTimeout(p.chipTimer);
        if (p.typingTimer) clearTimeout(p.typingTimer);
        if (p.root.parentNode) p.root.parentNode.removeChild(p.root);
      }
      peers.clear();
      updateTypingHint();
    },
    get peerCount() { return peers.size; },
  };
}
