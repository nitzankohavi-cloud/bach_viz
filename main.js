// ═══════════════════════════════════════════════════════════════════════════════
// Bach Visualisation · Master Edition (V.Final - Core Sync Fix)
// ═══════════════════════════════════════════════════════════════════════════════

class BachLibrary {
    constructor() { this.works = new Map(); this.tree = {}; }
    async loadFromUrl(url) {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const zip = await window.JSZip.loadAsync(blob);
        const promises = [];
        zip.forEach((rel, entry) => {
            if (entry.dir || !rel.match(/\.(mid|midi)$/i)) return;
            const clean = rel.replace(/^bach\//, '');
            const folder = clean.split('/')[0] || 'Uncategorized';
            if (!this.tree[folder]) this.tree[folder] = [];
            this.tree[folder].push(clean);
            promises.push(entry.async("arraybuffer").then(b => this.works.set(clean, b)));
        });
        await Promise.all(promises);
    }
    getWork(path) { return this.works.get(path); }
}

class AudioEngine {
    constructor() {
        this.piano = new Tone.Sampler({
            urls: { A0: "A0.mp3", C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3", A1: "A1.mp3", C2: "C2.mp3", A2: "A2.mp3", C3: "C3.mp3", A3: "A3.mp3", C4: "C4.mp3", A4: "A4.mp3", C5: "C5.mp3", A5: "A5.mp3", C6: "C6.mp3", A6: "A6.mp3", C7: "C7.mp3", A7: "A7.mp3", C8: "C8.mp3" },
            baseUrl: "https://tonejs.github.io/audio/salamander/",
            release: 1.5
        }).toDestination();
        this.pauseOffset = 0; this.isPlaying = false; this.currentNotes = [];
    }
    async loadMidi(buf) {
        const midi = new Midi(buf);
        this.currentNotes = [];
        let total = 0;
        midi.tracks.forEach((t, i) => {
            t.notes.forEach(n => {
                this.currentNotes.push({ time: n.time, duration: n.duration, midi: n.midi, velocity: n.velocity, trackIndex: i });
                if (n.time + n.duration > total) total = n.time + n.duration;
            });
        });
        return total;
    }
    async play(start = this.pauseOffset) {
        if (Tone.context.state !== 'running') await Tone.start();
        await Tone.loaded();
        this.isPlaying = true; this.pauseOffset = start;
        Tone.Transport.stop(); Tone.Transport.cancel(0); Tone.Transport.seconds = start;
        this.currentNotes.forEach(n => {
            if (n.time < start) return;
            Tone.Transport.schedule(t => this.piano.triggerAttackRelease(Tone.Frequency(n.midi, "midi").toNote(), n.duration, t, n.velocity), n.time);
        });
        Tone.Transport.start();
    }
    pause() { this.isPlaying = false; Tone.Transport.pause(); this.pauseOffset = Tone.Transport.seconds; this.piano.releaseAll(); }
    stop() { this.isPlaying = false; Tone.Transport.stop(); Tone.Transport.cancel(0); this.pauseOffset = 0; this.piano.releaseAll(); }
}

class CanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas; this.ctx = canvas.getContext("2d", { alpha: false });
        this.noteEvents = []; this.totalDuration = 0; this.isAnimating = false;
        this._voiceNotes = [[], [], [], [], []]; this.pixelsPerSecond = 180;
        this.palettes = [ ["#D4AF37", "#8C92AC", "#C0C0C0", "#A9A9A9", "#E5E4E2"], ["#E27D60", "#85DCBA", "#E8A87C", "#C38D9E", "#41B3A3"], ["#FFFFFF", "#CCCCCC", "#999999", "#666666", "#333333"] ];
        this.currentPalette = 0; this.analyticalView = "architectural";
        this.resizeForDpi();
    }
    reset() {
        this.stop(); this.noteEvents = []; this._voiceNotes = [[], [], [], [], []];
        this.totalDuration = 0; this.drawPlaceholder("Ready");
    }
    setMidiData(notes, total) {
        this.noteEvents = notes.sort((a,b) => a.time - b.time);
        this.totalDuration = total;
        let min = 127, max = 0;
        notes.forEach(n => { if(n.midi < min) min = n.midi; if(n.midi > max) max = n.midi; });
        this.minMidi = min - 4; this.maxMidi = max + 4;
        this._voiceNotes = [[], [], [], [], []];
        notes.forEach(n => this._voiceNotes[Math.min(4, n.trackIndex)].push(n));
    }
    resizeForDpi() {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = this.canvas.clientWidth * dpr;
        this.canvas.height = this.canvas.clientHeight * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    drawFrame(now) {
        this.resizeForDpi();
        const ctx = this.ctx; const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        const l = { w, h, top: 40, bot: 48, span: this.maxMidi - this.minMidi, uh: h - 88 };
        this.playheadX = w < 768 ? 60 : 180;
        
        ctx.fillStyle = "#07080A"; ctx.fillRect(0,0,w,h);
        
        const visible = this.noteEvents.filter(n => (n.time + n.duration) > (now - 2) && n.time < (now + w/this.pixelsPerSecond));

        if (this.analyticalView === "melodic-contour") this._drawContour(now, l, visible);
        else if (this.analyticalView === "architectural") this._drawArchitectural(now, l, visible);
        else this._drawLattice(now, l, visible);

        ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.beginPath(); ctx.moveTo(this.playheadX, l.top); ctx.lineTo(this.playheadX, h - l.bot); ctx.stroke();
    }
    _nx(t, now) { return this.playheadX + (t - now) * this.pixelsPerSecond; }
    _ny(m, l) { return l.top + (1 - (m - this.minMidi) / l.span) * l.uh; }

    _drawArchitectural(now, l, visible) {
        visible.forEach(n => {
            const x = this._nx(n.time, now), y = this._ny(n.midi, l) - 6;
            const active = now >= n.time && now <= n.time + n.duration;
            this.ctx.globalAlpha = active ? 1 : (now > n.time ? 0.2 : 0.6);
            this.ctx.fillStyle = this.palettes[this.currentPalette][n.trackIndex % 5];
            this.ctx.fillRect(x, y, n.duration * this.pixelsPerSecond, 12);
        });
    }

    _drawContour(now, l, visible) {
        this.ctx.save();
        for (let v=0; v<5; v++) {
            const notes = this._voiceNotes[v]; if (!notes.length) continue;
            this.ctx.beginPath(); let first = true;
            notes.forEach(n => {
                const x = this._nx(n.time, now), y = this._ny(n.midi, l);
                if (x < -50 || x > l.w + 50) return;
                if (first) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
                first = false;
            });
            this.ctx.strokeStyle = this.palettes[this.currentPalette][v]; this.ctx.globalAlpha = 0.3; this.ctx.lineWidth = 2; this.ctx.stroke();
        }
        this.ctx.restore();
    }

    _drawLattice(now, l, visible) {
        const sounding = visible.filter(n => now >= n.time && now <= n.time + n.duration);
        if (sounding.length >= 2) {
            const ys = sounding.map(n => this._ny(n.midi, l));
            this.ctx.strokeStyle = "white"; this.ctx.lineWidth = 2;
            this.ctx.beginPath(); this.ctx.moveTo(this.playheadX, Math.min(...ys)); this.ctx.lineTo(this.playheadX, Math.max(...ys)); this.ctx.stroke();
        }
        sounding.forEach(n => {
            const y = this._ny(n.midi, l);
            this.ctx.fillStyle = this.palettes[this.currentPalette][n.trackIndex % 5];
            this.ctx.beginPath(); this.ctx.arc(this.playheadX, y, 12, 0, Math.PI*2); this.ctx.fill();
        });
    }

    drawPlaceholder(t) { this.ctx.fillStyle = "#07080A"; this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height); this.ctx.fillStyle="#FFF"; this.ctx.textAlign="center"; this.ctx.fillText(t, this.canvas.clientWidth/2, this.canvas.clientHeight/2); }
    start(getTime) { this.isAnimating = true; const anim = () => { if(!this.isAnimating) return; this.drawFrame(getTime()); if(this.onProgress) this.onProgress(getTime()/this.totalDuration); requestAnimationFrame(anim); }; anim(); }
    stop() { this.isAnimating = false; }
}

document.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("visualizer"), renderer = new CanvasRenderer(canvas), audio = new AudioEngine();
    const viewSel = document.getElementById("view-selector"), trackSel = document.getElementById("track-selector");
    const playBtn = document.getElementById("btn-play"), pauseBtn = document.getElementById("btn-pause"), stopBtn = document.getElementById("btn-stop");
    const seek = document.getElementById("seek-slider"), prog = document.getElementById("progress-fill");
    const library = new BachLibrary();

    const picker = document.getElementById("palette-picker-container");
    renderer.palettes.forEach((p, i) => {
        const d = document.createElement("div"); d.className = "palette-btn";
        p.forEach(c => { const s = document.createElement("div"); s.className="palette-color-strip"; s.style.backgroundColor=c; d.appendChild(s); });
        d.onclick = () => { document.querySelectorAll(".palette-btn").forEach(b=>b.classList.remove("active")); d.classList.add("active"); renderer.currentPalette = i; };
        picker.appendChild(d);
    });

    viewSel.onchange = (e) => renderer.analyticalView = e.target.value;

    try {
        await library.loadFromUrl("./bach.zip");
        trackSel.innerHTML = "";
        for (const [f, files] of Object.entries(library.tree)) {
            const g = document.createElement("optgroup"); g.label = f;
            files.forEach(file => { const o = document.createElement("option"); o.value = file; o.textContent = file.split('/').pop(); g.appendChild(o); });
            trackSel.appendChild(g);
        }
        trackSel.disabled = false; playBtn.disabled = false;
        renderer.drawPlaceholder("Ready");
    } catch(e) { renderer.drawPlaceholder("Library Error"); }

    trackSel.onchange = () => {
        audio.stop(); renderer.reset();
        seek.value = 0; prog.style.width = "0%";
        playBtn.disabled = false; pauseBtn.disabled = true;
    };

    playBtn.onclick = async () => {
        if (renderer.totalDuration === 0) {
            const total = await audio.loadMidi(library.getWork(trackSel.value));
            renderer.setMidiData(audio.currentNotes, total);
        }
        await audio.play(); renderer.start(() => audio.getCurrentTime());
        playBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false; seek.disabled = false;
    };

    pauseBtn.onclick = () => { audio.pause(); renderer.stop(); playBtn.disabled = false; pauseBtn.disabled = true; };
    stopBtn.onclick = () => { audio.stop(); renderer.stop(); prog.style.width = "0%"; renderer.drawFrame(0); playBtn.disabled = false; pauseBtn.disabled = true; };
    
    renderer.onProgress = (p) => { if(!isDragging) { prog.style.width = (p*100)+"%"; seek.value = p*1000; } };
    
    let isDragging = false;
    seek.onpointerdown = () => { isDragging = true; renderer.stop(); };
    seek.oninput = (e) => { const t = (e.target.value/1000)*renderer.totalDuration; renderer.drawFrame(t); prog.style.width = (e.target.value/10)+"%"; };
    seek.onpointerup = async (e) => { isDragging = false; audio.pauseOffset = (e.target.value/1000)*renderer.totalDuration; await audio.play(); renderer.start(() => audio.getCurrentTime()); };
});
