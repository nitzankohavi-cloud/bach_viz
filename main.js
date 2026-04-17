// ═══════════════════════════════════════════════════════════════════════════════
// Bach Visualisation · Master Edition (V.Final - Fixed Track Switching)
// ═══════════════════════════════════════════════════════════════════════════════

class BachLibrary {
    constructor() {
        this.works = new Map();
        this.tree = {};
    }

    async loadFromUrl(zipUrl) {
        const response = await fetch(zipUrl);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const blob = await response.blob();
        await this._parseZipData(blob);
    }

    async loadFromFile(fileObject) {
        await this._parseZipData(fileObject);
    }

    async _parseZipData(data) {
        this.works.clear();
        this.tree = {};
        const JSZip = window.JSZip; 
        const zip = await JSZip.loadAsync(data);
        const filePromises = [];
        
        zip.forEach((relativePath, zipEntry) => {
            if (zipEntry.dir || !relativePath.match(/\.(mid|midi)$/i)) return;
            const cleanPath = relativePath.replace(/^bach\//, '');
            const parts = cleanPath.split('/');
            const folderName = parts.length > 1 ? parts[0] : 'Uncategorized';
            if (!this.tree[folderName]) this.tree[folderName] = [];
            this.tree[folderName].push(cleanPath);
            filePromises.push(zipEntry.async("arraybuffer").then(buffer => { this.works.set(cleanPath, buffer); }));
        });
        await Promise.all(filePromises);
    }

    getWork(path) { return this.works.get(path); }
}

class AudioEngine {
    constructor() {
        this.piano = new Tone.Sampler({
            urls: {
                A0: "A0.mp3", C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3",
                A1: "A1.mp3", C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
                A2: "A2.mp3", C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
                A3: "A3.mp3", C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
                A4: "A4.mp3", C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
                A5: "A5.mp3", C6: "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
                A6: "A6.mp3", C7: "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
                A7: "A7.mp3", C8: "C8.mp3"
            },
            baseUrl: "https://tonejs.github.io/audio/salamander/",
            release: 1.5,
        }).toDestination();
        this.pauseOffset = 0; 
        this.isPlaying = false;
        this.currentNotes = [];
    }

    async loadMidi(arrayBuffer) {
        const midi = new Midi(arrayBuffer);
        const notes = [];
        let totalDuration = 0;
        midi.tracks.forEach((track, index) => {
            track.notes.forEach(note => {
                notes.push({ time: note.time, duration: note.duration, midi: note.midi, velocity: note.velocity, trackIndex: index });
                if (note.time + note.duration > totalDuration) totalDuration = note.time + note.duration;
            });
        });
        this.currentNotes = notes;
        return { notes, totalDuration };
    }

    async play(startTime = this.pauseOffset) {
        if (Tone.context.state !== 'running') await Tone.start();
        await Tone.loaded(); 
        this.isPlaying = true;
        this.pauseOffset = startTime;
        Tone.Transport.stop();
        Tone.Transport.cancel(0);
        Tone.Transport.seconds = startTime;
        this.currentNotes.forEach(note => {
            if (note.time < startTime) return; 
            Tone.Transport.schedule((time) => {
                this.piano.triggerAttackRelease(Tone.Frequency(note.midi, "midi").toNote(), note.duration, time, note.velocity);
            }, note.time);
        });
        Tone.Transport.start();
    }

    pause() { this.isPlaying = false; Tone.Transport.pause(); this.pauseOffset = Tone.Transport.seconds; this.piano.releaseAll(); }
    stop() { this.isPlaying = false; Tone.Transport.stop(); Tone.Transport.cancel(0); this.pauseOffset = 0; this.piano.releaseAll(); }
    getCurrentTime() { return this.isPlaying ? Tone.Transport.seconds : this.pauseOffset; }
}

class CanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
        this.FRAME_PREDICTION = 0.016; 
        this.noteEvents = [];
        this.totalDuration = 0;
        this.isAnimating = false;
        this._voiceNotes = [[], [], [], [], []];
        this._lastSize = { w: 0, h: 0, dpr: 0 };
        this.pixelsPerSecond = 180;
        this.noteHeight = 12;
        this.minMidi = 36;
        this.maxMidi = 84;
        
        this.palettes = [
            ["#D4AF37", "#8C92AC", "#C0C0C0", "#A9A9A9", "#E5E4E2"],
            ["#E27D60", "#85DCBA", "#E8A87C", "#C38D9E", "#41B3A3"],
            ["#F0EDCC", "#02343F", "#A0C1B8", "#709FB0", "#726A95"],
            ["#ED553B", "#F6D55C", "#3CAEA3", "#20639B", "#173F5F"],
            ["#FFFFFF", "#CCCCCC", "#999999", "#666666", "#333333"]
        ];
        this.currentPaletteIndex = 0;
        this.voiceColors = this.palettes[this.currentPaletteIndex];
        this.bgColor = "#07080A"; 

        this.analyticalView = "architectural"; 
        this._layout = { width: 1, height: 1, topPad: 40, bottomPad: 48, usableHeight: 1, midiSpan: 1 };
        this.resizeForDpi();
    }

    setPalette(index) {
        if (this.palettes[index]) {
            this.currentPaletteIndex = index;
            this.voiceColors = this.palettes[index];
            if (!this.isAnimating) this.drawFrame(this._lastDrawnTime || 0);
        }
    }

    _ny(midi, l) { return l.topPad + (1 - (midi - this.minMidi) / l.midiSpan) * l.usableHeight; }
    _nx(time, now, l) { return this.playheadX + (time - now) * this.pixelsPerSecond; }

    setMidiData(noteEvents, totalDuration) {
        this.noteEvents = [...noteEvents].sort((a, b) => a.time - b.time);
        this.totalDuration = Number(totalDuration) || 0;
        let min = 127, max = 0;
        for (const n of this.noteEvents) {
            if (n.midi < min) min = n.midi;
            if (n.midi > max) max = n.midi;
        }
        this.minMidi = Math.max(0, min - 4);
        this.maxMidi = Math.min(127, max + 4);
        this._voiceNotes = [[], [], [], [], []];
        for (const n of this.noteEvents) {
            const v = Math.max(0, Math.min(4, n.trackIndex | 0));
            this._voiceNotes[v].push(n);
        }
    }

    setView(view) {
        const valid = ["architectural", "melodic-contour", "harmonic-lattice"];
        if (valid.includes(view)) {
            this.analyticalView = view;
            if (!this.isAnimating) this.drawFrame(this._lastDrawnTime || 0);
        }
    }

    start(getCurrentTime) {
        this.isAnimating = true;
        const animate = () => {
            if (!this.isAnimating) return;
            const rawTime = getCurrentTime();
            this.drawFrame(rawTime + this.FRAME_PREDICTION);
            if (this.onProgress) this.onProgress(Math.min(1, rawTime / this.totalDuration));
            this.rafId = window.requestAnimationFrame(animate);
        };
        this.rafId = window.requestAnimationFrame(animate);
    }

    stop() { this.isAnimating = false; window.cancelAnimationFrame(this.rafId); }

    resizeForDpi() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.floor(rect.width * dpr), h = Math.floor(rect.height * dpr);
        if (this._lastSize.w === w && this._lastSize.h === h) return;
        this.canvas.width = w; this.canvas.height = h;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._lastSize = { w, h, dpr };
    }

    drawFrame(now) {
        this._lastDrawnTime = now;
        this.resizeForDpi();
        const l = this._layout;
        l.width = this.canvas.clientWidth; l.height = this.canvas.clientHeight;
        l.usableHeight = Math.max(1, l.height - l.topPad - l.bottomPad);
        l.midiSpan = Math.max(1, this.maxMidi - this.minMidi);
        const isMobile = l.width < 768;
        this.playheadX = isMobile ? Math.min(80, l.width * 0.2) : 180;
        this.pixelsPerSecond = isMobile ? 120 : 180;
        l.startTime = now - this.playheadX / this.pixelsPerSecond;
        l.endTime = now + (l.width - this.playheadX) / this.pixelsPerSecond;

        this.ctx.fillStyle = this.bgColor;
        this.ctx.fillRect(0, 0, l.width, l.height);
        this._drawGrid(l);

        const visibleNotes = this.noteEvents.filter(n => (n.time + n.duration) > l.startTime - 1 && n.time < l.endTime + 1);

        if (this.analyticalView === "melodic-contour") this._drawContour(now, l, visibleNotes);
        else if (this.analyticalView === "architectural") this._drawArchitectural(now, l, visibleNotes);
        else this._drawLattice(now, l, visibleNotes);

        this._drawPlayhead(l);
        this._drawVignette(l);
    }

    _drawGrid(l) {
        const ctx = this.ctx; ctx.save();
        for (let m = this.minMidi; m <= this.maxMidi; m++) {
            if (m % 12 !== 0 && m % 12 !== 5) continue;
            const y = Math.floor(this._ny(m, l)) + 0.5;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(l.width, y);
            ctx.strokeStyle = m % 12 === 0 ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.04)";
            ctx.setLineDash([1, 8]); ctx.stroke();
        }
        ctx.restore();
    }

    _drawPlayhead(l) {
        const ctx = this.ctx; const x = Math.round(this.playheadX) + 0.5;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.3)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, l.topPad); ctx.lineTo(x, l.height - l.bottomPad); ctx.stroke();
    }

    _drawVignette(l) {
        const ctx = this.ctx; const fade = 100;
        const lg = ctx.createLinearGradient(0,0,fade,0); lg.addColorStop(0, this.bgColor); lg.addColorStop(1, "transparent");
        ctx.fillStyle = lg; ctx.fillRect(0,0,fade,l.height);
        const rg = ctx.createLinearGradient(l.width-fade,0,l.width,0); rg.addColorStop(0, "transparent"); rg.addColorStop(1, this.bgColor);
        ctx.fillStyle = rg; ctx.fillRect(l.width-fade,0,fade,l.height);
    }

    _drawContour(now, l, visibleNotes) {
        const ctx = this.ctx; ctx.save();
        for (let v = 0; v < 5; v++) {
            const vn = this._voiceNotes[v]; if (!vn || vn.length < 2) continue;
            ctx.beginPath(); let first = true;
            vn.forEach(n => {
                if (n.time < l.startTime - 1 || n.time > l.endTime + 1) return;
                const x = this._nx(n.time, now, l), y = this._ny(n.midi, l);
                if (first) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                first = false;
            });
            ctx.strokeStyle = this.voiceColors[v]; ctx.lineWidth = 2; ctx.globalAlpha = 0.4; ctx.stroke();
        }
        visibleNotes.forEach(n => {
            const x = this._nx(n.time, now, l), y = this._ny(n.midi, l), color = this.voiceColors[n.trackIndex % 5];
            const active = now >= n.time && now <= n.time + n.duration;
            ctx.globalAlpha = active ? 1 : Math.max(0.1, 1 - Math.abs(now - n.time) * 0.4);
            ctx.fillStyle = active ? "#FFF" : color;
            ctx.beginPath(); ctx.arc(x, y, active ? 5 : 3, 0, Math.PI*2); ctx.fill();
        });
        ctx.restore();
    }

    _drawArchitectural(now, l, visibleNotes) {
        const ctx = this.ctx;
        visibleNotes.forEach(n => {
            const x = this._nx(n.time, now, l), y = this._ny(n.midi, l) - this.noteHeight/2;
            const w = Math.max(4, n.duration * this.pixelsPerSecond), color = this.voiceColors[n.trackIndex % 5];
            const active = now >= n.time && now <= n.time + n.duration;
            ctx.globalAlpha = active ? 1 : (now > n.time ? 0.2 : 0.6);
            ctx.fillStyle = color; ctx.fillRect(x, y, w, this.noteHeight);
            if (active) { ctx.strokeStyle = "#FFF"; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, this.noteHeight); }
        });
    }

    _drawLattice(now, l, visibleNotes) {
        const ctx = this.ctx; const cx = this.playheadX;
        const sounding = visibleNotes.filter(n => now >= n.time && now <= n.time + n.duration);
        if (sounding.length >= 2) {
            const ys = sounding.map(n => this._ny(n.midi, l));
            ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(cx, Math.min(...ys)); ctx.lineTo(cx, Math.max(...ys)); ctx.stroke();
        }
        sounding.forEach(n => {
            const y = this._ny(n.midi, l), color = this.voiceColors[n.trackIndex % 5];
            ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, y, 12, 0, Math.PI*2); ctx.stroke();
            ctx.fillStyle = "#FFF"; ctx.beginPath(); ctx.arc(cx, y, 6, 0, Math.PI*2); ctx.fill();
        });
    }

    drawPlaceholder(text) {
        this.ctx.fillStyle = this.bgColor; this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.fillStyle = "#FFF"; this.ctx.textAlign = "center"; this.ctx.fillText(text.toUpperCase(), this.canvas.width/2/window.devicePixelRatio, this.canvas.height/2/window.devicePixelRatio);
    }
}

function buildPalettePicker(renderer) {
    const container = document.getElementById("palette-picker-container");
    if (!container) return;
    renderer.palettes.forEach((palette, index) => {
        const btn = document.createElement("div"); btn.className = "palette-btn";
        palette.forEach(c => { const s = document.createElement("div"); s.className="palette-color-strip"; s.style.backgroundColor=c; btn.appendChild(s); });
        btn.onclick = () => { document.querySelectorAll(".palette-btn").forEach(b=>b.classList.remove("active")); btn.classList.add("active"); renderer.setPalette(index); };
        container.appendChild(btn);
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("visualizer"), renderer = new CanvasRenderer(canvas), audio = new AudioEngine();
    buildPalettePicker(renderer);
    const viewSel = document.getElementById("view-selector"), trackSel = document.getElementById("track-selector");
    const playBtn = document.getElementById("btn-play"), pauseBtn = document.getElementById("btn-pause"), stopBtn = document.getElementById("btn-stop");
    const seek = document.getElementById("seek-slider"), prog = document.getElementById("progress-fill");
    const library = new BachLibrary();

    viewSel.onchange = (e) => renderer.setView(e.target.value);
    
    try {
        await library.loadFromUrl("./bach.zip");
        trackSel.innerHTML = "";
        for (const [folder, files] of Object.entries(library.tree)) {
            const g = document.createElement("optgroup"); g.label = folder;
            files.forEach(f => { const o = document.createElement("option"); o.value=f; o.textContent=f.split('/').pop(); g.appendChild(o); });
            trackSel.appendChild(g);
        }
        trackSel.disabled = false; playBtn.disabled = false;
        renderer.drawPlaceholder("Ready");
    } catch(e) { renderer.drawPlaceholder("Error loading library"); }

    playBtn.onclick = async () => {
        // תוקן: אם totalDuration הוא 0, זה סימן שצריך לטעון שיר חדש
        if (renderer.totalDuration === 0) {
            const buf = library.getWork(trackSel.value);
            const { notes, totalDuration } = await audio.loadMidi(buf);
            renderer.setMidiData(notes, totalDuration);
        }
        await audio.play(); renderer.start(() => audio.getCurrentTime());
        playBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false; seek.disabled = false;
    };

    pauseBtn.onclick = () => { audio.pause(); renderer.stop(); playBtn.disabled = false; pauseBtn.disabled = true; };
    stopBtn.onclick = () => { audio.stop(); renderer.stop(); prog.style.width = "0%"; renderer.drawFrame(0); playBtn.disabled = false; pauseBtn.disabled = true; };
    
    // תוקן: איפוס הנתונים במעבר בין שירים
    trackSel.onchange = () => {
        audio.stop();
        renderer.stop();
        renderer.totalDuration = 0; // הכרחי כדי שה-Play הבא יטעין את השיר החדש
        prog.style.width = "0%";
        seek.value = 0;
        renderer.drawFrame(0);
        playBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
    };

    renderer.onProgress = (p) => { prog.style.width = (p*100)+"%"; seek.value = p*1000; };
    
    seek.onpointerdown = () => { audio.pause(); renderer.stop(); };
    seek.oninput = (e) => { const t = (e.target.value/1000)*renderer.totalDuration; renderer.drawFrame(t); prog.style.width = (e.target.value/10)+"%"; };
    seek.onpointerup = async (e) => { audio.pauseOffset = (e.target.value/1000)*renderer.totalDuration; await audio.play(); renderer.start(() => audio.getCurrentTime()); };
});
