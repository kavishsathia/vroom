chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'action') return;

  if (msg.action === 'click') {
    const x = msg.x;
    const y = msg.y;
    const el = document.elementFromPoint(x, y);
    if (el) {
      // Try native click first (works even when isTrusted is checked)
      el.focus();
      el.click();

      // Also find and click the nearest <a> or <button> ancestor if the
      // element itself isn't interactive
      const interactive = el.closest('a, button, [role="button"], input, select, [onclick]');
      if (interactive && interactive !== el) {
        interactive.click();
      }
    }
    sendResponse({ success: true });
  } else if (msg.action === 'type') {
    const el = document.activeElement;
    if (el) {
      el.focus();
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = '';
      }
      document.execCommand('insertText', false, msg.text);
    }
    sendResponse({ success: true });
  } else if (msg.action === 'scroll') {
    const amount = msg.direction === 'down' ? 400 : -400;
    window.scrollBy({ top: amount, behavior: 'smooth' });
    sendResponse({ success: true });
  }

  return true;
});
