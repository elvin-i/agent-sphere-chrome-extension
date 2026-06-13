/**
 * Content Script - Reads auth state from page, executes browser operations.
 */
(function () {

  // --- Read auth and session info ---
  let lastSessionId = null;
  let lastConnected = null;
  let pendingSessionToast = false;

  async function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['settings'], (data) => {
        resolve(data.settings || { frontendUrl: 'http://localhost:8000', backendUrl: 'http://localhost:8080' });
      });
    });
  }

  function logToBackground(action, success, detail) {
    chrome.runtime.sendMessage(chrome.runtime.id, {
      type: 'log',
      action,
      success,
      detail: detail || '',
      time: Date.now(),
    }).catch(() => {});
  }

  async function checkAuth() {
    try {
      const raw = localStorage.getItem('agent-user');
      if (!raw) return;
      const user = JSON.parse(raw);
      if (!user || !user.token) return;
      const m = location.pathname.match(/\/chat\/(\d+)/);
      if (!m) return;

      const sid = Number(m[1]);
      if (sid === lastSessionId) return;
      const prevSessionId = lastSessionId;
      lastSessionId = sid;

      // Mark that a session switch happened and show toast once SSE is connected
      if (prevSessionId !== null) {
        pendingSessionToast = true;
      }

      const settings = await getSettings();
      const baseUrl = settings.backendUrl || 'http://localhost:8080';

      chrome.runtime.sendMessage(chrome.runtime.id, {
        type: 'auth',
        token: user.token,
        displayName: user.displayName || '',
        sessionId: sid,
        baseUrl,
      }).catch(() => {});
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) return;
      console.warn('[AgentSphere] Failed to read auth:', e);
    }
  }

  // Initial check + poll every 1s for session changes
  checkAuth().catch(() => {});
  setInterval(() => { checkAuth().catch(() => {}); }, 1000);

  // --- SSE status toast + session switch notification ---
  setInterval(() => {
    chrome.storage.local.get(['connected', 'sessionId'], (data) => {
      const connected = !!data.connected;

      // Show toast on session switch once SSE is connected
      if (pendingSessionToast && connected) {
        pendingSessionToast = false;
        showToast(true, '🔗 Bridge ready — Session #' + (data.sessionId || ''));
        return;
      }

      // Show/hide toast on connection status change
      if (connected === lastConnected) return;
      lastConnected = connected;
      showToast(connected);
    });
  }, 2000);

  let toastTimer = null;

  function showToast(connected, customMsg) {
    const existing = document.getElementById('as-toast');
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);

    const toast = document.createElement('div');
    toast.id = 'as-toast';
    toast.textContent = customMsg || (connected ? '🔗 Bridge connected' : '⚠️ Bridge disconnected');
    Object.assign(toast.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      padding: '12px 20px', borderRadius: '12px',
      font: '14px/1.4 -apple-system, sans-serif',
      zIndex: '2147483647',
      boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
      backdropFilter: 'blur(8px)',
      transition: 'all 0.3s ease',
      background: connected ? '#dafbe1' : '#ffebe9',
      color: connected ? '#116329' : '#cf222e',
    });
    document.body.appendChild(toast);

    if (connected || customMsg) {
      toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }
  }

  // --- Listen for browser operation commands from background ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'browser_operation') {
      execute(msg.action, msg.params).then(sendResponse);
      return true;
    }
  });

  // --- Highlight element being operated on ---
  function highlightElement(selector) {
    if (!selector) return;
    const el = document.querySelector(selector);
    if (!el) return;
    const orig = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
    el.style.outline = '3px solid #0a84ff';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = orig.outline;
      el.style.outlineOffset = orig.outlineOffset;
    }, 1500);
  }

  async function execute(action, params) {
    try {
      highlightElement(params.selector);
      switch (action) {
      case 'navigate':
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

    if (tag === 'input') return { tag: 'input', name: el.name || '', placeholder: el.getAttribute('placeholder') || '', type: el.type || '' };
    if (tag === 'button') return { tag: 'button', text: el.textContent?.trim().slice(0, 100) };
    if (tag === 'textarea') return { tag: 'textarea', placeholder: el.getAttribute('placeholder') || '' };
    if (tag === 'select') return { tag: 'select', children: Array.from(el.options).map(o => o.text).filter(Boolean) };

    let result = {};
    if (el.id) result._id = el.id;
    const cls = el.className && typeof el.className === 'string' ? el.className.trim() : '';
    if (cls) result._class = cls;

    const children = Array.from(el.childNodes).map(domToJSON).filter(Boolean);
    const directText = el.childNodes.length === 1 && el.firstChild?.nodeType === 3 ? el.textContent?.trim() : null;

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

    if (result.children && result.children.length > 50) {
      result.children = result.children.slice(0, 50);
      result._truncated = true;
    }
    return result;
  }
})();
