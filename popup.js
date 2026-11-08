const $=id=>document.getElementById(id);
const history=[];
let active=false,working=false,enabled=true,strength=100,target=-28;
const MAX=200;
function rpc(type,extra={}) {
  return chrome.runtime.sendMessage({target:'background',type,...extra}).then(r=>{
    if(!r?.ok)throw Error(r?.error || 'Extension command failed');return r;
  });
}
function setActive(value) {
  active=value;$('status').textContent=active?'● Capturing':'Not capturing';
  $('status').style.color=active?'#81dca9':'#a7b1c0';
  $('toggle').textContent=active?'Stop capture':'Start on this tab';
  $('toggle').disabled=working;
}
function fmt(n,unit){return Number.isFinite(n)?`${n.toFixed(1)} ${unit}`:'—';}
function draw() {
  const canvas=$('chart'),g=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  const left=48,right=w-12,top=12,bottom=h-34,min=-60,max=-8;
  g.clearRect(0,0,w,h);
  g.font='22px system-ui';g.textAlign='right';
  for(let v=-60;v<=-10;v+=10){
    const y=bottom-(v-min)/(max-min)*(bottom-top);
    g.strokeStyle='#354356';g.lineWidth=1;g.beginPath();g.moveTo(left,y);g.lineTo(right,y);g.stroke();
    g.fillStyle='#adbac9';g.fillText(String(v),left-10,y+8);
  }
  const y=v=>bottom-(v-min)/(max-min)*(bottom-top);
  g.setLineDash([8,8]);g.strokeStyle='#9ca9ff';g.lineWidth=2;
  let drawing=false;g.beginPath();
  history.forEach((point,i)=>{
    if(!Number.isFinite(point.ceiling)){drawing=false;return;}
    const x=left+(i/(MAX-1))*(right-left);
    if(!drawing)g.moveTo(x,y(point.ceiling));else g.lineTo(x,y(point.ceiling));drawing=true;
  });g.stroke();g.setLineDash([]);
  function plot(key,color){
    g.strokeStyle=color;g.lineWidth=3;g.beginPath();let drawing=false;
    history.forEach((point,i)=>{
      const v=point[key];
      if(!Number.isFinite(v)){drawing=false;return;}
      const x=left+(i/(MAX-1))*(right-left);
      if(!drawing)g.moveTo(x,y(v));else g.lineTo(x,y(v));drawing=true;
    });g.stroke();
  }
  plot('input','#e7b965');plot('output','#68d9a2');
  g.fillStyle='#9eacbf';g.font='18px system-ui';g.textAlign='left';
  g.fillText('Oldest',left,bottom+25);g.textAlign='right';g.fillText('Now',right,bottom+25);
}
$('toggle').addEventListener('click',async()=>{
  working=true;$('toggle').disabled=true;$('error').hidden=true;
  try {
    const state=await rpc('toggle');setActive(state.active);
    history.length=0;draw();
  }
  catch(e){$('error').textContent=e.message;$('error').hidden=false;}
  finally{working=false;setActive(active);}
});
$('strength').addEventListener('input',()=>{
  strength=Number($('strength').value);
  $('strengthValue').textContent=`${strength}%`;
  rpc('settings',{settings:{strength}}).catch(e=>{
    $('error').textContent=e.message;$('error').hidden=false;
  });
});
$('target').addEventListener('input',()=>{
  target=Number($('target').value);
  $('targetValue').textContent=`${target} LUFS`;
  rpc('settings',{settings:{target}}).catch(e=>{
    $('error').textContent=e.message;$('error').hidden=false;
  });
});
$('enabled').addEventListener('change',async()=>{
  enabled=$('enabled').checked;
  try{await rpc('settings',{settings:{enabled}})}
  catch(e){$('error').textContent=e.message;$('error').hidden=false;}
});
chrome.runtime.onMessage.addListener(msg=>{
  if(msg.type==='capture-ended'){setActive(false);return;}
  if(msg.type!=='meter')return;
  if(!active)setActive(true);
  history.push({input:msg.input,output:msg.output,ceiling:msg.target});
  if(history.length>MAX)history.shift();
  $('source').textContent=fmt(msg.input,'LUFS');
  $('output').textContent=fmt(msg.output,'LUFS');
  $('gain').textContent=fmt(msg.gain,'dB');
  draw();
});
(async()=>{
  try {
    const prefs=await chrome.storage.local.get({enabled:true,strength:100,target:-28});
    enabled=prefs.enabled;strength=prefs.strength;target=prefs.target;
    $('enabled').checked=enabled;
    $('strength').value=strength;
    $('strengthValue').textContent=`${strength}%`;
    $('target').value=target;
    $('targetValue').textContent=`${target} LUFS`;
    const state=await rpc('state');setActive(state.active);
  }catch(e){$('error').textContent=e.message;$('error').hidden=false;}
  draw();
})();
