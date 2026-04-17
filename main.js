// ═══════════════════════════════════════════════════════════════════════════════
// Bach Music Visualization · Absolute Stability Version
// ═══════════════════════════════════════════════════════════════════════════════

class BachLibrary {
    constructor() { this.works = new Map(); this.tree = {}; }
    async load(url) {
        const resp = await fetch(url);
        const zip = await window.JSZip.loadAsync(await resp.blob());
        const filesToProcess = [];
        zip.forEach((rel, entry) => {
            if (entry.dir || !rel.match(/\.(mid|midi)$/i)) return;
            const clean = rel.replace(/^bach\//, '');
            const folder = clean.split('/')[0] || 'Uncategorized';
            if (!this.tree[folder]) this.tree[folder] = [];
            this.tree[folder].push(clean);
            filesToProcess.push({ name: clean, entry: entry });
        });
        // טעינה מלאה של כל הקבצים לתוך ה-Map (מבטיח שאין Promises ריקים)
        for (let f of filesToProcess) {
            const buf = await f.entry.async("arraybuffer");
            this.works.set(f.name, buf);
        }
    }
}

class AudioEngine {
    constructor() {
        this.sampler = new Tone.Sampler({
            urls: { A0: "A0.mp3", C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3", A1: "A1.mp3", C2: "C2.mp3", A3: "A3.mp3", C4: "C4.mp3", A5: "A5.mp3", C6: "C6.mp3" },
            baseUrl: "https://tonejs.github.io/audio/salamander/",
            release: 1
        }).toDestination();
        this.notes = []; this.isPlaying = false; this.pauseOffset = 0;
    }
    async loadTrack(buf) {
        const midi = new Midi(buf);
        const notes = []; let dur = 0;
        midi.tracks.forEach((t, i) => {
            t.notes.forEach(n => {
                notes.push({ time: n.time, duration: n.duration, midi: n.midi, velocity: n.velocity, track: i });
                dur = Math.max(dur, n.time + n.duration);
            });
        });
        this.notes = notes;
        return dur;
    }
    async play(startAt = this.pauseOffset) {
        if (Tone.context.state !== 'running') await Tone.start();
        Tone.Transport.stop(); Tone.Transport.cancel(0);
        Tone.Transport.seconds = startAt;
        this.notes.forEach(n => {
            if (n.time < startAt) return;
            Tone.Transport.schedule(t => {
                this.sampler.triggerAttackRelease(Tone.Frequency(n.midi, "midi").toNote(), n.duration, t, n.velocity);
            }, n.time);
        });
        Tone.Transport.start();
        this.isPlaying = true;
    }
    stop() { 
        this.isPlaying = false; Tone.Transport.stop(); Tone.Transport.cancel(0); 
        this.pauseOffset = 0; this.sampler.releaseAll(); 
    }
}

class Renderer {
    constructor(canvas) {
        this.canvas = canvas; this.ctx = canvas.getContext("2d", { alpha: false });
        this.notes = []; this.totalTime = 0; this.isAnimating = false;
        this.palettes = [["#D4AF37", "#8C92AC", "#C0C0C0", "#A9A9A9", "#E5E4E2"], ["#E27D60", "#85DCBA", "#E8A87C", "#C38D9E", "#41B3A3"], ["#FFFFFF", "#999999", "#666666", "#333333"]];
        this.activePalette = 0; this.view = "architectural";
    }
    setup(notes, dur) {
        this.notes = notes; this.totalTime = dur;
        let min = 127, max = 0; notes.forEach(n => { min = Math.min(min, n.midi); max = Math.max(max, n.midi); });
        this.minMidi = min - 4; this.maxMidi = max + 4;
    }
    draw(now) {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = this.canvas.clientWidth * dpr; this.canvas.height = this.canvas.clientHeight * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        const px = w < 768 ? 60 : 180;
        this.ctx.fillStyle = "#07080A"; this.ctx.fillRect(0,0,w,h);
        
        if (this.notes.length === 0) return;
        const span = this.maxMidi - this.minMidi || 1;
        const visible = this.notes.filter(n => (n.time + n.duration) > (now - 1) && n.time < (now + w/180));
        
        visible.forEach(n => {
            const nx = px + (n.time - now) * 180, ny = 40 + (1 - (n.midi - this.minMidi) / span) * (h - 88);
            const active = now >= n.time && now <= n.time + n.duration;
            this.ctx.globalAlpha = active ? 1 : (now > n.time ? 0.2 : 0.6);
            this.ctx.fillStyle = this.palettes[this.activePalette][n.track % 5];
            if (this.view === "architectural") this.ctx.fillRect(nx, ny - 6, n.duration * 180, 12);
            else if (this.view === "melodic-contour") { this.ctx.beginPath(); this.ctx.arc(nx, ny, active ? 6 : 3, 0, Math.PI*2); this.ctx.fill(); }
            else if (active) { this.ctx.beginPath(); this.ctx.arc(px, ny, 15, 0, Math.PI*2); this.ctx.fill(); }
        });
        this.ctx.strokeStyle = "rgba(255,255,255,0.2)"; this.ctx.beginPath(); this.ctx.moveTo(px, 40); this.ctx.lineTo(px, h - 48); this.ctx.stroke();
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    const ren = new Renderer(document.getElementById("visualizer"));
    const engine = new AudioEngine();
    const lib = new BachLibrary();
    
    const tSel = document.getElementById("track-selector"), vSel = document.getElementById("view-selector");
    const playBtn = document.getElementById("btn-play"), pauseBtn = document.getElementById("btn-pause"), stopBtn = document.getElementById("btn-stop");
    const seek = document.getElementById("seek-slider"), prog = document.getElementById("progress-fill");

    const picker = document.getElementById("palette-picker-container");
    ren.palettes.forEach((p, i) => {
        const d = document.createElement("div"); d.className = "palette-btn";
        p.forEach(c => { const s = document.createElement("div"); s.style.background = c; s.className = "palette-color-strip"; d.appendChild(s); });
        d.onclick = () => { document.querySelectorAll(".palette-btn").forEach(b => b.classList.remove("active")); d.classList.add("active"); ren.activePalette = i; };
        picker.appendChild(d);
    });

    try {
        await lib.load("./bach.zip");
        tSel.innerHTML = "";
        Object.entries(lib.tree).forEach(([f, files]) => {
            const g = document.createElement("optgroup"); g.label = f;
            files.forEach(file => { const o = document.createElement("option"); o.value = file; o.textContent = file.split('/').pop(); g.appendChild(o); });
            tSel.appendChild(g);
        });
        tSel.disabled = false; playBtn.disabled = false;
    } catch(e) { console.error(e); }

    vSel.onchange = (e) => ren.view = e.target.value;
    tSel.onchange = () => { engine.stop(); ren.notes = []; playBtn.disabled = false; pauseBtn.disabled = true; };

    playBtn.onclick = async () => {
        if (ren.notes.length === 0) {
            const buf = lib.works.get(tSel.value);
            const duration = await engine.loadTrack(buf);
            ren.setup(engine.notes, duration);
        }
        await engine.play();
        ren.isAnimating = true;
        const loop = () => {
            if (!ren.isAnimating) return;
            const t = Tone.Transport.seconds;
            ren.draw(t);
            prog.style.width = (t / ren.totalTime * 100) + "%";
            seek.value = (t / ren.totalTime * 1000);
            requestAnimationFrame(loop);
        };
        loop();
        playBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false; seek.disabled = false;
    };

    pauseBtn.onclick = () => { 
        engine.isPlaying = false; engine.pauseOffset = Tone.Transport.seconds;
        Tone.Transport.pause(); ren.isAnimating = false; 
        playBtn.disabled = false; pauseBtn.disabled = true; 
    };
    
    stopBtn.onclick = () => { 
        engine.stop(); ren.isAnimating = false; ren.notes = []; 
        prog.style.width = "0%"; playBtn.disabled = false; pauseBtn.disabled = true; 
    };

    let isDragging = false;
    seek.onpointerdown = () => { isDragging = true; ren.isAnimating = false; };
    seek.oninput = (e) => { const t = (e.target.value / 1000) * ren.totalTime; ren.draw(t); prog.style.width = (e.target.value / 10) + "%"; };
    seek.onpointerup = async (e) => { isDragging = false; engine.pauseOffset = (e.target.value / 1000) * ren.totalTime; await engine.play(engine.pauseOffset); ren.isAnimating = true; };
});
