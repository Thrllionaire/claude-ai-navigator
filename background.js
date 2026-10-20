// Toolbar icon click toggles the Chat Navigator panel on the active claude.ai tab.
chrome.action.onClicked.addListener(tab => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ccn-toggle' }).catch(() => {
    // Not a claude.ai tab (no content script listening)
  });
});
