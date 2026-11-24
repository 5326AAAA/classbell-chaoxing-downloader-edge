// Long operations belong to the visible manager document, never this worker.
chrome.action.onClicked.addListener(async (source) => {
  const base = chrome.runtime.getURL('manager.html');
  const managers = await chrome.tabs.query({url: base + '*'});
  if (managers.length) {
    await chrome.tabs.update(managers[0].id, {active: true});
    await chrome.windows.update(managers[0].windowId, {focused: true});
    if (source.id && source.url?.startsWith('https://')) {
      chrome.runtime.sendMessage({type: 'source-changed', tabId: source.id}).catch(() => {});
    }
  } else {
    await chrome.tabs.create({url: base + (source.id ? '?source=' + source.id : '')});
  }
});
