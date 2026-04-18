// ═══════════════════════════════════════════════════════════════════════════════
// Bach · A quiet window into counterpoint — v5.2
// Zero heavy math in render loop. All analysis pre-calculated once.
// Only canon identification (five‑dot ghost handoff) is shown.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Palettes: ensemble → quartet → tapestry → candlelight → manuscript ────────
const PALETTES = {
    ensemble:    { name:"Ensemble",    voices:["#E8D4A2","#6B8CAE","#C97B5F","#8FA876","#B08FA0"], ink:"#E8D4A2", gold:"#C9A961" },
    quartet:     { name:"Quartet",     voices:["#D97757","#4A8BA8","#D4A84A","#6B8E5E","#8E6B9E"], ink:"#E8D4A2", gold:"#C9A961" },
    tapestry:    { name:"Tapestry",    voices:["#2B4162","#8B2635","#DDA77B","#385F71","#4A4063"], ink:"#DDA77B", gold:"#DDA77B" },
    candlelight: { name:"Candlelight", voices:["#E8D4A2","#C9A961","#A88754","#7A5F38","#4A3B2A"], ink:"#E8D4A2", gold:"#C9A961" },
    manuscript:  { name:"Manuscript",  voices:["#D4B896","#A8865E","#7A5A3A","#543B24","#32220F"], ink:"#D4B896", gold:"#B08B5E" }
};

const BG_COLOR       = "#0A0908";
let   activePalette  = "ensemble";
const getPalette     = () => PALETTES[activePalette];

const SILENT_INTRO        = 1.5;
const WHITE_KEY_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const isMobile            = () => window.innerWidth < 640;
const measuresVisible     = () => isMobile() ? 4 : 8;

const formatTime = s => {
    if (!isFinite(s) || s < 0) s = 0;
    return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
};

const parseTitle = filename => {
    let name = filename.split('/').pop().replace(/\.(mid|midi)$/i,'');
    name = name.replace(/[_-]/g,' ').replace(/\s+/g,' ').trim();
    const bwvMatch = name.match(/BWV\s*(\d+[a-z]?)/i);
    const bwv   = bwvMatch ? `BWV ${bwvMatch[1]}` : '';
    const title = name.replace(/BWV\s*\d+[a-z]?/i,'').replace(/\s+/g,' ').trim();
    const pretty = title.split(' ').map(w =>
        w.length<=2 && w.toLowerCase()!=='no' ? w.toLowerCase()
        : w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()
    ).join(' ');
    return { title: pretty||'Untitled', meta: bwv };
};

// ═══ Library ═══════════════════════════════════════════════════════════════════
class BachLibrary {
    constructor() { this.works = new Map(); this.tree = {}; }
    async load(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("Failed to fetch: "+resp.status);
        const zip = await window.JSZip.loadAsync(await resp.blob());
        const files = [];
        zip.forEach((rel, entry) => {
            if (entry.dir || !rel.match(/\.(mid|midi)$/i)) return;
            const clean  = rel.replace(/^bach\//,'');
            const folder = clean.split('/')[0] || 'Miscellaneous';
            if (!this.tree[folder]) this.tree[folder] = [];
            this.tree[folder].push(clean);
            files.push({ name: clean, entry });
        });
        for (const f of files) this.works.set(f.name, await f.entry.async("arraybuffer"));
    }
}

// ═══ AnalysisEngine ════════════════════════════════════════════════════════════
// Called ONCE after track load. All arrays are static and read-only.
// Render loop uses only O(log n) binary searches into these arrays.
class AnalysisEngine {
    constructor() {
        this.motifs        = [];
        this.keySegments   = [];
        this.cadences      = [];
        this.chordTimeline = [];
        this.ghostPaths    = [];
        this.pedalPoints   = [];
        this.insightEvents = [];
        this.tempo         = 80;
        this.ready         = false;
    }

    analyze(notes, totalTime, tempo) {
        this.tempo  = tempo || 80;
        this.ready  = false;
        this.motifs=[]; this.keySegments=[]; this.cadences=[];
        this.chordTimeline=[]; this.ghostPaths=[]; this.pedalPoints=[]; this.insightEvents=[];
        if (!notes || !notes.length) return;
        this.keySegments   = this._detectKeys(notes, totalTime);
        this.cadences      = this._detectCadences(notes, this.keySegments);
        this.chordTimeline = this._buildChordTimeline(notes, totalTime);
        this.pedalPoints   = this._detectPedalPoints(notes);
        this.motifs        = this._detectMotifs(notes);
        if (this.motifs.length)
            this.ghostPaths = this._buildGhostPaths(this.motifs[0].entries);
        this.insightEvents = this._buildInsightEvents();
        this.ready = true;
    }

    // O(log n) binary searches — safe to call every frame
    keyAt(t)   { return AnalysisEngine._bseg(this.keySegments,   t); }
    chordAt(t) { return AnalysisEngine._bseg(this.chordTimeline, t); }
    insightAt(t) {
        const a = this.insightEvents;
        let lo=0, hi=a.length-1, r=null;
        while (lo<=hi) {
            const m=(lo+hi)>>1;
            if (a[m].time<=t){r=a[m];lo=m+1;} else hi=m-1;
        }
        return (r && t < r.time+r.duration) ? r : null;
    }

    voiceNameFor(track, vg) {
        const ns=vg[track]||[], avg=ns.length?ns.reduce((s,n)=>s+n.midi,0)/ns.length:60;
        return avg>72?'Soprano':avg>60?'Alto':avg>48?'Tenor':'Bass';
    }
    voiceInitial(track, vg) { return this.voiceNameFor(track,vg)[0]; }

    static _bseg(arr, t) {
        if (!arr||!arr.length) return null;
        let lo=0,hi=arr.length-1;
        while (lo<=hi){
            const m=(lo+hi)>>1;
            if (arr[m].endTime<=t) lo=m+1;
            else if (arr[m].time>t) hi=m-1;
            else return arr[m];
        }
        return null;
    }

    // ── Stable chord timeline: only shows chords held ≥ 1 beat ───────────────
    _buildChordTimeline(notes, totalTime) {
        const bd=60/this.tempo, MIN=bd*1.0, STEP=bd*0.5;
        let rName=null, rData=null, rStart=0;
        const stable=[];
        for (let t=0; t<=totalTime+STEP; t+=STEP) {
            const active=notes.filter(n=>t>=n.time&&t<n.time+n.duration);
            const ch=AnalysisEngine._chord(active), nm=ch?.name??null;
            if (nm!==rName) {
                if (rData&&(t-rStart)>=MIN) stable.push({time:rStart,endTime:t,...rData});
                rName=nm; rData=ch; rStart=t;
            }
        }
        if (rData&&(totalTime-rStart)>=MIN) stable.push({time:rStart,endTime:totalTime,...rData});
        const merged=[];
        stable.forEach(r=>{
            const l=merged[merged.length-1];
            if (l&&l.name===r.name) l.endTime=r.endTime; else merged.push({...r});
        });
        return merged;
    }

    static _chord(activeNotes) {
        if (!activeNotes||activeNotes.length<2) return null;
        const pcSet=new Set(activeNotes.map(n=>((n.midi%12)+12)%12));
        const pcs=Array.from(pcSet).sort((a,b)=>a-b);
        if (pcs.length<2) return null;
        const bassPc=((activeNotes.reduce((lo,n)=>n.midi<lo.midi?n:lo).midi%12)+12)%12;
        const T=[
            {n:"",iv:[0,4,7],p:10},{n:"m",iv:[0,3,7],p:10},
            {n:"°",iv:[0,3,6],p:8},{n:"⁺",iv:[0,4,8],p:6},
            {n:"⁷",iv:[0,4,7,10],p:9},{n:"maj⁷",iv:[0,4,7,11],p:9},
            {n:"m⁷",iv:[0,3,7,10],p:9},{n:"ø",iv:[0,3,6,10],p:8},
            {n:"°⁷",iv:[0,3,6,9],p:7},{n:"sus⁴",iv:[0,5,7],p:5},{n:"sus²",iv:[0,2,7],p:5},
        ];
        const NN=['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
        let best=null;
        for (const r of pcs) for (const t of T) {
            const exp=t.iv.map(i=>(r+i)%12);
            if (exp.some(pc=>!pcSet.has(pc))) continue;
            const ext=pcs.filter(pc=>!exp.includes(pc)).length;
            if (ext>1) continue;
            const sc=t.p*10-ext*2+(r===bassPc?5:0);
            if (!best||sc>best.score) best={name:NN[r]+t.n,root:r,quality:t.n,score:sc};
        }
        if (!best&&pcs.length===2){
            const iv=((pcs[1]-pcs[0])+12)%12;
            const IVN={1:"m2",2:"M2",3:"m3",4:"M3",5:"P4",6:"TT",7:"P5",8:"m6",9:"M6",10:"m7",11:"M7"};
            if (IVN[iv]) return {name:NN[pcs[0]]+"–"+NN[pcs[1]],interval:IVN[iv]};
        }
        return best;
    }

    // ── Subject / motif detection ──────────────────────────────────────────────
    _detectMotifs(notes) {
        const tracks={};
        notes.forEach(n=>{ if(!tracks[n.track]) tracks[n.track]=[]; tracks[n.track].push(n); });
        Object.values(tracks).forEach(t=>t.sort((a,b)=>a.time-b.time));
        const ids=Object.keys(tracks).map(Number).sort((a,b)=>a-b);
        if (!ids.length) return [];
        const LEN=5, bd=60/this.tempo, GAP=bd*1.5;
        const contour=ns=>{const r=[];for(let i=0;i<ns.length-1;i++)r.push(ns[i+1].midi-ns[i].midi);return r;};
        const first=ids.reduce((b,id)=>(tracks[id][0]?.time??Infinity)<(tracks[b]?.[0]?.time??Infinity)?id:b,ids[0]);
        const fv=tracks[first], sub=[fv[0]];
        for (let i=1;i<fv.length&&sub.length<LEN;i++){
            if (fv[i].time-(fv[i-1].time+fv[i-1].duration)<=GAP) sub.push(fv[i]); else break;
        }
        if (sub.length<LEN) return [];
        const key=contour(sub.slice(0,LEN)).join(',');
        const entries=[];
        ids.forEach(id=>{
            const tn=tracks[id];
            for (let i=0;i<=tn.length-LEN;i++){
                const sl=tn.slice(i,i+LEN);
                let ok=true;
                for (let j=0;j<sl.length-1;j++)
                    if (sl[j+1].time-(sl[j].time+sl[j].duration)>GAP){ok=false;break;}
                if (!ok) continue;
                if (contour(sl).join(',')===key)
                    entries.push({track:id,notes:sl,time:sl[0].time,endTime:sl[sl.length-1].time+sl[sl.length-1].duration});
            }
        });
        entries.sort((a,b)=>a.time-b.time);
        return entries.length>=2?[{contour:key.split(',').map(Number),entries}]:[];
    }

    // ── Enhanced ghost paths with motif contour data ───────────────────────────
    _buildGhostPaths(entries) {
        const paths=[];
        for (let i=0;i<entries.length-1;i++){
            const a=entries[i], b=entries[i+1];
            if (a.track===b.track) continue;
            const gap=b.time-a.endTime;
            if (gap<-0.1||gap>5) continue;
            const duxStart=a.notes[0].time;
            paths.push({
                startTime:  a.endTime,
                endTime:    Math.max(b.time, a.endTime+0.25),
                fromTrack:  a.track,
                toTrack:    b.track,
                fromMidi:   a.notes[a.notes.length-1].midi,
                toMidi:     b.notes[0].midi,
                noteMidis:       a.notes.map(n=>n.midi),
                noteTimeOffsets: a.notes.map(n=>n.time-duxStart),
                duxDuration:     Math.max(0.1, a.endTime-a.time),
                temporalOffset:  b.time-a.time
            });
        }
        return paths;
    }

    // ── Insight events: pre-calculated commentary (kept for internal use only) ─
    _buildInsightEvents() {
        const events=[], bd=60/this.tempo;
        let lastKey=null;
        this.keySegments.forEach(seg=>{
            const k=seg.key+seg.mode;
            if (!lastKey){lastKey=k;return;}
            if (k!==lastKey){
                events.push({time:seg.time,duration:2.2,text:`→ ${seg.key} ${seg.mode}`,type:'key',track:null});
                lastKey=k;
            }
        });
        this.cadences.forEach(c=>{
            events.push({time:c.time,duration:2.4,text:'— cadence —',type:'cadence',track:null});
        });
        if (this.motifs.length){
            const {entries}=this.motifs[0];
            entries.forEach((e,i)=>{
                const prev=entries[i-1];
                const stretto=prev&&e.time<prev.endTime;
                const text=i===0?'subject':stretto?'stretto':i===1?'answer':'imitation';
                events.push({time:e.time,duration:1.9,text,type:'motif',track:e.track});
            });
        }
        this.pedalPoints.forEach(p=>{
            events.push({time:p.time,duration:2.0,text:'— pedal —',type:'pedal',track:null});
        });
        return events.sort((a,b)=>a.time-b.time);
    }

    // ── Tonal journey (Krumhansl-Kessler) ─────────────────────────────────────
    _detectKeys(notes, totalTime) {
        const KM=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
        const Km=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
        const NN=['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
        const F5=[0,7,2,9,4,11,6,1,8,3,10,5];
        const kCol=(pc,mode)=>{const h=Math.round((F5.indexOf(pc)/12)*360);return mode==='major'?`hsl(${h},52%,40%)`:`hsl(${h},40%,26%)`;};
        const bd=60/this.tempo, WIN=bd*8, STEP=bd*4;
        const segs=[];
        for (let t=0;t<totalTime;t+=STEP){
            const pcW=new Array(12).fill(0);
            notes.forEach(n=>{const ov=Math.min(n.time+n.duration,t+WIN)-Math.max(n.time,t);if(ov>0)pcW[((n.midi%12)+12)%12]+=ov;});
            const tot=pcW.reduce((a,b)=>a+b,0); if(!tot) continue;
            const norm=pcW.map(w=>w/tot);
            let best={score:-Infinity,pc:0,mode:'major'};
            for (let r=0;r<12;r++){
                let maj=0,min=0;
                for (let i=0;i<12;i++){maj+=norm[(i+r)%12]*KM[i];min+=norm[(i+r)%12]*Km[i];}
                if(maj>best.score)best={score:maj,pc:r,mode:'major'};
                if(min>best.score)best={score:min,pc:r,mode:'minor'};
            }
            segs.push({time:t,endTime:Math.min(t+STEP,totalTime),key:NN[best.pc],pc:best.pc,mode:best.mode,color:kCol(best.pc,best.mode)});
        }
        for(let i=1;i<segs.length-1;i++){
            const p=segs[i-1].pc+segs[i-1].mode,nx=segs[i+1].pc+segs[i+1].mode;
            if(p===nx&&(segs[i].pc+segs[i].mode)!==p)
                Object.assign(segs[i],{pc:segs[i-1].pc,mode:segs[i-1].mode,key:segs[i-1].key,color:segs[i-1].color});
        }
        const merged=[];
        segs.forEach(s=>{
            const l=merged[merged.length-1];
            if(l&&l.key===s.key&&l.mode===s.mode)l.endTime=s.endTime;else merged.push({...s});
        });
        return merged;
    }

    // ── Cadence detection (V→I) ────────────────────────────────────────────────
    _detectCadences(notes, ks) {
        const bd=60/this.tempo, STEP=bd*2;
        const total=notes.reduce((m,n)=>Math.max(m,n.time+n.duration),0);
        const hasDom=(pcs,kpc)=>pcs.has((kpc+7)%12)&&pcs.has((kpc+11)%12);
        const hasTon=(pcs,kpc)=>pcs.has(kpc)&&(pcs.has((kpc+4)%12)||pcs.has((kpc+3)%12));
        const cads=[]; let prev=null;
        for (let t=STEP;t<total;t+=STEP){
            const act=notes.filter(n=>n.time<t+STEP&&n.time+n.duration>t);
            if(act.length<2){prev=null;continue;}
            const cur=new Set(act.map(n=>((n.midi%12)+12)%12));
            const key=AnalysisEngine._bseg(ks,t);
            if(key&&prev&&hasDom(prev,key.pc)&&hasTon(cur,key.pc))
                cads.push({time:t,type:'authentic',key});
            prev=cur;
        }
        return cads.filter((c,i)=>i===0||c.time-cads[i-1].time>bd*4);
    }

    // ── Pedal points (sustained bass) ─────────────────────────────────────────
    _detectPedalPoints(notes) {
        const bd=60/this.tempo;
        const bass=notes.filter(n=>n.midi<52&&n.duration>=bd*2);
        const sorted=[...bass].sort((a,b)=>a.time-b.time);
        const merged=[];
        sorted.forEach(n=>{
            const l=merged[merged.length-1];
            if(l&&Math.abs(l.midi-n.midi)<=1&&n.time-l.endTime<bd)
                l.endTime=Math.max(l.endTime,n.time+n.duration);
            else merged.push({time:n.time,endTime:n.time+n.duration,midi:n.midi,track:n.track});
        });
        return merged.filter(p=>p.endTime-p.time>=bd*4);
    }
}

// ═══ AudioEngine ═══════════════════════════════════════════════════════════════
class AudioEngine {
    constructor() {
        this.sampler = new Tone.Sampler({
            urls:{
                A0:"A0.mp3",C1:"C1.mp3","D#1":"Ds1.mp3","F#1":"Fs1.mp3",
                A1:"A1.mp3",C2:"C2.mp3","D#2":"Ds2.mp3","F#2":"Fs2.mp3",
                A2:"A2.mp3",C3:"C3.mp3","D#3":"Ds3.mp3","F#3":"Fs3.mp3",
                A3:"A3.mp3",C4:"C4.mp3","D#4":"Ds4.mp3","F#4":"Fs4.mp3",
                A4:"A4.mp3",C5:"C5.mp3","D#5":"Ds5.mp3","F#5":"Fs5.mp3",
                A5:"A5.mp3",C6:"C6.mp3","D#6":"Ds6.mp3","F#6":"Fs6.mp3",
                A6:"A6.mp3",C7:"C7.mp3"
            },
            baseUrl:"https://tonejs.github.io/audio/salamander/",
            release:0.6
        }).toDestination();
        this.sampler.volume.value=-3;
        this.notes=[]; this.isPlaying=false; this.pauseOffset=0;
        this.scheduledIds=[]; this.tempo=80; this.introTimeoutId=null;
        this.dynamicsAmount=0.4;
        this.soloedTracks=new Set(); // empty = all voices active
    }
    loadTrack(buf) {
        const midi=new window.Midi(buf);
        this.tempo=(midi.header.tempos?.[0]?.bpm)||80;
        const notes=[]; let dur=0;
        midi.tracks.forEach((t,i)=>{
            t.notes.forEach(n=>{
                notes.push({time:n.time,duration:n.duration,midi:n.midi,velocity:n.velocity,track:i});
                dur=Math.max(dur,n.time+n.duration);
            });
        });
        this.notes=notes; return dur;
    }
    clearScheduled(){this.scheduledIds.forEach(id=>Tone.Transport.clear(id));this.scheduledIds=[];Tone.Transport.cancel(0);}
    cancelIntro(){if(this.introTimeoutId){clearTimeout(this.introTimeoutId);this.introTimeoutId=null;}}
    async play(startAt, useIntro, onComplete) {
        if(Tone.context.state!=='running') await Tone.start();
        Tone.Transport.stop(); this.clearScheduled(); this.cancelIntro(); this.sampler.releaseAll();
        const go=()=>{
            Tone.Transport.seconds=startAt;
            const solo=this.soloedTracks;
            this.notes.forEach(n=>{
                if(n.time<startAt-0.01) return;
                const isSoloed=solo.size>0&&!solo.has(n.track);
                const vel=isSoloed?0.03:0.5+(n.velocity-0.5)*this.dynamicsAmount;
                const id=Tone.Transport.schedule(t=>{
                    this.sampler.triggerAttackRelease(
                        Tone.Frequency(n.midi,"midi").toNote(),Math.max(n.duration,0.05),t,vel);
                },n.time);
                this.scheduledIds.push(id);
            });
            Tone.Transport.start(); this.isPlaying=true;
            if(onComplete) onComplete();
        };
        if(useIntro){
            this.isPlaying=true;
            this.introTimeoutId=setTimeout(()=>{this.introTimeoutId=null;go();},SILENT_INTRO*1000);
        } else go();
    }
    pause(){this.cancelIntro();this.isPlaying=false;this.pauseOffset=Math.max(0,Tone.Transport.seconds);Tone.Transport.pause();this.sampler.releaseAll();}
    stop(){this.cancelIntro();this.isPlaying=false;Tone.Transport.stop();this.clearScheduled();this.pauseOffset=0;this.sampler.releaseAll();}
}

// ═══ Renderer ══════════════════════════════════════════════════════════════════
// draw() is DRAW-ONLY. Binary searches and simple arithmetic — no musical analysis.
class Renderer {
    constructor(canvas) {
        this.canvas=canvas; this.ctx=canvas.getContext("2d",{alpha:false});
        this.notes=[]; this.notesSorted=[]; this.totalTime=0; this.isAnimating=false;
        this.view="architectural"; this.minMidi=36; this.maxMidi=84;
        this.tempo=80; this.measureDur=2; this.visualStartTime=0; this.smoothNow=0;
        this.hoveredVoice=null; this.voiceGroups={};
        this.analysisData=null;
        this.soloedTracks=new Set();
    }

    setup(notes, dur, tempo) {
        this.notes=notes; this.totalTime=dur; this.tempo=tempo||80;
        this.measureDur=(60/this.tempo)*4; this.smoothNow=0;
        this.voiceGroups={}; this.analysisData=null;
        if(!notes.length) return;
        let min=127,max=0;
        notes.forEach(n=>{min=Math.min(min,n.midi);max=Math.max(max,n.midi);});
        this.minMidi=Math.max(0,min-2); this.maxMidi=Math.min(127,max+2);
        this.notesSorted=[...notes].sort((a,b)=>a.time-b.time);
        notes.forEach(n=>{
            if(!this.voiceGroups[n.track]) this.voiceGroups[n.track]=[];
            this.voiceGroups[n.track].push(n);
        });
        Object.values(this.voiceGroups).forEach(g=>g.sort((a,b)=>a.time-b.time));
    }

    resize() {
        const dpr=window.devicePixelRatio||1;
        const cw=this.canvas.clientWidth||1, ch=this.canvas.clientHeight||1;
        const tw=Math.floor(cw*dpr), th=Math.floor(ch*dpr);
        if(this.canvas.width!==tw) this.canvas.width=tw;
        if(this.canvas.height!==th) this.canvas.height=th;
        this.ctx.setTransform(dpr,0,0,dpr,0,0);
        return {w:cw,h:ch};
    }
    clear(){const {w,h}=this.resize();this.ctx.fillStyle=BG_COLOR;this.ctx.fillRect(0,0,w,h);}

    whiteIndexOf(midi){
        const oct=Math.floor(midi/12), s=((midi%12)+12)%12; let idx=0;
        WHITE_KEY_SEMITONES.forEach(w=>{if(w<s)idx++;});
        return oct*7+idx;
    }
    midiToY(midi,top,height){
        const minW=this.whiteIndexOf(this.minMidi), maxW=this.whiteIndexOf(this.maxMidi);
        const span=maxW-minW||1, isW=WHITE_KEY_SEMITONES.includes(((midi%12)+12)%12);
        return top+(1-(this.whiteIndexOf(midi)+(isW?0:0.5)-minW)/span)*height;
    }
    getLayout(w,h){
        const mb=isMobile(), top=mb?16:24, bottom=mb?16:24, height=Math.max(10,h-top-bottom);
        const phX=mb?56:Math.min(220,w*0.18), rPad=mb?16:40;
        const pps=Math.max(20,(w-phX-rPad)/(measuresVisible()*this.measureDur));
        return {top,bottom,height,playheadX:phX,rightPad:rPad,pxPerSec:pps};
    }

    // ── Draw entry point ───────────────────────────────────────────────────────
    draw(audioTime, inIntro=false, introProgress=0) {
        const {w,h}=this.resize();
        this.ctx.fillStyle=BG_COLOR; this.ctx.fillRect(0,0,w,h);
        if(!this.notes.length) return;

        const tgt=inIntro?-SILENT_INTRO*(1-introProgress):audioTime;
        if(this.isAnimating){const d=tgt-this.smoothNow;this.smoothNow+=d*(Math.abs(d)>1?1:0.3);}
        else this.smoothNow=tgt;
        const now=this.smoothNow;
        const {top,height,playheadX,pxPerSec}=this.getLayout(w,h);

        let gFade=inIntro?introProgress:Math.min(1,Math.max(0,(audioTime-this.visualStartTime)/1.0+0.3));
        const eFade=(audioTime>this.totalTime-2&&!inIntro)?Math.max(0,1-(audioTime-(this.totalTime-2))/2):1;
        this.ctx.globalAlpha=Math.max(0.001,gFade*eFade);

        this._drawPitchAxis(w,top,height);

        if(this.view!=='voice-constellation')
            this._drawTimeGrid(now,w,top,height,playheadX,pxPerSec);

        if      (this.view==='architectural')       this._drawArchitectural(now,w,top,height,playheadX,pxPerSec);
        else if (this.view==='melodic-contour')     this._drawMelodicContour(now,w,top,height,playheadX,pxPerSec);
        else if (this.view==='voice-constellation') this._drawVoiceConstellation(Math.max(0,audioTime),w,h);

        // Only the canon handoff (five dots) remains
        if(this.analysisData?.ready && this.view!=='voice-constellation'){
            this._drawGhostHandoff(now,w,top,height,playheadX,pxPerSec);
        }

        if(this.view!=='voice-constellation')
            this._drawPlayhead(playheadX,top,height);

        this.ctx.globalAlpha=1;
        if(audioTime>=this.totalTime&&this.totalTime>0&&!inIntro){
            const fo=Math.max(0,1-(audioTime-this.totalTime)/3);
            if(fo>0){
                this.ctx.save();
                this.ctx.globalAlpha=fo*0.55;
                this.ctx.fillStyle=getPalette().ink;
                this.ctx.font=`italic ${isMobile()?16:18}px 'EB Garamond',serif`;
                this.ctx.textAlign='center'; this.ctx.textBaseline='middle';
                this.ctx.fillText('— fin —',w/2,h/2);
                this.ctx.restore();
            }
        }
    }

    _drawPitchAxis(w, top, height) {
        const ctx=this.ctx, mb=isMobile();
        ctx.save();
        ctx.font=`italic ${mb?8:9}px 'EB Garamond',serif`;
        ctx.textAlign='left'; ctx.textBaseline='middle';
        for(let midi=12;midi<=108;midi+=12){
            if(midi<this.minMidi||midi>this.maxMidi) continue;
            const y=Math.floor(this.midiToY(midi,top,height));
            ctx.fillStyle='rgba(232,212,162,0.20)';
            if(!mb) ctx.fillText(`C${Math.floor(midi/12)-1}`,14,y);
            ctx.strokeStyle='rgba(232,212,162,0.04)'; ctx.lineWidth=0.5;
            ctx.beginPath(); ctx.moveTo(mb?8:38,y); ctx.lineTo(w-16,y); ctx.stroke();
        }
        ctx.restore();
    }

    _drawTimeGrid(now, w, top, height, playheadX, pxPerSec) {
        const bd=60/this.tempo, md=this.measureDur;
        const endT=now+(w-playheadX)/pxPerSec+1;
        const startT=Math.floor((now-1.5)/bd)*bd;
        const lb=isMobile()?8:40, rb=w-16;
        const ctx=this.ctx; ctx.save(); ctx.lineWidth=0.5;
        for(let t=startT;t<=endT;t+=bd){
            const x=Math.floor(playheadX+(t-now)*pxPerSec);
            if(x<lb||x>rb) continue;
            const mp=((t/md)%1+1)%1, isM=mp<0.01||mp>0.99;
            const isS=Math.round(t/bd)%2===0;
            const edge=Math.min(1,Math.min(x-lb,rb-x)/50);
            ctx.strokeStyle=`rgba(232,212,162,${(isM?0.10:isS?0.045:0.025)*Math.max(0,edge)})`;
            ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,top+height); ctx.stroke();
        }
        ctx.restore();
    }

    _drawPlayhead(x, top, height) {
        const ctx=this.ctx, xi=Math.floor(x); ctx.save();
        const g=ctx.createLinearGradient(0,top,0,top+height);
        g.addColorStop(0,'rgba(201,169,97,0)');
        g.addColorStop(0.5,'rgba(201,169,97,0.4)');
        g.addColorStop(1,'rgba(201,169,97,0)');
        ctx.strokeStyle=g; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(xi,top); ctx.lineTo(xi,top+height); ctx.stroke();
        ctx.restore();
    }

    // ── Architectural view ─────────────────────────────────────────────────────
    _drawArchitectural(now, w, top, height, playheadX, pxPerSec) {
        const lb=3.5, we=now+(w-playheadX)/pxPerSec+0.5, ws=now-lb;
        const ba=this.ctx.globalAlpha, pal=getPalette(), solo=this.soloedTracks;
        for(const n of this.notesSorted){
            if(n.time>we) break;
            if(n.time+n.duration<=ws) continue;
            const x=Math.floor(playheadX+(n.time-now)*pxPerSec);
            const nW=Math.max(2,Math.floor(n.duration*pxPerSec));
            const y=Math.floor(this.midiToY(n.midi,top,height));
            const act=now>=n.time&&now<=n.time+n.duration;
            const past=now>n.time+n.duration;
            let a=act?1:past?Math.max(0,0.32*(1-(now-(n.time+n.duration))/lb)):0.55;
            a*=0.55+((typeof n.velocity==='number'?n.velocity:0.7))*0.45;
            if(solo.size>0) a*=solo.has(n.track)?1:0.07;
            if(this.hoveredVoice!==null) a=this.hoveredVoice===n.track?Math.min(1,a*1.35):a*0.25;
            const wt=Math.min(1,n.duration/this.measureDur), nH=3+wt*8;
            const color=pal.voices[n.track%pal.voices.length];
            this.ctx.save();
            this.ctx.globalAlpha=Math.min(1,a)*ba;
            this.ctx.fillStyle=color;
            this._rr(x,y-Math.floor(nH/2),nW,Math.ceil(nH),Math.min(1.5,nH/2));
            this.ctx.fill();
            if(act){
                this.ctx.strokeStyle='rgba(255,248,220,0.45)';
                this.ctx.lineWidth=0.5;
                this._rr(x+1,y-Math.floor(nH/2)+1,Math.max(1,nW-2),Math.max(1,Math.ceil(nH)-2),1);
                this.ctx.stroke();
            }
            this.ctx.restore();
        }
    }

    // ── Melodic Contour view ───────────────────────────────────────────────────
    _drawMelodicContour(now, w, top, height, playheadX, pxPerSec) {
        const lb=4, fwd=(w-playheadX)/pxPerSec+0.5;
        const ba=this.ctx.globalAlpha, pal=getPalette(), solo=this.soloedTracks;
        Object.entries(this.voiceGroups).forEach(([ts,notes])=>{
            const track=parseInt(ts,10), color=pal.voices[track%pal.voices.length];
            const vis=notes.filter(n=>n.time>(now-lb)&&n.time<(now+fwd));
            if(vis.length<2) return;
            const hasAct=vis.some(n=>now>=n.time&&now<=n.time+n.duration);
            let va=hasAct?0.7:0.32, lw=hasAct?1.3:0.75;
            if(solo.size>0) va*=solo.has(track)?1:0.07;
            if(this.hoveredVoice!==null){if(this.hoveredVoice===track){va=0.95;lw=1.6;}else va*=0.3;}
            this.ctx.save();
            this.ctx.strokeStyle=color; this.ctx.lineWidth=lw;
            this.ctx.globalAlpha=va*ba;
            this.ctx.lineCap='round'; this.ctx.lineJoin='round';
            this.ctx.beginPath();
            vis.forEach((n,i)=>{
                const x=Math.floor(playheadX+(n.time-now)*pxPerSec);
                const y=Math.floor(this.midiToY(n.midi,top,height));
                if(i===0)this.ctx.moveTo(x,y);else this.ctx.lineTo(x,y);
            });
            this.ctx.stroke();
            vis.forEach(n=>{
                if(!(now>=n.time&&now<=n.time+n.duration)) return;
                const x=Math.floor(playheadX+(n.time-now)*pxPerSec);
                const y=Math.floor(this.midiToY(n.midi,top,height));
                this.ctx.globalAlpha=ba; this.ctx.fillStyle=color;
                this.ctx.beginPath(); this.ctx.arc(x,y,3,0,Math.PI*2); this.ctx.fill();
            });
            this.ctx.restore();
        });
    }

    // ── Voice Constellation ────────────────────────────────────────────────────
    _drawVoiceConstellation(now, w, h) {
        const mb=isMobile(), top=mb?60:90, bot=mb?40:60;
        const height=Math.max(10,h-top-bot), cx=Math.floor(w/2);
        const ba=this.ctx.globalAlpha, pal=getPalette(), ctx=this.ctx;
        const solo=this.soloedTracks;

        ctx.save();
        ctx.font=`italic ${mb?9:10}px 'EB Garamond',serif`;
        ctx.textAlign='left'; ctx.textBaseline='middle';
        for(let midi=12;midi<=108;midi+=12){
            if(midi<this.minMidi||midi>this.maxMidi) continue;
            const y=Math.floor(this.midiToY(midi,top,height));
            ctx.strokeStyle='rgba(232,212,162,0.05)'; ctx.lineWidth=0.5;
            ctx.beginPath(); ctx.moveTo(Math.floor(w*0.15),y); ctx.lineTo(Math.floor(w*0.85),y); ctx.stroke();
            ctx.fillStyle='rgba(232,212,162,0.18)';
            ctx.fillText(`C${Math.floor(midi/12)-1}`,Math.floor(w*0.12),y);
        }
        ctx.restore();

        // Chord from pre-calculated stable timeline (we still compute it but only show here)
        const chord=this.analysisData?.ready?this.analysisData.chordAt(now):null;
        if(chord?.name){
            const QM={
                "":"major","m":"minor","°":"diminished","⁺":"augmented",
                "⁷":"dominant 7th","maj⁷":"major 7th","m⁷":"minor 7th",
                "ø":"half-diminished","°⁷":"diminished 7th",
                "sus⁴":"suspended 4th","sus²":"suspended 2nd"
            };
            ctx.save();
            ctx.globalAlpha=ba*0.82; ctx.fillStyle=pal.ink;
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.font=`italic 500 ${mb?28:38}px 'EB Garamond',serif`;
            ctx.fillText(chord.name,cx,mb?28:42);
            if(chord.interval||chord.quality!==undefined){
                ctx.globalAlpha=ba*0.33; ctx.fillStyle=pal.gold;
                ctx.font=`italic ${mb?9:10}px 'EB Garamond',serif`;
                const lbl=chord.interval?(chord.interval+'  ·  interval').toUpperCase():(QM[chord.quality]||'').toUpperCase().split('').join(' ');
                if(lbl) ctx.fillText(lbl,cx,mb?48:68);
            }
            ctx.restore();
        }

        const active=this.notes.filter(n=>now>=n.time&&now<=n.time+n.duration);
        if(!active.length) return;
        active.sort((a,b)=>a.track-b.track||a.midi-b.midi);
        const spread=Math.min(w*0.5,400);
        const pts=active.map((n,i)=>({
            x:Math.floor(cx-spread/2+(active.length===1?0.5:i/(active.length-1))*spread),
            y:Math.floor(this.midiToY(n.midi,top,height)),n
        }));

        if(pts.length>1){
            ctx.save(); ctx.strokeStyle=pal.gold; ctx.globalAlpha=ba*0.22; ctx.lineWidth=0.75;
            ctx.beginPath();
            pts.forEach((p,i)=>{if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);});
            ctx.stroke(); ctx.restore();
        }

        const NN=['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
        pts.forEach(p=>{
            const color=pal.voices[p.n.track%pal.voices.length];
            const dim=solo.size>0&&!solo.has(p.n.track);
            ctx.save();
            const gr=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,22);
            gr.addColorStop(0,color); gr.addColorStop(1,'rgba(0,0,0,0)');
            ctx.globalAlpha=ba*(dim?0.06:0.27); ctx.fillStyle=gr;
            ctx.beginPath(); ctx.arc(p.x,p.y,22,0,Math.PI*2); ctx.fill();
            ctx.restore();
            ctx.save(); ctx.globalAlpha=ba*(dim?0.1:1); ctx.fillStyle=color;
            ctx.beginPath(); ctx.arc(p.x,p.y,4,0,Math.PI*2); ctx.fill(); ctx.restore();
            ctx.save(); ctx.globalAlpha=ba*(dim?0.1:0.48); ctx.fillStyle=pal.ink;
            ctx.font=`italic ${mb?10:11}px 'EB Garamond',serif`;
            ctx.textAlign='center'; ctx.textBaseline='top';
            ctx.fillText(`${NN[((p.n.midi%12)+12)%12]}${Math.floor(p.n.midi/12)-1}`,p.x,p.y+10);
            ctx.restore();
        });
    }

    // ── Canon Ghost Hand-off (five dots) — the only analysis overlay kept ─────
    _drawGhostHandoff(now, w, top, height, playheadX, pxPerSec) {
        if(!this.analysisData?.ghostPaths.length) return;
        const pal=getPalette(), ba=this.ctx.globalAlpha;
        this.analysisData.ghostPaths.forEach(path=>{
            const dur=Math.max(0.2, path.endTime-path.startTime);
            if(now<path.startTime||now>path.endTime+0.45) return;
            const raw=(now-path.startTime)/dur;
            const prog=Math.min(1, Math.max(0, raw));
            // Ease in-out
            const t=prog<0.5 ? 2*prog*prog : 1-2*(1-prog)*(1-prog);
            // Plateau + graceful fade: holds longer, then fades elegantly
            let fade;
            if (prog < 0.1) fade = prog / 0.1;
            else if (prog > 0.75) fade = Math.max(0, 1 - (prog - 0.75) / 0.25);
            else fade = 1.0;
            fade *= 0.95; // slight overall softness

            if(fade < 0.01) return;

            const fromY=Math.floor(this.midiToY(path.fromMidi,top,height));
            const toY  =Math.floor(this.midiToY(path.toMidi,  top,height));
            const fromX=Math.floor(playheadX+(path.startTime-now)*pxPerSec);
            const toX  =Math.floor(playheadX+(path.endTime  -now)*pxPerSec);
            const cpX=Math.floor((fromX+toX)/2);
            const cpY=Math.floor(Math.min(fromY,toY)-Math.abs(toX-fromX)*0.28-24);
            const mt=1-t;
            const cx=Math.floor(mt*mt*fromX+2*mt*t*cpX+t*t*toX);
            const cy=Math.floor(mt*mt*fromY+2*mt*t*cpY+t*t*toY);

            const color=pal.voices[path.fromTrack%pal.voices.length];
            const ctx=this.ctx;

            ctx.save();
            // Arc trail
            ctx.globalAlpha=ba*fade*0.18;
            ctx.strokeStyle=color; ctx.lineWidth=1.2;
            ctx.beginPath();
            ctx.moveTo(fromX,fromY);
            ctx.quadraticCurveTo(cpX,cpY,cx,cy);
            ctx.stroke();

            // Motif contour cluster (five dots)
            const noteCount=path.noteMidis.length;
            path.noteMidis.forEach((midi,i)=>{
                const tFrac=path.duxDuration>0 ? path.noteTimeOffsets[i]/path.duxDuration : i/(noteCount-1||1);
                const dotX=cx+Math.floor((tFrac-0.5)*52);
                const naturalY=Math.floor(this.midiToY(midi,top,height));
                const dotY=Math.floor(naturalY*(1-t)+cy*t);
                const isFirst=i===0;
                let dotAlpha = ba * fade * (isFirst ? 0.72 : 0.45);
                if (t > 0.8) {
                    const merge = (t-0.8)/0.2;
                    dotAlpha *= (1 - merge);
                }
                ctx.globalAlpha = Math.min(1, dotAlpha);
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(dotX, dotY, isFirst ? 4.5 : 2.8, 0, Math.PI*2);
                ctx.fill();
            });

            // Elegant arrival pulse at destination
            if(t > 0.7){
                const arrivalFade = Math.min(1, (t-0.7)/0.3) * (1 - Math.max(0, (prog-0.9)/0.1));
                if(arrivalFade > 0.01){
                    ctx.globalAlpha = ba * arrivalFade * 0.5;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.arc(toX, toY, 12 + (t-0.7)*8, 0, Math.PI*2);
                    ctx.stroke();
                }
            }
            ctx.restore();
        });
    }

    noteAt(mx, my, now, w, h) {
        const {top,height,playheadX,pxPerSec}=this.getLayout(w,h);
        for(const n of this.notes){
            const x=playheadX+(n.time-now)*pxPerSec, nW=Math.max(n.duration*pxPerSec,2);
            if(mx<x-2||mx>x+nW+2) continue;
            const y=this.midiToY(n.midi,top,height), nH=3+Math.min(1,n.duration/this.measureDur)*8;
            if(Math.abs(my-y)<=nH/2+3) return n;
        }
        return null;
    }

    _rr(x,y,w,h,r){
        const c=this.ctx; r=Math.max(0,Math.min(r,w/2,h/2));
        c.beginPath(); c.moveTo(x+r,y); c.lineTo(x+w-r,y);
        c.quadraticCurveTo(x+w,y,x+w,y+r); c.lineTo(x+w,y+h-r);
        c.quadraticCurveTo(x+w,y+h,x+w-r,y+h); c.lineTo(x+r,y+h);
        c.quadraticCurveTo(x,y+h,x,y+h-r); c.lineTo(x,y+r);
        c.quadraticCurveTo(x,y,x+r,y); c.closePath();
    }
}

// ═══ App ═══════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
    const canvas   = document.getElementById("visualizer");
    const ren      = new Renderer(canvas);
    const engine   = new AudioEngine();
    const lib      = new BachLibrary();
    const analysis = new AnalysisEngine();

    const tSel          = document.getElementById("track-selector");
    const vSel          = document.getElementById("view-selector");
    const playBtn       = document.getElementById("play-toggle");
    const seek          = document.getElementById("seek-slider");
    const prog          = document.getElementById("scrubber-progress");
    const timeDisp      = document.getElementById("time-display");
    const titleEl       = document.getElementById("work-title");
    const metaEl        = document.getElementById("work-meta");
    const paletteToggle = document.getElementById("palette-toggle");
    const paletteMenu   = document.getElementById("palette-menu");
    const dynSlider     = document.getElementById("dynamics-slider");
    const dynLabel      = document.getElementById("dynamics-label");
    const voiceIso      = document.getElementById("voice-iso");

    let hasPlayedOnce=false, introActive=false, introStartWallTime=0;
    let soloedTracks=new Set();

    ren.clear();

    const ro = new ResizeObserver(() => {
        if (!ren.isAnimating) {
            if (ren.notes.length > 0) ren.draw(engine.pauseOffset || 0, false);
            else ren.clear();
        }
    });
    ro.observe(canvas);

    function buildVoiceButtons() {
        voiceIso.innerHTML = '';
        const ids = Object.keys(ren.voiceGroups).map(Number).sort((a,b)=>a-b);
        if (ids.length < 2) { voiceIso.style.display = 'none'; return; }
        ids.forEach(id => {
            const ns = ren.voiceGroups[id] || [];
            const avg = ns.length ? ns.reduce((s,n)=>s+n.midi,0)/ns.length : 60;
            const label = avg>72?'S':avg>60?'A':avg>48?'T':'B';
            const btn = document.createElement('button');
            btn.className = 'voice-btn';
            btn.dataset.track = id;
            btn.textContent = label;
            btn.addEventListener('click', () => toggleVoice(id));
            voiceIso.appendChild(btn);
        });
        voiceIso.style.display = 'flex';
    }

    function toggleVoice(id) {
        if (soloedTracks.has(id)) soloedTracks.delete(id);
        else soloedTracks.add(id);
        updateVoiceBtnUI();
        ren.soloedTracks = new Set(soloedTracks);
        engine.soloedTracks = new Set(soloedTracks);
        if (engine.isPlaying && !introActive) {
            const t = Math.max(0, Tone.Transport.seconds);
            engine.play(t, false, () => {});
        } else if (!ren.isAnimating && ren.notes.length > 0) {
            ren.draw(engine.pauseOffset || 0, false);
        }
    }

    function updateVoiceBtnUI() {
        voiceIso.querySelectorAll('.voice-btn').forEach(btn => {
            const id = parseInt(btn.dataset.track);
            btn.classList.remove('solo', 'muted');
            if (soloedTracks.size === 0) return;
            if (soloedTracks.has(id)) btn.classList.add('solo');
            else btn.classList.add('muted');
        });
    }

    if (dynSlider) {
        dynSlider.value = Math.round(engine.dynamicsAmount * 100);
        const upd = v => {
            if (!dynLabel) return;
            const p = Math.round(v);
            dynLabel.textContent = p<=5?'organ':p<=30?'subtle':p<=60?'expressive':p<=80?'dramatic':'full';
        };
        upd(dynSlider.value);
        dynSlider.addEventListener("input", e => { engine.dynamicsAmount=e.target.value/100; upd(e.target.value); });
    }

    function renderPaletteToggle() {
        paletteToggle.innerHTML = '';
        getPalette().voices.slice(0,4).forEach(c=>{
            const s=document.createElement("span"); s.className="strip"; s.style.background=c;
            paletteToggle.appendChild(s);
        });
    }
    function renderPaletteMenu() {
        paletteMenu.innerHTML = '';
        Object.entries(PALETTES).forEach(([key,p])=>{
            const btn=document.createElement("button");
            btn.className="palette-option"+(key===activePalette?" active":"");
            const sw=document.createElement("div"); sw.className="palette-swatches";
            p.voices.slice(0,4).forEach(c=>{const s=document.createElement("span");s.className="strip";s.style.background=c;sw.appendChild(s);});
            const lbl=document.createElement("span"); lbl.textContent=p.name;
            btn.appendChild(sw); btn.appendChild(lbl);
            btn.onclick=e=>{
                e.stopPropagation(); activePalette=key;
                renderPaletteToggle(); renderPaletteMenu();
                paletteMenu.classList.remove("open");
                if(!ren.isAnimating&&ren.notes.length>0) ren.draw(engine.pauseOffset||0,false);
            };
            paletteMenu.appendChild(btn);
        });
    }
    paletteToggle.onclick=e=>{e.stopPropagation();paletteMenu.classList.toggle("open");};
    document.addEventListener("click",e=>{if(!paletteMenu.contains(e.target)&&e.target!==paletteToggle)paletteMenu.classList.remove("open");});
    renderPaletteToggle(); renderPaletteMenu();

    try {
        await lib.load("./bach.zip");
        tSel.innerHTML = "";
        const folders = Object.entries(lib.tree).sort(([a],[b])=>a.localeCompare(b));
        if (!folders.length) {
            tSel.innerHTML="<option>No MIDI files found</option>";
            titleEl.textContent="Library empty"; titleEl.classList.remove("breathing","loading");
        } else {
            folders.forEach(([f,files])=>{
                const g=document.createElement("optgroup"); g.label=f;
                files.sort().forEach(file=>{
                    const o=document.createElement("option"); o.value=file; o.textContent=parseTitle(file).title;
                    g.appendChild(o);
                });
                tSel.appendChild(g);
            });
            tSel.disabled=false; playBtn.disabled=false; updateTitle(true);
        }
    } catch(e) {
        console.error("Library load failed:",e);
        titleEl.textContent="Could not load library"; titleEl.classList.remove("breathing","loading");
    }

    function updateTitle(immediate) {
        const apply=()=>{
            const p=parseTitle(tSel.value||"");
            titleEl.classList.remove("loading","breathing");
            titleEl.textContent=p.title; metaEl.textContent=p.meta; titleEl.style.opacity='';
        };
        if(immediate){apply();return;}
        titleEl.style.opacity='0'; setTimeout(apply,260);
    }

    vSel.onchange=e=>{
        ren.view=e.target.value;
        if(!ren.isAnimating&&ren.notes.length>0) ren.draw(engine.pauseOffset||0,false);
        else if(!ren.isAnimating) ren.clear();
    };

    tSel.onchange=()=>{
        engine.stop();
        ren.notes=[]; ren.totalTime=0; ren.isAnimating=false; ren.smoothNow=0;
        hasPlayedOnce=false; introActive=false;
        analysis.ready=false; ren.analysisData=null;
        soloedTracks=new Set(); ren.soloedTracks=new Set(); engine.soloedTracks=new Set();
        voiceIso.innerHTML=''; voiceIso.style.display='none';
        ren.clear(); prog.style.width="0%"; seek.value=0; seek.disabled=true;
        playBtn.textContent="Play"; playBtn.disabled=false; timeDisp.textContent="0:00 / 0:00";
        updateTitle(false);
    };

    let rafId=null, isDragging=false;
    const stopLoop=()=>{if(rafId){cancelAnimationFrame(rafId);rafId=null;}};
    const startLoop=()=>{
        stopLoop();
        const loop=()=>{
            if(!ren.isAnimating){rafId=null;return;}
            if(introActive){
                const ip=Math.min(1,(performance.now()-introStartWallTime)/1000/SILENT_INTRO);
                ren.draw(0,true,ip); rafId=requestAnimationFrame(loop); return;
            }
            const t=Math.max(0,Tone.Transport.seconds);
            ren.draw(t,false);
            if(ren.totalTime>0){
                const ratio=Math.min(Math.max(t,0)/ren.totalTime,1);
                prog.style.width=(ratio*100)+"%";
                if(!isDragging) seek.value=ratio*1000;
                timeDisp.textContent=`${formatTime(t)} / ${formatTime(ren.totalTime)}`;
                if(t>=ren.totalTime+3.2){
                    engine.stop(); ren.isAnimating=false; hasPlayedOnce=false;
                    playBtn.textContent="Play"; seek.value=0; prog.style.width="0%";
                    timeDisp.textContent=`0:00 / ${formatTime(ren.totalTime)}`; return;
                }
            }
            rafId=requestAnimationFrame(loop);
        };
        rafId=requestAnimationFrame(loop);
    };

    const doPlay=async()=>{
        try{
            if(ren.notes.length===0){
                const buf=lib.works.get(tSel.value); if(!buf) return;
                const dur=engine.loadTrack(buf);
                ren.setup(engine.notes,dur,engine.tempo);
                buildVoiceButtons();
                setTimeout(()=>{
                    analysis.analyze(engine.notes,dur,engine.tempo);
                    ren.analysisData=analysis;
                },0);
            }
            await Tone.loaded();
            const useIntro=!hasPlayedOnce&&engine.pauseOffset===0;
            ren.visualStartTime=engine.pauseOffset;
            if(useIntro){introActive=true;introStartWallTime=performance.now();ren.smoothNow=-SILENT_INTRO;}
            else introActive=false;
            await engine.play(engine.pauseOffset,useIntro,()=>{
                introActive=false; ren.visualStartTime=Tone.Transport.seconds;
            });
            hasPlayedOnce=true; ren.isAnimating=true; startLoop();
            playBtn.textContent="Pause"; seek.disabled=false;
        } catch(e){console.error("Play failed:",e);}
    };
    const doPause=()=>{
        introActive=false; engine.pause(); ren.isAnimating=false; stopLoop();
        playBtn.textContent="Resume";
    };
    playBtn.onclick=()=>{if(engine.isPlaying||introActive)doPause();else doPlay();};

    let wasPlaying=false;
    const onSeekStart=()=>{
        if(ren.totalTime<=0) return;
        isDragging=true; wasPlaying=engine.isPlaying&&!introActive;
        if(engine.isPlaying){engine.cancelIntro();introActive=false;Tone.Transport.pause();engine.sampler.releaseAll();}
        ren.isAnimating=false; stopLoop();
    };
    const onSeekInput=e=>{
        if(ren.totalTime<=0) return;
        const t=(e.target.value/1000)*ren.totalTime;
        ren.visualStartTime=t; ren.smoothNow=t; ren.draw(t,false);
        prog.style.width=(e.target.value/10)+"%";
        timeDisp.textContent=`${formatTime(t)} / ${formatTime(ren.totalTime)}`;
    };
    const onSeekEnd=async e=>{
        if(!isDragging) return; isDragging=false;
        if(ren.totalTime<=0) return;
        const newT=(e.target.value/1000)*ren.totalTime;
        engine.pauseOffset=newT;
        if(wasPlaying){
            ren.visualStartTime=newT; ren.smoothNow=newT;
            await engine.play(newT,false,()=>{});
            ren.isAnimating=true; startLoop();
        } else ren.draw(newT,false);
    };
    seek.addEventListener("pointerdown",onSeekStart);
    seek.addEventListener("input",onSeekInput);
    seek.addEventListener("pointerup",onSeekEnd);
    seek.addEventListener("pointercancel",onSeekEnd);

    if(window.matchMedia("(hover:hover)").matches){
        canvas.addEventListener("mousemove",e=>{
            if(ren.view==='voice-constellation'){
                if(ren.hoveredVoice!==null){ren.hoveredVoice=null;if(!ren.isAnimating)ren.draw(engine.pauseOffset||0,false);}
                return;
            }
            const rect=canvas.getBoundingClientRect();
            const note=ren.noteAt(e.clientX-rect.left,e.clientY-rect.top,
                introActive?0:Math.max(0,Tone.Transport.seconds),canvas.clientWidth,canvas.clientHeight);
            const nv=note?note.track:null;
            if(nv!==ren.hoveredVoice){ren.hoveredVoice=nv;if(!ren.isAnimating)ren.draw(engine.pauseOffset||0,false);}
        });
        canvas.addEventListener("mouseleave",()=>{
            if(ren.hoveredVoice!==null){ren.hoveredVoice=null;if(!ren.isAnimating)ren.draw(engine.pauseOffset||0,false);}
        });
    }

    document.addEventListener("keydown",e=>{
        if(e.target.tagName==="SELECT"||e.target.tagName==="INPUT") return;
        if(e.code==="Space"){e.preventDefault();if(!playBtn.disabled)playBtn.click();}
        else if(e.code==="ArrowLeft"||e.code==="ArrowRight"){
            if(ren.totalTime<=0) return; e.preventDefault();
            const delta=e.code==="ArrowLeft"?-5:5;
            const newT=Math.max(0,Math.min(ren.totalTime,Math.max(0,Tone.Transport.seconds)+delta));
            engine.pauseOffset=newT; ren.visualStartTime=newT; ren.smoothNow=newT;
            if(engine.isPlaying&&!introActive) engine.play(newT,false,()=>{});
            else ren.draw(newT,false);
            const ratio=newT/ren.totalTime;
            seek.value=ratio*1000; prog.style.width=(ratio*100)+"%";
            timeDisp.textContent=`${formatTime(newT)} / ${formatTime(ren.totalTime)}`;
        }
    });

    ren.clear();
});
