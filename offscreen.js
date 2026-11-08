let stream = null;
let context = null;
let processor = null;
let tick = null;
let lastMeter = null;
let stopping = false;
let lastGainReport = 0;

function notify(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

async function stop() {
  stopping = true;
  if (tick !== null) clearInterval(tick);
  tick = null;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  if (context) await context.close();
  context = null;
  processor = null;
  lastMeter = null;
}

async function start(streamId, settings) {
  await stop();
  stopping = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:{mandatory:{
      chromeMediaSource:'tab',chromeMediaSourceId:streamId
    }},video:false});
    context = new AudioContext();
    await context.audioWorklet.addModule('leveller-worklet.js');
    const source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, 'loudness-leveller', {
      outputChannelCount:[2], channelCount:2, channelCountMode:'explicit'
    });
    // This processor restores playback because tabCapture mutes normal tab output.
    source.connect(processor).connect(context.destination);
    processor.port.postMessage({type:'settings',settings});
    processor.port.onmessage = event => {
      if (event.data.type === 'meter') {
        lastMeter = event.data;
        // Store a recent attenuation for the next capture of this tab.
        // Throttle persistence to roughly once per second.
        const now = Date.now();
        if (event.data.enabled && Number.isFinite(event.data.gain) && now-lastGainReport>1000) {
          lastGainReport=now;
          notify({type:'gain-snapshot',gainDb:event.data.gain});
        }
      }
    };
    await context.resume();
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
      if (!stopping) notify({type:'capture-ended'});
    }));
    tick = setInterval(() => {
      if (lastMeter) notify({type:'meter', ...lastMeter});
    }, 250);
    return {ok:true,sampleRate:context.sampleRate};
  } catch (e) {
    await stop();
    throw e;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'start') {
    start(message.streamId, message.settings).then(respond).catch(e=>respond({ok:false,error:String(e)}));
    return true;
  }
  if (message.type === 'stop') {
    stop().then(()=>respond({ok:true})).catch(e=>respond({ok:false,error:String(e)}));
    return true;
  }
  if (message.type === 'settings') {
    processor?.port.postMessage({type:'settings',settings:message.settings});
    respond({ok:true});
  }
});
