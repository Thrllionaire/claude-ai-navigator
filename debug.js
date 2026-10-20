// Claude Chat Navigator — debug.js
// Runs in MAIN world (world: "MAIN" in manifest), so window.__ccnDebug()
// is accessible directly from the DevTools console.

window.__ccnDebug = function () {
  const KNOWN_SELECTORS = [
    '[data-testid="human-turn"]',
    '[data-testid="user-message"]',
    '[data-testid="chat-message-user"]',
    '[data-role="user"]',
    '[data-author="human"]',
    '[data-message-author-role="user"]',
    '[aria-label*="You said"]',
    '[aria-label*="Your message"]',
  ];

  const bySelectors = KNOWN_SELECTORS.flatMap(sel => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.length ? [{ selector: sel, count: els.length }] : [];
  });

  const testIds = [...new Set(
    Array.from(document.querySelectorAll('[data-testid]'))
      .map(el => el.getAttribute('data-testid'))
  )].sort();

  const classBits = [...new Set(
    Array.from(document.querySelectorAll('*'))
      .flatMap(el => typeof el.className === 'string' ? el.className.split(/\s+/) : [])
      .filter(c => c.length > 2 && /human|user|turn|message|chat|bubble|request/i.test(c))
  )].sort();

  const dataRoles = [...new Set(
    Array.from(document.querySelectorAll('[data-role]'))
      .map(el => el.getAttribute('data-role'))
  )];

  const dataAuthors = [...new Set(
    Array.from(document.querySelectorAll('[data-author]'))
      .map(el => el.getAttribute('data-author'))
  )];

  const dataMessageRoles = [...new Set(
    Array.from(document.querySelectorAll('[data-message-author-role]'))
      .map(el => el.getAttribute('data-message-author-role'))
  )];

  // Shape of the first assistant message: tag, classes, testid, aria attributes and text start per node
  const answerTree = [];
  const firstAnswer = document.querySelector('[data-testid="assistant-message"], .font-claude-response');
  if (firstAnswer) {
    const walk = (el, depth) => {
      if (depth > 4 || answerTree.length > 60) return;
      answerTree.push('  '.repeat(depth) + el.tagName.toLowerCase() +
        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '') +
        ['data-testid', 'aria-live', 'aria-hidden', 'role'].map(a => el.hasAttribute(a) ? ` [${a}=${el.getAttribute(a)}]` : '').join('') +
        ' "' + (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) + '"');
      Array.from(el.children).forEach(c => walk(c, depth + 1));
    };
    walk(firstAnswer, 0);
  }

  console.group('%c🗺️ Claude Chat Navigator — Debug Report', 'color:#7c6af7;font-weight:bold;font-size:13px');
  console.log('%cURL', 'font-weight:bold', location.href);
  console.log('%c✅ Known-selector hits', 'font-weight:bold', bySelectors.length ? bySelectors : '(none)');
  console.log('%c🔖 All data-testid values', 'font-weight:bold', testIds);
  console.log('%c🎨 Relevant CSS classes', 'font-weight:bold', classBits);
  console.log('%c👤 data-role values', 'font-weight:bold', dataRoles);
  console.log('%c✍️  data-author values', 'font-weight:bold', dataAuthors);
  console.log('%c💬 data-message-author-role values', 'font-weight:bold', dataMessageRoles);
  console.log('%c🧩 First answer structure', 'font-weight:bold', '\n' + (answerTree.join('\n') || '(none)'));
  console.groupEnd();

  return { bySelectors, testIds, classBits, dataRoles, dataAuthors, dataMessageRoles, answerTree };
};

console.log('%c[Claude Navigator] Debug ready — run window.__ccnDebug()', 'color:#7c6af7;font-style:italic');

// Lets the content script (isolated world) fetch the report for its "Copy debug report" button.
document.addEventListener('ccn-debug-request', () => {
  let out;
  try { out = JSON.stringify(window.__ccnDebug(), null, 2); }
  catch (err) { out = 'debug report failed: ' + err.message; }
  document.dispatchEvent(new CustomEvent('ccn-debug-result', { detail: out }));
});
