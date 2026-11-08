const URL = 'offscreen.html';
let tabId = null;
let transition = Promise.resolve();

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(URL)]
  });
  return contexts.length > 0;
}

async function badge(text, color) {
  await chrome.action.setBadgeText({text});
  if (color) await chrome.action.setBadgeBackgroundColor({color});
}

async function stop() {
  if (await hasOffscreen()) {
    try { await chrome.runtime.sendMessage({target:'offscreen', type:'stop'}); } catch {}
    await chrome.offscreen.closeDocument();
  }
  tabId = null;
  await chrome.storage.session.remove('capturedTabId');
  await badge('', '#287a43');
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
    await badge('ON','#287a43');
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
      return {ok:true, active:exists, tabId:stored.capturedTabId ?? null};
    }
    if (msg.type === 'toggle') {
      if (await hasOffscreen()) return stop();
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      return start(tab);
    }
    if (msg.type === 'settings') {
      const settings = {};
      if (typeof msg.settings.enabled === 'boolean') settings.enabled = msg.settings.enabled;
      if (Number.isFinite(msg.settings.strength)) settings.strength = Math.max(0,Math.min(100,msg.settings.strength));
      if (Number.isFinite(msg.settings.target)) settings.target = Math.max(-50,Math.min(-12,msg.settings.target));
      await chrome.storage.local.set(settings);
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
    chrome.storage.session.set({lastGainDb:msg.gainDb,lastGainTabId:tabId}).catch(console.error);
  }
  if (msg.type === 'capture-ended') {
    stop().catch(console.error);
  }
});
