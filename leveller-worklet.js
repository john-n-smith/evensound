// Lightweight streaming approximation of BS.1770 K-weighted short-term loudness.
// Not a standards-conformance meter: 100 ms block accumulation, no full EBU gating.
class Biquad {
  constructor(b0,b1,b2,a1,a2) { Object.assign(this,{b0,b1,b2,a1,a2}); this.x1=0;this.x2=0;this.y1=0;this.y2=0; }
  step(x) {
    const y=this.b0*x+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;
    this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;
    return y;
  }
}
function designShelf(fs) {
  // BS.1770 K-weighting high shelf; adapted from the reference filter parameters.
  const f=1681.974450955533, Q=0.7071752369554196, gain=3.99984385397;
  const A=10**(gain/40), K=Math.tan(Math.PI*f/fs), V=Math.sqrt(A)/Q;
  const norm=1/(1+K/Q+K*K);
  return new Biquad(
    (A+A*V*K+K*K)*norm, 2*(K*K-A)*norm,
    (A-A*V*K+K*K)*norm,
    2*(K*K-1)*norm,(1-K/Q+K*K)*norm
  );
}
function designHighPass(fs) {
  const f=38.13547087602444,Q=0.5003270373238773,K=Math.tan(Math.PI*f/fs);
  const norm=1/(1+K/Q+K*K);
  return new Biquad(norm,-2*norm,norm,2*(K*K-1)*norm,(1-K/Q+K*K)*norm);
}
const db = x => 20*Math.log10(Math.max(x,1e-15));
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
// K-weighting approximates BS.1770; short-term and momentary levels are *not*
// equivalent to a fully gated integrated EBU R128 measurement.
class LoudnessLeveller extends AudioWorkletProcessor {
  constructor() {
    super();
    this.filters=Array.from({length:2},()=>[designShelf(sampleRate),designHighPass(sampleRate)]);
    this.enabled=true;this.target=-28;this.strength=1;
    // Start conservatively attenuated. The first valid loudness measurement
    // takes 400 ms; starting at unity leaked a loud burst at episode changes.
    this.gainDb=-24;this.desiredDb=-24;this.limiter=1;
    this.initialisedSettings=false;
    this.blockFrames=Math.max(1,Math.round(sampleRate/10));
    this.frames=0;this.energy=0;this.peak=0;
    this.history=[];this.meterCounter=0;
    this.shortLUFS=null;this.momentaryLUFS=null;
    // Compute attack/release coefficients once, not per sample.
    this.attack=Math.exp(-1/(sampleRate*0.09));
    this.release=Math.exp(-1/(sampleRate*1.4));
    this.limiterRelease=Math.exp(-1/(sampleRate*0.08));
    this.port.onmessage=e=>{
      if(e.data.type!=='settings')return;
      const s=e.data.settings||{};
      if (!this.initialisedSettings) {
        // A recent gain from the preceding capture is safer and less jarring
        // than starting at unity. In its absence, start at -24 dB.
        if (Number.isFinite(s.initialGainDb)) {
          const safe=clamp(s.initialGainDb,-48,-6);
          this.gainDb=safe;this.desiredDb=safe;
        }
        this.initialisedSettings=true;
      }
      if(typeof s.enabled==='boolean')this.enabled=s.enabled;
      if(Number.isFinite(s.strength))this.strength=clamp(s.strength,0,100)/100;
      if(Number.isFinite(s.target))this.target=clamp(s.target,-50,-12);
    };
  }
  process(inputs,outputs) {
    const input=inputs[0]||[],output=outputs[0];
    const frames=output[0]?.length??0;
    if(!frames)return true;
    const channels=Math.min(input.length,2);
    for(let i=0;i<frames;i++) {
      let weightedEnergy=0,peak=0;
      for(let c=0;c<channels;c++) {
        const x=input[c][i]||0;
        const f=this.filters[c];
        const weighted=f[1].step(f[0].step(x));
        weightedEnergy+=weighted*weighted;
        peak=Math.max(peak,Math.abs(x));
      }
      this.energy+=weightedEnergy;
      this.peak=Math.max(this.peak,peak);
      this.frames++;
      if(this.frames>=this.blockFrames)this.finishBlock();
      // Attack when reducing volume, slow release when increasing it.
      // Bypass changes the goal to unity gain, including the limiter.
      const desired=this.enabled?this.desiredDb:0;
      const a=desired<this.gainDb?this.attack:this.release;
      this.gainDb=a*this.gainDb+(1-a)*desired;
      const gain=this.enabled?10**(this.gainDb/20):1;
      // Stereo-linked sample-peak safety limiter. This is not a true-peak limiter.
      const cap=!this.enabled||peak*gain<=0.97?1:0.97/(peak*gain);
      this.limiter=this.enabled
        ? Math.min(cap,1-(1-this.limiter)*this.limiterRelease)
        : 1;
      for(let c=0;c<output.length;c++) {
        const x=input[c]?.[i]||0;
        output[c][i]=this.enabled?x*gain*this.limiter:x;
      }
    }
    return true;
  }
  finishBlock() {
    const energy=this.energy/this.frames;
    this.history.push(energy);
    if(this.history.length>30)this.history.shift();
    const avg=(n)=>this.history.slice(-n).reduce((a,b)=>a+b,0)/Math.min(n,this.history.length);
    const toLufs=(x)=>x>1e-12?-0.691+10*Math.log10(x):null;
    this.momentaryLUFS=toLufs(avg(4));
    this.shortLUFS=toLufs(avg(30));
    const haveMoment=this.history.length>=4;
    const haveShort=this.history.length>=30;
    // On upward transitions use the louder of the two measurements so a theme
    // is attenuated before the 3-second meter catches up. On downward transitions
    // the short-term meter and slow release prevent pumping between words.
    const observed=haveMoment?Math.max(this.momentaryLUFS??-120,
      haveShort?(this.shortLUFS??-120):-120):null;
    if(observed!==null) {
      if(observed > -60) {
        // Move dB differences towards target, scaled by strength.
        // Avoid boosting genuine quiet / breaks more than 15 dB above the target.
        // Gain caps also protect against extremes and silence/noise amplification.
        const desired=clamp((this.target-observed)*this.strength,-48,18);
        this.desiredDb=observed<this.target-15
          ? Math.min(this.desiredDb,0)
          : desired;
      }
      // In silence, hold current desired gain; never chase a floor of -Infinity.
    } // Before the first 400 ms reading, keep the safe start-up attenuation.
    if(++this.meterCounter%3===0) {
      const applied=this.enabled?this.gainDb+db(this.limiter):0;
      this.port.postMessage({type:'meter',
        input:this.shortLUFS,
        momentary:this.momentaryLUFS,
        output:this.shortLUFS===null?null:this.shortLUFS+applied,
        gain:applied, peak:this.peak>0?db(this.peak):null,
        enabled:this.enabled,target:this.target,strength:this.strength*100});
    }
    this.frames=0;this.energy=0;this.peak=0;
  }
}
registerProcessor('loudness-leveller',LoudnessLeveller);
