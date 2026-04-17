// ═══════════════════════════════════════════════════════════════════════════════
// Bach Visualisation · Master Edition (V.Final - Core Sync Fix)
// ═══════════════════════════════════════════════════════════════════════════════

class BachLibrary {
    constructor() { this.works = new Map(); this.tree = {}; }
    async load(url) {
        const resp = await fetch(url);
        const zip = await window.JSZip.loadAsync(await resp.blob());
        const ps = [];
        zip.forEach((rel, entry) => {
            if (entry.dir || !rel.match(/\.(mid|midi)$/i)) return;
            const clean = rel.replace(/^bach\//, '');
            const folder = clean.split('/')[0] || 'Uncategorized';
            if (!this.tree[folder]) this.tree[folder] = [];
            this.tree[folder].push(clean);
            ps.push(entry.async("arraybuffer").then(b => this.works.set(clean, b)));
        });
        await Promise.all(ps);
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
        this.pauseOffset = 0; this.isPlaying = false; this.notes = [];
    }
    async loadMidi(buf) {
        const midi = new Midi(buf);
        const notes = []; let duration = 0;
        midi.tracks.forEach((t, i) => {
            t.notes.forEach(n => {
                notes.push({ time: n.time, duration: n.duration, midi: n.midi, velocity: n.velocity, track: i });
                duration = Math.max(duration, n.time + n.duration);
            });
        });
        this.notes = notes;
        return duration;
    }
    async play(start = this.pauseOffset) {
        if (Tone.context.state !== 'running') await Tone.start();
        await Tone.loaded();
        this.isPlaying = true; this.pauseOffset = start;
        Tone.Transport.stop(); Tone.Transport.cancel(0); Tone.Transport.seconds = start;
        this.notes.forEach(n => {
            if (n.time < start) return;
            Tone.Transport.schedule(t => this.piano.triggerAttackRelease(Tone.Frequency(n.midi, "midi").toNote(), n.duration, t, n.velocity), n.time);
        });
        Tone.Transport.start();
    }
    stop() { this.isPlaying = false; Tone.Transport.stop(); Tone.Transport.cancel(0); this.pauseOffset = 0; this.piano.releaseAll(); }
}

class CanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas; this.ctx = canvas.getContext("2d", { alpha: false });
        this.notes = []; this.totalTime = 0; this.isAnimating = false;
        this.palettes = [ ["#D4AF37", "#8C92AC", "#C0C0C0", "#A9A9A9", "#E5E4E2"], ["#E27D60", "#85DCBA", "#E8A87C", "#C38D9E", "#41B3A3"], ["#FFFFFF", "#CCCCCC", "#999999", "#666666", "#333333"] ];
        this.currentPalette = 0; this.view = "architectural";
    }
    reset() {
        this.isAnimating = false; this.notes = []; this.totalTime = 0;
        this.ctx.fillStyle = "#07080A"; this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
    }
    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = this.canvas.clientWidth * dpr; this.canvas.height = this.canvas.clientHeight * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    draw(now) {
        this.resize(); const ctx = this.ctx; const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        const l = { w, h, top: 40, uh: h - 88, span: (this.maxMidi - this.minMidi) || 1 };
        const px = w < 768 ? 60 : 180;
        ctx.fillStyle = "#07080A"; ctx.fillRect(0,0,w,h);
        const visible = this.notes.filter(n => (n.time + n.duration) > (now - 2) && n.time < (now + w/180));
        visible.forEach(n => {
            const x = px + (n.time - now) * 180, y = l.top + (1 - (n.midi - this.minMidi) / l.span) * l.uh;
            const active = now >= n.time && now <= n.time + n.duration;
            ctx.globalAlpha = active ? 1 : (now > n.time ? 0.2 : 0.6);
            ctx.fillStyle = this.palettes[this.currentPalette][n.track % 5];
            if (this.view === "architectural") ctx.fillRect(x, y - 6, n.duration * 180, 12);
            else if (this.view === "melodic-contour") { ctx.beginPath(); ctx.arc(x, y, active ? 5 : 3, 0, Math.PI*2); ctx.fill(); }
            else if (active) { ctx.beginPath(); ctx.arc(px, y, 12, 0, Math.PI*2); ctx.fill(); }
        });
        ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.beginPath(); ctx.moveTo(px, l.top); ctx.lineTo(px, h - 48); ctx.stroke();
    }
    start(getTime) { this.isAnimating = true; const anim = () => { if(!this.isAnimating) return; this.draw(getTime()); if(this.onProgress) this.onProgress(getTime()/this.totalTime); requestAnimationFrame(anim); }; anim(); }
}

document.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("visualizer"), renderer = new CanvasRenderer(canvas), audio = new AudioEngine();
    const vSel = document.getElementById("view-selector"), tSel = document.getElementById("track-selector");
    const playBtn = document.getElementById("btn-play"), pauseBtn = document.getElementById("btn-pause"), stopBtn = document.getElementById("btn-stop");
    const seek = document.getElementById("seek-slider"), prog = document.getElementById("progress-fill");
    const library = new BachLibrary();

    const pContainer = document.getElementById("palette-picker-container");
    renderer.palettes.forEach((p, i) => {
        const d = document.createElement("div"); d.className = "palette-btn";
        p.forEach(c => { const s = document.createElement("div"); s.className="palette-color-strip"; s.style.backgroundColor=c; d.appendChild(s); });
        d.onclick = () => { document.querySelectorAll(".palette-btn").forEach(b=>b.classList.remove("active")); d.classList.add("active"); renderer.currentPalette = i; };
        pContainer.appendChild(d);
    });

    vSel.onchange = (e) => renderer.view = e.target.value;

    try {
        await library.load("./bach.zip");
        tSel.innerHTML = "";
        for (const [f, files] of Object.entries(library.tree)) {
            const g = document.createElement("optgroup"); g.label = f;
            files.forEach(file => { const o = document.createElement("option"); o.value = file; o.textContent = file.split('/').pop(); g.appendChild(o); });
            tSel.appendChild(g);
        }
        tSel.disabled = false; playBtn.disabled = false;
        renderer.drawPlaceholder("Ready");
    } catch(e) { console.error(e); }

    // שינוי בחירה מאפס את המוכנות לנגינה
    tSel.onchange = () => {
        audio.stop(); renderer.reset();
        playBtn.disabled = false; pauseBtn.disabled = true;
        seek.value = 0; prog.style.width = "0%";
    };

    playBtn.onclick = async () => {
        // טעינה רק אם אין תווים בזיכרון (כלומר אחרי החלפת שיר או סטופ)
        if (renderer.notes.length === 0) {
            const duration = await audio.loadMidi(library.getWork(tSel.value));
            renderer.notes = audio.notes; renderer.totalTime = duration;
            let min = 127, max = 0; renderer.notes.forEach(n => { min = Math.min(min, n.midi); max = Math.max(max, n.midi); });
            renderer.minMidi = min - 4; renderer.maxMidi = max + 4;
        }
        await audio.play(); renderer.start(() => audio.isPlaying ? Tone.Transport.seconds : audio.pauseOffset);
        playBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false; seek.disabled = false;
    };

    pauseBtn.onclick = () => { audio.pause(); renderer.isAnimating = false; playBtn.disabled = false; pauseBtn.disabled = true; };
    stopBtn.onclick = () => { audio.stop(); renderer.reset(); prog.style.width = "0%"; playBtn.disabled = false; pauseBtn.disabled = true; };
    
    renderer.onProgress = (p) => { if(!isDragging) { prog.style.width = (p*100)+"%"; seek.value = p*1000; } };
    let isDragging = false;
    seek.onpointerdown = () => { isDragging = true; renderer.isAnimating = false; };
    seek.oninput = (e) => { const t = (e.target.value/1000)*renderer.totalTime; renderer.draw(t); prog.style.width = (e.target.value/10)+"%"; };
    seek.onpointerup = async (e) => { isDragging = false; audio.pauseOffset = (e.target.value/1000)*renderer.totalTime; await audio.play(); renderer.start(() => audio.isPlaying ? Tone.Transport.seconds : audio.pauseOffset); };
});
