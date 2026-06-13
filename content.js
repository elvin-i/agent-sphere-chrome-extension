/**
 * Content Script - Reads auth state from page, executes browser operations.
 */
(function () {

  // --- Read auth and session info ---
  let lastSessionId = null;

  function checkAuth() {
    try {
      const raw = localStorage.getItem('agent-user');
      if (!raw) return;
      const user = JSON.parse(raw);
      if (!user || !user.token) return;
      const m = location.pathname.match(/\/chat\/(\d+)/);
      if (!m) return;

      const sid = Number(m[1]);
      if (sid === lastSessionId) return;  // 没有变化，跳过
      lastSessionId = sid;

      chrome.runtime.sendMessage(chrome.runtime.id, {
        type: 'auth',
        token: user.token,
        displayName: user.displayName || '',
        sessionId: sid,
        baseUrl: location.origin,
      });
    } catch (e) {
      console.warn('[AgentSphere] Failed to read auth:', e);
    }
  }

  // Initial check + poll every 1s for session changes
  checkAuth();
  setInterval(checkAuth, 1000);

  // --- Listen for browser operation commands from background ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'browser_operation') {
      execute(msg.action, msg.params).then(sendResponse);
      return true; // keep channel open for async response
    }
  });

  async function execute(action, params) {
    try {
      switch (action) {
      case 'navigate':
        // Handled by background.js via chrome.tabs.create
        return { success: true };

      case 'click': {
          const el = document.querySelector(params.selector);
          if (!el) return { success: false, error: 'Element not found: ' + params.selector };
          el.click();
          return { success: true, data: { tag: el.tagName.toLowerCase(), text: el.textContent?.trim().slice(0, 100) } };
        }

        case 'type': {
          const el = document.querySelector(params.selector);
          if (!el) return { success: false, error: 'Input not found: ' + params.selector };
          el.value = params.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }

        case 'getContent': {
          const root = params.selector
            ? document.querySelector(params.selector)
            : document.body;
          if (!root) return { success: false, error: 'Root not found' };
          return { success: true, data: domToJSON(root) };
        }

        case 'executeJS': {
          const fn = new Function(params.code);
          return { success: true, data: fn() };
        }

        default:
          return { success: false, error: 'Unknown action: ' + action };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function domToJSON(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      return text || null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const el = node;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'iframe', 'svg', 'canvas'].includes(tag)) return null;

    let result = {};
    if (el.id) result._id = el.id;
    const cls = el.className && typeof el.className === 'string' ? el.className.trim() : '';
    if (cls) result._class = cls;

    const children = Array.from(el.childNodes).map(domToJSON).filter(Boolean);
    const directText = el.childNodes.length === 1 && el.firstChild?.nodeType === 3
      ? el.textContent?.trim() : null;

    if (directText && children.length === 0) {
      result = { tag, text: directText.slice(0, 200) };
      if (el.id) result._id = el.id;
      if (tag === 'a' && el.href) result._href = el.href;
      if (el.getAttribute('placeholder')) result._ph = el.getAttribute('placeholder');
      return result;
    }

    if (children.length === 0 && !directText) return null;

    result.tag = tag;
    result.children = children;
    if (tag === 'a' && el.href) result._href = el.href;
    if (el.getAttribute('placeholder')) result._ph = el.getAttribute('placeholder');
    if (el.getAttribute('aria-label')) result._label = el.getAttribute('aria-label');

    // Limit children to avoid huge payloads
    if (result.children && result.children.length > 50) {
      result.children = result.children.slice(0, 50);
      result._truncated = true;
    }
    return result;
  }
})();
