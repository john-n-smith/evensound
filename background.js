const URL = 'offscreen.html';
let tabId = null;
let transition = Promise.resolve();

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(URL)]
  });
  return contexts.length > 0;
}

const ICONS = {
  enabled: {16:'icons/enabled-16.png',32:'icons/enabled-32.png',48:'icons/enabled-48.png',128:'icons/enabled-128.png'},
  disabled: {16:'icons/disabled-16.png',32:'icons/disabled-32.png',48:'icons/disabled-48.png',128:'icons/disabled-128.png'}
};

async function setTabIcon(id, enabled) {
  if (id == null) return;
  try { await chrome.action.setIcon({tabId:id,path:ICONS[enabled?'enabled':'disabled']}); }
  catch (error) { console.debug('Could not update icon for tab', id, error); }
}

async function capturedTab() {
  const saved = await chrome.storage.session.get('capturedTabId');
  return saved.capturedTabId ?? null;
}

async function syncCapturedIcon() {
  const id = await capturedTab();
  if (id === null) return;
  const settings = await chrome.storage.local.get({enabled:true});
  await setTabIcon(id, settings.enabled && await hasOffscreen());
}

async function stop() {
  const previousTab = await capturedTab();
  if (await hasOffscreen()) {
    try { await chrome.runtime.sendMessage({target:'offscreen', type:'stop'}); } catch {}
    await chrome.offscreen.closeDocument();
  }
  tabId = null;
  await chrome.storage.session.remove('capturedTabId');
  await setTabIcon(previousTab, false);
  return {ok:true, active:false};
}

async function start(tab) {
  if (!tab?.id) throw Error('Open the video tab before pressing Start');
  if (await hasOffscreen()) await stop();
  await chrome.offscreen.createDocument({
    url: URL, reasons: ['USER_MEDIA'],
    justification: 'Process audio captured from the selected browser tab in real time'
  });
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tab.id});
    const settings = await chrome.storage.local.get({enabled:true,strength:100,target:-28});
    const previous = await chrome.storage.session.get(['lastGainDb','lastGainTabId']);
    if (previous.lastGainTabId === tab.id && Number.isFinite(previous.lastGainDb)) {
      settings.initialGainDb = previous.lastGainDb;
    }
    const answer = await chrome.runtime.sendMessage({target:'offscreen',type:'start',streamId,settings});
    if (!answer?.ok) throw Error(answer?.error || 'Could not start the audio processor');
    tabId = tab.id;
    await chrome.storage.session.set({capturedTabId:tabId});
    await setTabIcon(tabId, settings.enabled);
    return {ok:true,active:true,tabId};
  } catch (err) {
    await stop();
    throw err;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.target !== 'background') return;
  const call = async () => {
    if (msg.type === 'state') {
      const exists = await hasOffscreen();
      const stored = await chrome.storage.session.get('capturedTabId');
      const [current] = await chrome.tabs.query({active:true,currentWindow:true});
      return {ok:true, active:exists && stored.capturedTabId===current?.id,
        captureActive:exists, tabId:stored.capturedTabId ?? null};
    }
    if (msg.type === 'toggle') {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      if (await hasOffscreen() && tab?.id===await capturedTab()) return stop();
      return start(tab);
    }
    if (msg.type === 'settings') {
      const settings = {};
      if (typeof msg.settings.enabled === 'boolean') settings.enabled = msg.settings.enabled;
      if (Number.isFinite(msg.settings.strength)) settings.strength = Math.max(0,Math.min(100,msg.settings.strength));
      if (Number.isFinite(msg.settings.target)) settings.target = Math.max(-50,Math.min(-12,msg.settings.target));
      await chrome.storage.local.set(settings);
      if (typeof settings.enabled === 'boolean') await syncCapturedIcon();
      if (await hasOffscreen()) return chrome.runtime.sendMessage({target:'offscreen',type:'settings',settings});
      return {ok:true};
    }
    throw Error('Unknown command');
  };
  // Serialize operations so double-clicks cannot race offscreen creation/closure.
  const job = transition.then(call);
  transition = job.catch(() => {});
  job.then(respond).catch(e => respond({ok:false,error:String(e.message || e)}));
  return true;
});

chrome.tabs.onRemoved.addListener(async id => {
  const stored = await chrome.storage.session.get('capturedTabId');
  if (id === stored.capturedTabId) await stop();
  const last = await chrome.storage.session.get('lastGainTabId');
  if (id === last.lastGainTabId) await chrome.storage.session.remove(['lastGainTabId','lastGainDb']);
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'gain-snapshot' && Number.isFinite(msg.gainDb)) {
    capturedTab().then(id => {
      if (id !== null) return chrome.storage.session.set({lastGainDb:msg.gainDb,lastGainTabId:id});
    }).catch(console.error);
  }
  if (msg.type === 'capture-ended') {
    stop().catch(console.error);
  }
});

// On service-worker restarts, restore the icon for the captured tab.
chrome.runtime.onStartup.addListener(() => { syncCapturedIcon().catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { syncCapturedIcon().catch(console.error); });
