// Claude Chat Navigator - Content Script v5
// Lists the Exchanges (question + answer) of a claude.ai conversation and jumps between them.

(function () {
  'use strict';

  const USER_MSG_SELECTOR = '[data-testid="user-message"]';

  // Fallback selectors if user-message ever changes
  const FALLBACK_SELECTORS = [
    '[data-testid="human-turn"]',
    '[data-testid="chat-message-user"]',
    '[data-role="user"]',
    '[data-author="human"]',
    '[data-message-author-role="user"]',
  ];

  // Containers holding Claude's visible reply text (thinking / tool blocks live elsewhere)
  const ANSWER_SELECTORS = [
    '.font-claude-response',
    '[data-testid="assistant-message"]',
    '[data-is-streaming]',
  ].join(', ');

  const TOP_GAP = 72;          // px between viewport top and a jumped-to Question (clears claude.ai's header)
  const TITLE_MAX = 80;
  const PREVIEW_MAX = 220;
  const UI_KEY = 'ccn.ui';

  // ── State ─────────────────────────────────────────────────────────────────
  let exchanges = [];          // in conversation order: { fp, text, title, offset, answer, preview, haystack }
  let scanned = false;
  let scanning = false;
  let scanId = 0;
  let scanProgress = 0;
  let scroller = null;
  let currentIdx = -1;
  let selectedIdx = -1;
  let shown = [];              // exchange indexes matching the current filter
  let query = '';
  let spyPausedUntil = 0;
  let jumping = false;
  let panel = null;
  let toggleBtn = null;
  let isOpen = false;
  let domObserver = null;
  let domTimer = null;
  let currentHighlight = null;
  let ui = loadUi();

  // ── Persistence (open state + width only; never conversation text) ────────
  function loadUi() {
    try {
      const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
      return { open: !!saved.open, width: Number(saved.width) || 380 };
    } catch (_) {
      return { open: false, width: 380 };
    }
  }

  function saveUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (_) { /* storage unavailable */ }
  }

  // ── Page helpers ──────────────────────────────────────────────────────────
  function isConversationPage() {
    return /^\/chat\/[^/]+/.test(location.pathname);
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function textOf(el) {
    return (el.innerText || '').trim();
  }

  function findScrollContainer() {
    const anchor = document.querySelector(USER_MSG_SELECTOR) ||
                   document.querySelector('[data-testid="chat-input"]');
    if (anchor) {
      let node = anchor.parentElement;
      while (node && node !== document.body) {
        if (node.scrollHeight > node.clientHeight + 50) {
          const overflow = window.getComputedStyle(node).overflowY;
          if (overflow === 'auto' || overflow === 'scroll') return node;
        }
        node = node.parentElement;
      }
    }
    let best = null, bestH = 0;
    for (const el of document.querySelectorAll('div, main, section')) {
      if (el.scrollHeight > el.clientHeight + 100) {
        const ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > bestH) {
          bestH = el.scrollHeight;
          best = el;
        }
      }
    }
    return best || document.documentElement;
  }

  function getScroller(refresh) {
    if (refresh || !scroller || !scroller.isConnected) scroller = findScrollContainer();
    return scroller;
  }

  function scrollerTop(sc) {
    return (sc === document.documentElement || sc === document.body) ? 0 : sc.getBoundingClientRect().top;
  }

  // Position of an element in the scroller's content coordinates
  function offsetOf(el, sc) {
    return sc.scrollTop + el.getBoundingClientRect().top - scrollerTop(sc);
  }

  function scanVisibleMessages() {
    let els = Array.from(document.querySelectorAll(USER_MSG_SELECTOR));
    if (!els.length) {
      for (const sel of FALLBACK_SELECTORS) {
        els = Array.from(document.querySelectorAll(sel));
        if (els.length) break;
      }
    }
    return els;
  }

  // ── Exchange building ─────────────────────────────────────────────────────
  function makeTitle(text) {
    const firstLine = (text.split('\n').find(l => l.trim()) || text).trim().replace(/\s+/g, ' ');
    if (firstLine.length <= TITLE_MAX) return firstLine;
    const sentence = firstLine.match(new RegExp('^(.{10,' + TITLE_MAX + '}?[.!?])(\\s|$)'));
    if (sentence) return sentence[1];
    const cut = firstLine.slice(0, TITLE_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…';
  }

  function makePreview(answer) {
    const flat = answer.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_MAX ? flat.slice(0, PREVIEW_MAX) + '…' : flat;
  }

  // Text of an Answer container without screen-reader-only copies, live regions and action buttons
  // (claude.ai embeds a hidden "Claude responded: …" copy of the reply inside it).
  const NOISE_SELECTOR = [
    '.sr-only', '[aria-live]', '[role="status"]', '[aria-hidden="true"]',
    '[data-testid="response-status-announcer"]', '[data-testid="message-actions"]', 'button',
  ].join(', ');

  function visibleText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(NOISE_SELECTOR).forEach(n => n.remove());
    clone.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6, pre, tr, br').forEach(n => n.after(' '));
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  // claude.ai prefixes each reply with hidden accessibility text ("Claude responded: ")
  function stripAnswerLabel(text) {
    return text.replace(/^\s*Claude responded:\s*/i, '');
  }

  // Claude's visible reply between this Question and the next one (if that one is in the DOM)
  function answerFor(qEl, nextEl) {
    const taken = [];
    for (const a of document.querySelectorAll(ANSWER_SELECTORS)) {
      if (!(qEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (qEl.contains(a)) continue;
      if (nextEl && !(nextEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      if (taken.some(t => t.contains(a))) continue;
      taken.push(a);
    }
    // Hidden accessibility copies of the reply (often just its first paragraph) sit beside the
    // real one; drop any part whose text is already contained in a longer part.
    // Compared with typographic quotes and spacing normalised: the hidden copy uses straight quotes.
    const norm = t => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
    const parts = taken.map(a => stripAnswerLabel(visibleText(a))).filter(Boolean);
    const normed = parts.map(norm);
    let text = parts
      .filter((p, i) => !normed.some((o, j) => j !== i &&
        (o.length > normed[i].length || (o.length === normed[i].length && j < i)) && o.includes(normed[i])))
      .join('\n\n');

    if (!text) {
      // No recognisable answer container: fall back to whatever text sits after the Question
      try {
        const range = document.createRange();
        range.setStartAfter(qEl);
        if (nextEl) {
          range.setEndBefore(nextEl);
        } else {
          const sc = getScroller(false);
          if (sc === document.documentElement || !sc.lastChild) return '';
          range.setEndAfter(sc.lastChild);
        }
        text = stripAnswerLabel(range.toString().trim());
      } catch (_) { text = ''; }
    }
    return text.slice(0, 20000);
  }

  // Pair every Question in the DOM with its known Exchange by order, not by pixel offset:
// claude.ai swaps estimated heights for real ones as messages render, so offsets drift.
  function matchVisible(els, sc) {
    const ms = [];
    for (const el of els) {
      const text = textOf(el);
      if (text) ms.push({ el, fp: text.slice(0, 80), text, offset: offsetOf(el, sc), idx: -1 });
    }
    const used = new Set();
    let prev = -1;
    for (const m of ms) {
      let idx = -1;
      const next = prev >= 0 ? prev + 1 : -1;
      if (next >= 0 && exchanges[next] && exchanges[next].fp === m.fp) {
        idx = next;
      } else {
        // First element of a run (or continuity broke): nearest Exchange with the same text
        let bestDist = Infinity;
        exchanges.forEach((e, i) => {
          if (e.fp !== m.fp || used.has(i)) return;
          const d = Math.abs(e.offset - m.offset);
          if (d < bestDist) { bestDist = d; idx = i; }
        });
        if (next >= 0 && idx >= 0 && idx <= prev) idx = -1;     // would go backwards: not the same message
      }
      if (idx >= 0) { used.add(idx); prev = idx; } else { prev = -1; }
      m.idx = idx;
    }
    return ms;
  }

  // Record every Question currently in the DOM. Returns what changed.
  function snapshot() {
    const sc = getScroller(false);
    const ms = matchVisible(scanVisibleMessages(), sc);
    const result = { added: 0, changed: false, midInsert: false };
    let prev = -1;      // index of the previous element's Exchange

    for (let k = 0; k < ms.length; k++) {
      const m = ms[k];
      if (m.idx < 0) {
        const atTail = ms.slice(k).every(x => x.idx < 0);
        const appended = atTail && prev >= 0 && prev === exchanges.length - 1;
        if (!scanning && !appended) { result.midInsert = true; continue; }   // edit / Branch switch: needs a re-Scan

        let pos = prev + 1;
        if (prev < 0) {
          const later = ms.slice(k).find(x => x.idx >= 0);
          pos = later ? later.idx : exchanges.length;
        }
        exchanges.splice(pos, 0, {
          fp: m.fp, text: m.text, title: makeTitle(m.text), offset: m.offset,
          answer: '', preview: '', haystack: '',
        });
        for (let j = k + 1; j < ms.length; j++) if (ms[j].idx >= pos) ms[j].idx++;
        m.idx = pos;
        result.added++;
      }

      const ex = exchanges[m.idx];
      prev = m.idx;
      ex.offset = m.offset;     // correct drift while we can see the real position

      const answer = answerFor(m.el, ms[k + 1] ? ms[k + 1].el : null);
      if (answer && answer !== ex.answer) {
        ex.answer = answer;
        ex.preview = makePreview(answer);
        result.changed = true;
      }
      ex.haystack = (ex.text + '\n' + ex.answer).toLowerCase();
    }
    return result;
  }

  // ── Scan: scroll the whole chat once, because claude.ai virtualises messages ──
  async function runScan() {
    if (scanning) return;
    scanning = true;
    const myScan = ++scanId;
    const stale = () => myScan !== scanId;   // navigated away mid-Scan
    exchanges = [];
    currentIdx = -1;
    selectedIdx = -1;
    scanProgress = 0;
    setStatus();
    renderList();

    const sc = getScroller(true);
    const savedScrollTop = sc.scrollTop;

    sc.scrollTop = 0;
    await wait(300);
    if (stale()) return;
    snapshot();
    renderList();

    const step = Math.max(300, sc.clientHeight * 0.7);
    let pos = 0;
    for (;;) {
      pos += step;
      sc.scrollTop = pos;
      await wait(180);
      if (stale()) return;
      snapshot();
      scanProgress = Math.min(1, pos / Math.max(sc.scrollHeight, 1));
      setStatus();
      renderList();
      if (pos + sc.clientHeight >= sc.scrollHeight) break;
    }

    sc.scrollTop = savedScrollTop;
    await wait(200);
    if (stale()) return;
    snapshot();
    if (!exchanges.length) {          // conversation may still be loading
      await wait(1000);
      if (stale()) return;
      snapshot();
    }

    scanned = true;
    scanning = false;
    setStatus();
    updateBadge();
    currentIdx = computeCurrent();
    renderList();
  }

  // ── Current Exchange (scroll-spy) ─────────────────────────────────────────
  function computeCurrent() {
    if (!exchanges.length) return -1;
    const sc = getScroller(false);
    if (sc.scrollHeight > sc.clientHeight + 50 &&
        sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) {
      return exchanges.length - 1;
    }
    const visible = matchVisible(scanVisibleMessages(), sc).filter(m => m.idx >= 0);
    if (visible.length) {
      const line = scrollerTop(sc) + TOP_GAP + 24;
      let cur = -1;
      for (const m of visible) {
        if (m.el.getBoundingClientRect().top <= line) cur = Math.max(cur, m.idx);
      }
      return cur >= 0 ? cur : Math.max(0, visible[0].idx - 1);   // its Question is scrolled out above
    }
    const ref = sc.scrollTop + TOP_GAP + 24;
    let idx = 0;
    for (let i = 0; i < exchanges.length; i++) if (exchanges[i].offset <= ref) idx = i;
    return idx;
  }

  function setCurrent(idx) {
    if (idx === currentIdx) return;
    currentIdx = idx;
    if (!panel) return;
    panel.querySelectorAll('.ccn-current').forEach(n => n.classList.remove('ccn-current'));
    const row = panel.querySelector(`.ccn-item[data-i="${idx}"]`);
    if (!row) return;
    row.classList.add('ccn-current');
    if (isOpen && !query && !panel.matches(':hover')) row.scrollIntoView({ block: 'nearest' });
  }

  let spyRaf = 0;
  function onScroll() {
    if (spyRaf || scanning || !exchanges.length || Date.now() < spyPausedUntil) return;
    spyRaf = requestAnimationFrame(() => {
      spyRaf = 0;
      setCurrent(computeCurrent());
    });
  }

  // ── Jump ──────────────────────────────────────────────────────────────────
  function highlight(el) {
    if (currentHighlight) currentHighlight.classList.remove('ccn-highlight');
    el.classList.add('ccn-highlight');
    currentHighlight = el;
    setTimeout(() => {
      el.classList.remove('ccn-highlight');
      if (currentHighlight === el) currentHighlight = null;
    }, 2500);
  }

  async function jumpTo(idx) {
    const ex = exchanges[idx];
    if (!ex) return;
    jumping = true;
    spyPausedUntil = Date.now() + 1500;
    selectedIdx = idx;
    setCurrent(idx);
    updateSelectionUi();

    try {
      const sc = getScroller(true);
      sc.scrollTop = Math.max(0, ex.offset - TOP_GAP);     // rough jump; stored offsets may have drifted

      // Walk toward the target until claude.ai has rendered it
      let el = null;
      for (let attempt = 0; attempt < 10 && !el; attempt++) {
        await wait(attempt ? 200 : 160);
        const visible = matchVisible(scanVisibleMessages(), sc).filter(m => m.idx >= 0);
        const hit = visible.find(m => m.idx === idx);
        if (hit) { el = hit.el; break; }
        if (visible.length) {
          sc.scrollTop += (idx < visible[0].idx ? -1 : 1) * sc.clientHeight * 0.8;
        }
      }
      if (!el) return;

      ex.offset = offsetOf(el, sc);
      const desired = Math.max(0, ex.offset - TOP_GAP);
      if (Math.abs(desired - sc.scrollTop) > 2) sc.scrollTo({ top: desired, behavior: 'smooth' });
      highlight(el);
      await wait(600);
    } finally {
      jumping = false;
    }
  }

  async function step(dir) {
    if (scanning) return;
    if (!scanned) await runScan();
    if (!exchanges.length) return;
    const from = currentIdx < 0 ? computeCurrent() : currentIdx;
    const target = Math.min(exchanges.length - 1, Math.max(0, from + dir));
    jumpTo(target);
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  function detectTheme() {
    const root = document.documentElement;
    const mode = root.getAttribute('data-mode') || root.getAttribute('data-theme');
    if (mode === 'dark' || mode === 'light') return mode;
    if (root.classList.contains('dark')) return 'dark';
    if (root.classList.contains('light')) return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = detectTheme();
    if (panel) panel.dataset.ccnTheme = theme;
    if (toggleBtn) toggleBtn.dataset.ccnTheme = theme;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // The part of the text around the first match, with the match marked
  function snippetHtml(ex, q) {
    const inTitle = ex.title.toLowerCase().includes(q);
    const source = ex.text.toLowerCase().includes(q) && !inTitle ? ex.text
                 : ex.answer.toLowerCase().includes(q) ? ex.answer
                 : null;
    if (!source || inTitle) return escapeHtml(ex.preview);
    const flat = source.replace(/\s+/g, ' ');
    const at = flat.toLowerCase().indexOf(q);
    const from = Math.max(0, at - 30);
    const to = Math.min(flat.length, at + q.length + 90);
    return (from > 0 ? '…' : '') + escapeHtml(flat.slice(from, at)) +
      '<mark>' + escapeHtml(flat.slice(at, at + q.length)) + '</mark>' +
      escapeHtml(flat.slice(at + q.length, to)) + (to < flat.length ? '…' : '');
  }

  function setStatus() {
    const el = panel && panel.querySelector('#ccn-status');
    const btn = panel && panel.querySelector('#ccn-refresh');
    if (el) el.textContent = scanning ? `Scanning… ${Math.round(scanProgress * 100)}%` : 'Claude Navigator';
    if (btn) { btn.disabled = scanning; btn.textContent = scanning ? '…' : '↺ Scan'; }
  }

  function renderList() {
    const list = panel && panel.querySelector('#ccn-list');
    if (!list) return;
    const meta = panel.querySelector('#ccn-meta');
    const q = query.trim().toLowerCase();
    const prevScroll = list.scrollTop;

    shown = [];
    exchanges.forEach((e, i) => { if (!q || e.haystack.includes(q)) shown.push(i); });

    if (meta) {
      const n = exchanges.length;
      meta.textContent = q ? `${shown.length} of ${n}` : `${n} exchange${n !== 1 ? 's' : ''}`;
    }

    if (!exchanges.length) {
      if (scanning) {
        list.innerHTML = `<div id="ccn-loading"><div id="ccn-spinner"></div><p>Scanning conversation…</p></div>`;
      } else if (scanned) {
        list.innerHTML = `<div id="ccn-empty">
          <div id="ccn-empty-icon">◌</div>
          <p>No questions found.</p>
          <p id="ccn-empty-sub">The conversation may still be loading, or claude.ai's layout changed and the selectors need updating.</p>
          <button id="ccn-copy-debug">Copy debug report</button>
        </div>`;
      } else {
        list.innerHTML = `<div id="ccn-empty">
          <div id="ccn-empty-icon">◌</div>
          <p>Click <strong>↺ Scan</strong> to load all questions.</p>
        </div>`;
      }
      return;
    }

    if (!shown.length) {
      list.innerHTML = `<div id="ccn-empty"><p>No matches.</p></div>`;
      return;
    }

    if (!shown.includes(selectedIdx)) selectedIdx = shown.includes(currentIdx) ? currentIdx : shown[0];

    list.innerHTML = shown.map(i => {
      const e = exchanges[i];
      const cls = 'ccn-item' + (i === currentIdx ? ' ccn-current' : '') + (i === selectedIdx ? ' ccn-selected' : '');
      const sub = q ? snippetHtml(e, q) : escapeHtml(e.preview);
      return `<div class="${cls}" data-i="${i}" title="${escapeHtml(e.text.slice(0, 300))}">
        <span class="ccn-num">${i + 1}</span>
        <span class="ccn-body">
          <span class="ccn-text">${escapeHtml(e.title)}</span>
          ${sub ? `<span class="ccn-preview">${sub}</span>` : ''}
        </span>
        <span class="ccn-arrow">→</span>
      </div>`;
    }).join('');
    list.scrollTop = prevScroll;
  }

  function updateSelectionUi() {
    if (!panel) return;
    panel.querySelectorAll('.ccn-selected').forEach(n => n.classList.remove('ccn-selected'));
    const row = panel.querySelector(`.ccn-item[data-i="${selectedIdx}"]`);
    if (row) { row.classList.add('ccn-selected'); row.scrollIntoView({ block: 'nearest' }); }
  }

  function updateBadge() {
    if (!toggleBtn) return;
    const badge = toggleBtn.querySelector('#ccn-badge');
    const count = exchanges.length || scanVisibleMessages().length;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }

  // ── Debug report (debug.js runs in the page's world and answers this event) ──
  function requestDebugReport() {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 1500);
      document.addEventListener('ccn-debug-result', ev => {
        clearTimeout(timer);
        resolve(ev.detail);
      }, { once: true });
      document.dispatchEvent(new CustomEvent('ccn-debug-request'));
    });
  }

  async function copyDebugReport(btn) {
    const report = await requestDebugReport();
    const header = `Claude Chat Navigator ${chrome.runtime.getManifest().version}\n` +
                   `URL: ${location.href}\nExchanges found: ${exchanges.length}\n\n`;
    try {
      await navigator.clipboard.writeText(header + (report || '(no report from page script)'));
      btn.textContent = 'Copied ✓';
    } catch (_) {
      btn.textContent = 'Copy failed';
    }
  }

  // ── Panel ─────────────────────────────────────────────────────────────────
  function buildPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'ccn-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat Navigator');
    panel.style.width = ui.width + 'px';

    panel.innerHTML = `
      <div id="ccn-resize" title="Drag to resize"></div>
      <div id="ccn-header">
        <div id="ccn-title"><span id="ccn-icon">◈</span><span>Chat Navigator</span></div>
        <div id="ccn-meta">—</div>
        <button id="ccn-close" aria-label="Close">✕</button>
      </div>
      <div id="ccn-search-wrap">
        <input id="ccn-search" type="text" placeholder="Search questions and answers…" autocomplete="off" spellcheck="false" />
        <span id="ccn-search-icon">⌕</span>
      </div>
      <div id="ccn-list"></div>
      <div id="ccn-footer">
        <button id="ccn-refresh">↺ Scan</button>
        <span id="ccn-status">Claude Navigator</span>
      </div>
    `;
    document.body.appendChild(panel);
    applyTheme();

    const list = panel.querySelector('#ccn-list');
    const searchInput = panel.querySelector('#ccn-search');

    panel.querySelector('#ccn-close').addEventListener('click', closePanel);
    panel.querySelector('#ccn-refresh').addEventListener('click', runScan);

    list.addEventListener('click', ev => {
      const dbg = ev.target.closest('#ccn-copy-debug');
      if (dbg) { copyDebugReport(dbg); return; }
      const row = ev.target.closest('.ccn-item');
      if (!row) return;
      jumpTo(parseInt(row.dataset.i, 10));
      if (window.innerWidth < 768) closePanel();
    });

    searchInput.addEventListener('input', () => {
      query = searchInput.value;
      renderList();
    });

    panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closePanel(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!shown.length) return;
        const pos = shown.indexOf(selectedIdx);
        const next = e.key === 'ArrowDown' ? Math.min(shown.length - 1, pos + 1) : Math.max(0, pos - 1);
        selectedIdx = shown[next];
        updateSelectionUi();
      } else if (e.key === 'Enter' && shown.includes(selectedIdx)) {
        e.preventDefault();
        jumpTo(selectedIdx);
        if (window.innerWidth < 768) closePanel();
      }
    });

    panel.querySelector('#ccn-resize').addEventListener('mousedown', ev => {
      ev.preventDefault();
      const startX = ev.clientX, startW = panel.offsetWidth;
      const onMove = e => {
        const max = Math.min(720, window.innerWidth - 40);
        ui.width = Math.max(300, Math.min(max, startW + (startX - e.clientX)));
        panel.style.width = ui.width + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveUi();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    setStatus();
    renderList();
  }

  function openPanel() {
    if (!isConversationPage()) return;
    if (!toggleBtn) createToggleButton();
    if (!panel) buildPanel();
    panel.classList.add('ccn-visible');
    toggleBtn.classList.add('ccn-btn-active');
    isOpen = true;
    ui.open = true;
    saveUi();
    setTimeout(() => panel && panel.querySelector('#ccn-search').focus(), 50);
    if (!scanned && !scanning) runScan();
  }

  function hidePanel() {
    if (panel) panel.classList.remove('ccn-visible');
    if (toggleBtn) toggleBtn.classList.remove('ccn-btn-active');
    isOpen = false;
  }

  function closePanel() {
    hidePanel();
    ui.open = false;
    saveUi();
  }

  function togglePanel() {
    isOpen ? closePanel() : openPanel();
  }

  // ── Toggle button ─────────────────────────────────────────────────────────
  function createToggleButton() {
    if (toggleBtn) return;
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'ccn-toggle';
    toggleBtn.setAttribute('aria-label', 'Open Chat Navigator');
    toggleBtn.title = 'Chat Navigator (Alt+N)';
    toggleBtn.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
        <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
        <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg>
      <span id="ccn-badge"></span>
    `;
    toggleBtn.addEventListener('click', togglePanel);
    document.body.appendChild(toggleBtn);
    applyTheme();
    updateBadge();
  }

  // ── Live updates ──────────────────────────────────────────────────────────
  function isOwnNode(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('#ccn-panel, #ccn-toggle'));
  }

  function onDomChange() {
    domTimer = null;
    updateBadge();
    if (!scanned || scanning || jumping) return;

    const result = snapshot();
    if (result.midInsert) { runScan(); return; }
    if (result.added || result.changed) {
      updateBadge();
      renderList();
      setCurrent(computeCurrent());
    }
  }

  function startObserving() {
    stopObserving();
    domObserver = new MutationObserver(muts => {
      if (muts.every(m => isOwnNode(m.target))) return;
      if (!domTimer) domTimer = setTimeout(onDomChange, 700);   // throttle: streaming answers mutate constantly
    });
    domObserver.observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
    clearTimeout(domTimer);
    domTimer = null;
  }

  // ── Lifecycle: mount on conversation pages, tear down elsewhere ───────────
  function resetConversationState() {
    exchanges = [];
    scanned = false;
    scanning = false;
    scanId++;                 // makes any Scan still in flight give up
    currentIdx = -1;
    selectedIdx = -1;
    shown = [];
    query = '';
    scroller = null;
    if (panel) { panel.remove(); panel = null; }
    hidePanel();
  }

  function mount() {
    createToggleButton();
    startObserving();
    if (ui.open && !isOpen) setTimeout(() => { if (ui.open && isConversationPage()) openPanel(); }, 800);
  }

  function unmount() {
    stopObserving();
    if (toggleBtn) { toggleBtn.remove(); toggleBtn = null; }
    if (panel) { panel.remove(); panel = null; }
    isOpen = false;
  }

  let lastPath = null;
  function sync() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    resetConversationState();
    if (isConversationPage()) mount(); else unmount();
  }

  function init() {
    sync();
    setInterval(sync, 500);   // SPA navigation: content scripts can't hook the page's history API
    window.addEventListener('scroll', onScroll, true);
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-mode', 'data-theme'],
    });

    document.addEventListener('keydown', e => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !isConversationPage()) return;
      if (e.code === 'KeyN') { e.preventDefault(); togglePanel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    });

    // Toolbar icon click (see background.js)
    chrome.runtime.onMessage.addListener(msg => {
      if (msg && msg.type === 'ccn-toggle' && isConversationPage()) togglePanel();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
