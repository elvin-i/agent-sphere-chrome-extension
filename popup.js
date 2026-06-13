(function () {
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');
  const infoPanel = document.getElementById('infoPanel');
  const helpPanel = document.getElementById('helpPanel');
  const userName = document.getElementById('userName');
  const sessionInfo = document.getElementById('sessionInfo');
  const serverInfo = document.getElementById('serverInfo');

  function render(data) {
    const connected = data.connected;

    if (data.token && data.sessionId) {
      statusBar.className = 'status connected';
      statusBar.querySelector('.dot').className = 'dot ok';
      statusText.textContent = 'Connected';
      infoPanel.style.display = 'block';
      helpPanel.innerHTML = '<p>🟢 The AI can now control your browser. Keep an active tab open.</p>';
      userName.textContent = data.displayName || 'Unknown';
      sessionInfo.textContent = '#' + data.sessionId;
      serverInfo.textContent = data.baseUrl || '-';
    } else {
      statusBar.className = 'status disconnected';
      statusBar.querySelector('.dot').className = 'dot err';
      statusText.textContent = 'Not connected';
      infoPanel.style.display = 'none';
      helpPanel.innerHTML = `
        <p>💡 Open the <strong>AgentSphere</strong> web app and log in. The extension will automatically detect your session.</p>
        <p style="margin-top:8px">Once connected, the AI can control your browser — navigate, click, type, and extract content.</p>
        <p style="margin-top:8px;font-size:11px;color:#999">Make sure the web page is open in an active tab.</p>
      `;
    }
  }

  // Initial load
  chrome.storage.local.get(['token', 'sessionId', 'displayName', 'baseUrl', 'connected'], render);

  // Listen for changes
  chrome.storage.onChanged.addListener((changes) => {
    chrome.storage.local.get(['token', 'sessionId', 'displayName', 'baseUrl', 'connected'], render);
  });
})();
