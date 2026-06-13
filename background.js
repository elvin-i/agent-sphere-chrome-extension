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

// --- Listen for auth info from content script ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'auth' && msg.token && msg.sessionId) {
    token = msg.token;
    sessionId = msg.sessionId;
    baseUrl = msg.baseUrl;
    chrome.storage.local.set({
      token, sessionId, displayName: msg.displayName || '', baseUrl: msg.baseUrl,
    });
    connectSSE();
  }
});

// --- Recover auth from storage on service worker restart ---
chrome.storage.local.get(['token', 'sessionId', 'baseUrl'], (data) => {
  if (data.token && data.sessionId && data.baseUrl) {
    token = data.token;
    sessionId = data.sessionId;
    baseUrl = data.baseUrl;
    connectSSE();
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
              executeInPage(msg.commandId, msg.action, params);
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

// --- Execute command in the appropriate tab ---
let controlledTabId = null;

async function executeInPage(commandId, action, params) {
  console.log('[AgentSphere] executeInPage:', action, params);
  try {
    // Navigate → open new tab
    if (action === 'navigate') {
      console.log('[AgentSphere] Creating tab with url:', params.url);
      const tab = await chrome.tabs.create({ url: params.url, active: false });
      console.log('[AgentSphere] Tab created:', tab.id);
      controlledTabId = tab.id;
      sendCallback(commandId, { success: true, data: { tabId: tab.id } });
      return;
    }

    // Other actions → send to controlled tab or active tab
    const tabId = controlledTabId || (await getActiveTabId());
    console.log('[AgentSphere] Target tab:', tabId, 'controlledTabId:', controlledTabId);
    if (!tabId) {
      sendCallback(commandId, { success: false, error: 'No target tab' });
      return;
    }

    console.log('[AgentSphere] Sending to tab', tabId, ':', action, params);
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'browser_operation',
      action,
      params,
    });
    console.log('[AgentSphere] Tab result:', result);

    sendCallback(commandId, result || { success: false, error: 'No response from page' });
  } catch (e) {
    console.error('[AgentSphere] executeInPage error:', e.message);
    sendCallback(commandId, { success: false, error: e.message });
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// --- Send result back to backend ---
async function sendCallback(commandId, result) {
  try {
    await fetch(`${baseUrl}/api/v1/chrome/callback?sessionId=${sessionId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commandId, ...result }),
    });
  } catch (e) {
    console.error('[AgentSphere] Failed to send callback:', e);
  }
}

// --- Notify popup about connection status ---
function updatePopupStatus(connected) {
  chrome.storage.local.set({ connected });
}
