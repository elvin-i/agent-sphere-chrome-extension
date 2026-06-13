/**
 * Service Worker - Maintains SSE connection, routes commands to content script.
 */
console.log('[AgentSphere] Service Worker started', new Date().toISOString());
let token = '';
let sessionId = null;
let baseUrl = '';
let abortController = null;
let reconnectTimer = null;

// --- Keep SW alive: check connection every minute ---
chrome.alarms.create('sse-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sse-keepalive') {
    if (!abortController || abortController.signal.aborted) {
      console.log('[AgentSphere] Keepalive: reconnecting SSE');
      connectSSE();
    }
  }
});

// --- Start SSE on startup ---
function startSSE() {
  chrome.storage.local.get(['token', 'sessionId', 'baseUrl'], (data) => {
    if (data.token && data.sessionId && data.baseUrl) {
      token = data.token;
      sessionId = data.sessionId;
      baseUrl = data.baseUrl;
      connectSSE();
    }
  });
}

startSSE();

// --- Detect session changes from tab URL (works even without content script) ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const m = changeInfo.url.match(/\/chat\/(\d+)/);
  if (!m) return;
  const newSessionId = Number(m[1]);
  if (newSessionId === sessionId) return;

  chrome.storage.local.get(['token', 'baseUrl'], (data) => {
    if (data.token && data.baseUrl) {
      token = data.token;
      baseUrl = data.baseUrl;
      sessionId = newSessionId;
      chrome.storage.local.set({ sessionId: newSessionId }).catch(() => {});
      console.log('[AgentSphere] Tab URL changed, switching to session', newSessionId);
      connectSSE();
    }
  });
});

// --- Listen for auth info from content script ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'auth' && msg.token && msg.sessionId) {
    token = msg.token;
    sessionId = msg.sessionId;
    baseUrl = msg.baseUrl;
    chrome.storage.local.set({
      token, sessionId, displayName: msg.displayName || '', baseUrl: msg.baseUrl,
    }).catch(() => {});
    connectSSE();
  }
  if (msg.type === 'log') {
    chrome.storage.local.get(['logs'], (data) => {
      const logs = data.logs || [];
      logs.push({ time: msg.time || Date.now(), action: msg.action, success: msg.success, detail: msg.detail });
      if (logs.length > 200) logs.splice(0, logs.length - 200);
      chrome.storage.local.set({ logs }).catch(() => {});
    });
  }
});

// --- SSE Connection via fetch + ReadableStream (supports Authorization header) ---
async function connectSSE() {
  if (abortController) { abortController.abort(); abortController = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (!sessionId || !token || !baseUrl) return;

  const url = `${baseUrl}/api/v1/runtime/${sessionId}/stream`;
  console.log('[AgentSphere] Connecting SSE:', url);

  abortController = new AbortController();

  try {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    console.log('[AgentSphere] SSE connected');
    updatePopupStatus(true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const dataLine = part.startsWith('data:') ? part.slice(5).trim() : '';
        if (dataLine) {
          try {
            const msg = JSON.parse(dataLine);
            console.log('[AgentSphere] SSE msg:', msg.eventType, msg.action, msg.url?.slice(0,30));
            if (msg.eventType === 'browser_operation') {
              const params = { url: msg.url, selector: msg.selector, text: msg.text, code: msg.code };
              Object.keys(params).forEach(k => { if (params[k] == null) delete params[k]; });
              console.log('[AgentSphere] Calling executeInPage:', msg.commandId?.slice(0,8), msg.action, Object.keys(params));
              executeInPage(msg.commandId, msg.action, params).catch(e => {
                console.warn('[AgentSphere] executeInPage rejected:', e.message);
              });
            }
          } catch (e) {
            console.error('[AgentSphere] Parse error:', e);
          }
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('[AgentSphere] SSE error, reconnecting in 5s:', e.message);
    updatePopupStatus(false);
    reconnectTimer = setTimeout(connectSSE, 5000);
  }
}

// --- Send message to content script with retry ---
async function sendMessageWithRetry(tabId, msg, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      if (e.message?.includes('Receiving end does not exist') && i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
}

// --- Execute command in the appropriate tab ---
let controlledTabId = null;

async function executeInPage(commandId, action, params) {
  console.log('[AgentSphere] executeInPage:', action, params);
  try {
    // Navigate → open new tab and wait for page load
    if (action === 'navigate') {
      // Reuse existing tab if same URL is already open
      if (controlledTabId) {
        try {
          const existingTab = await chrome.tabs.get(controlledTabId);
          if (existingTab?.url === params.url || existingTab?.pendingUrl === params.url) {
            console.log('[AgentSphere] Reusing existing tab:', controlledTabId);
            await chrome.tabs.update(controlledTabId, { active: true }).catch(() => {});
            sendCallbackSafe(commandId, { success: true, data: { tabId: controlledTabId }, action: 'navigate', detail: params.url });
            return;
          }
        } catch (e) {
          // Tab no longer exists, create a new one
          console.log('[AgentSphere] Controlled tab gone, creating new one');
        }
      }

      console.log('[AgentSphere] Creating tab with url:', params.url);
      const tab = await chrome.tabs.create({ url: params.url, active: true });
      console.log('[AgentSphere] Tab created:', tab.id);

      // Wait for page to finish loading (HTML + resources)
      await new Promise((resolve) => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      // Wait for idle (async rendering / SPA scripts done)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => new Promise(r => requestIdleCallback(r, { timeout: 5000 })),
      }).catch(() => {});

      controlledTabId = tab.id;
      sendCallbackSafe(commandId, { success: true, data: { tabId: tab.id }, action: 'navigate', detail: params.url });
      return;
    }

    // Other actions → focus controlled tab and send command
    if (controlledTabId) {
      await chrome.tabs.update(controlledTabId, { active: true }).catch(() => {});
    }
    const tabId = controlledTabId || (await getActiveTabId());
    console.log('[AgentSphere] Target tab:', tabId, 'controlledTabId:', controlledTabId);
    if (!tabId) {
      sendCallbackSafe(commandId, { success: false, error: 'No target tab', action });
      return;
    }

    console.log('[AgentSphere] Sending to tab', tabId, ':', action, params);
    const result = await sendMessageWithRetry(tabId, {
      type: 'browser_operation',
      action,
      params,
    });
    console.log('[AgentSphere] Tab result:', result);

    sendCallbackSafe(commandId, { ...result, action, detail: params.selector || params.url || '' });
  } catch (e) {
    console.error('[AgentSphere] executeInPage error:', e.message);
    sendCallbackSafe(commandId, { success: false, error: e.message, action, detail: e.message });
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// --- Send result back to backend ---
function sendCallbackSafe(commandId, result) {
  sendCallback(commandId, result).catch(e => {
    console.warn('[AgentSphere] sendCallback rejected:', e.message);
  });
}

async function sendCallback(commandId, result) {
  try {
    const actionResult = result;
    await fetch(`${baseUrl}/api/v1/chrome/callback?sessionId=${sessionId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commandId, ...result }),
    });

    // Record log
    chrome.storage.local.get(['logs'], (data) => {
      const logs = data.logs || [];
      logs.push({ time: Date.now(), action: result?.action || 'callback', success: !!result?.success, detail: result?.error || '' });
      if (logs.length > 200) logs.splice(0, logs.length - 200);
      chrome.storage.local.set({ logs }).catch(() => {});
    });
  } catch (e) {
    console.error('[AgentSphere] Failed to send callback:', e);
  }
}

// --- Notify popup about connection status ---
function updatePopupStatus(connected) {
  chrome.storage.local.set({ connected }).catch(() => {});
}
