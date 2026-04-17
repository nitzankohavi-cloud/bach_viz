// ═══════════════════════════════════════════════════════════════════════════════
// Bach · A quiet window into counterpoint · v3
// ═══════════════════════════════════════════════════════════════════════════════

const PALETTE = {
    bg: "#0A0908",
    bgWarm: "#0F0D0A",
    voices: ["#E8D4A2", "#C9A961", "#8B6F47", "#6B5437", "#4A3B2A"],
    ink: "#E8D4A2",
    inkDim: "rgba(232, 212, 162, 0.4)",
    inkFaint: "rgba(232, 212, 162, 0.08)",
    gold: "#C9A961"
};

const MEASURES_VISIBLE = 8;
const SILENT_INTRO = 1.5; // seconds before first note on fresh play
const WHITE_KEY_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

const formatTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
};

const parseTitle = (filename) => {
    let name = filename.split('/').pop().replace(/\.(mid|midi)$/i, '');
    name = name.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
    const bwvMatch = name.match(/BWV\s*(\d+[a-z]?)/i);
    const bwv = bwvMatch ? `BWV ${bwvMatch[1]}` : '';
    const title = name.replace(/BWV\s*\d+[a-z]?/i, '').replace(/\s+/g, ' ').trim();
    // Detect key
    const keyMatch = title.match(/in\s+([A-G][#b♯♭]?)\s*(major|minor|m)?/i);
    let tonicMidi = null;
    if (keyMatch) {
        const pcMap = { C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11 };
        const root = keyMatch[1].replace('♯','#').replace('♭','b');
        if (pcMap[root] !== undefined) tonicMidi = pcMap[root];
    }
    const pretty = title.split(' ').map(w =>
        w.length <= 2 && w.toLowerCase() !== 'no'
            ? w.toLowerCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    ).join(' ');
    return { title: pretty || 'Untitled', meta: bwv, tonic: tonicMidi };
};

// ═══ Library ═══════════════════════════════════════════════════════════════════
class BachLibrary {
    constructor() { this.works = new Map(); this.tree = {}; }
    async load(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("Failed to fetch: " + resp.status);
        const zip = await window.JSZip.loadAsync(await resp.blob());
        const files = [];
        zip.forEach((rel, entry) => {
            if (entry.dir || !rel.match(/\.(mid|midi)$/i)) return;
            const clean = rel.replace(/^bach\//, '');
            const folder = clean.split('/')[0] || 'Miscellaneous';
            if (!this.tree[folder]) this.tree[folder] = [];
            this.tree[folder].push(clean);
            files.push({ name: clean, entry });
        });
        for (let f of files) this.works.set(f.name, await f.entry.async("arraybuffer"));
    }
}

// ═══ Audio Engine ══════════════════════════════════════════════════════════════
class AudioEngine {
    constructor() {
        this.sampler = new Tone.Sampler({
            urls: { A0:"A0.mp3", C1:"C1.mp3", "D#1":"Ds1.mp3", "F#1":"Fs1.mp3",
                    A1:"A1.mp3", C2:"C2.mp3", A3:"A3.mp3", C4:"C4.mp3",
                    A5:"A5.mp3", C6:"C6.mp3" },
            baseUrl: "https://tonejs.github.io/audio/salamander/",
            release: 1.2
        }).toDestination();
        this.sampler.volume.value = -3;
        this.notes = []; this.isPlaying = false; this.pauseOffset = 0;
        this.scheduledIds = []; this.tempo = 80;
    }
    loadTrack(buf) {
        const midi = new window.Midi(buf);
        this.tempo = (midi.header.tempos?.[0]?.bpm) || 80;
        const notes = []; let dur = 0;
        midi.tracks.forEach((t, i) => {
            t.notes.forEach(n => {
                notes.push({ time: n.time, duration: n.duration,
                             midi: n.midi, velocity: n.velocity, track: i });
                dur = Math.max(dur, n.time + n.duration);
            });
        });
        this.notes = notes;
        return dur;
    }
    clearScheduled() {
        this.scheduledIds.forEach(id => Tone.Transport.clear(id));
        this.scheduledIds = [];
        Tone.Transport.cancel(0);
    }
    async play(startAt = this.pauseOffset, useIntro = false) {
        if (Tone.context.state !== 'running') await Tone.start();
        Tone.Transport.stop();
        this.clearScheduled();
        this.sampler.releaseAll();
        // Silent intro: set Transport back so notes play at their original time
        Tone.Transport.seconds = useIntro ? (startAt - SILENT_INTRO) : startAt;
        this.notes.forEach(n => {
            if (n.time < startAt - 0.01) return;
            const id = Tone.Transport.schedule(t => {
                this.sampler.triggerAttackRelease(
                    Tone.Frequency(n.midi, "midi").toNote(),
                    Math.max(n.duration, 0.05), t, n.velocity
                );
            }, n.time);
            this.scheduledIds.push(id);
        });
        Tone.Transport.start();
        this.isPlaying = true;
    }
    pause() {
        this.isPlaying = false;
        this.pauseOffset = Math.max(0, Tone.Transport.seconds);
        Tone.Transport.pause();
        this.sampler.releaseAll();
    }
    stop() {
        this.isPlaying = false;
        Tone.Transport.stop();
        this.clearScheduled();
        this.pauseOffset = 0;
        this.sampler.releaseAll();
    }
}

// ═══ Renderer ══════════════════════════════════════════════════════════════════
class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { alpha: false });
        this.notes = []; this.totalTime = 0; this.isAnimating = false;
        this.view = "architectural";
        this.minMidi = 36; this.maxMidi = 84;
        this.tempo = 80; this.measureDur = 2;
        this.startTime = 0;
        this.smoothNow = 0;
        this.hoveredVoice = null;
        this.tonicPc = null;
    }
    setup(notes, dur, tempo, tonicPc) {
        this.notes = notes; this.totalTime = dur;
        this.tempo = tempo || 80;
        this.measureDur = (60 / this.tempo) * 4;
        this.tonicPc = tonicPc;
        this.smoothNow = 0;
        if (notes.length === 0) return;
        let min = 127, max = 0;
        notes.forEach(n => { min = Math.min(min, n.midi); max = Math.max(max, n.midi); });
        this.minMidi = min - 2; this.maxMidi = max + 2;
        this.voiceGroups = {};
        notes.forEach(n => {
            if (!this.voiceGroups[n.track]) this.voiceGroups[n.track] = [];
            this.voiceGroups[n.track].push(n);
        });
        Object.values(this.voiceGroups).forEach(g => g.sort((a,b) => a.time - b.time));
    }
    resize() {
        const dpr = window.devicePixelRatio || 1;
        const cw = this.canvas.clientWidth || 1, ch = this.canvas.clientHeight || 1;
        if (this.canvas.width !== cw * dpr) this.canvas.width = cw * dpr;
        if (this.canvas.height !== ch * dpr) this.canvas.height = ch * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w: cw, h: ch };
    }
    clear() {
        const { w, h } = this.resize();
        this.ctx.fillStyle = PALETTE.bg;
        this.ctx.fillRect(0, 0, w, h);
    }

    // Piano-correct Y position
    whiteIndexOf(midi) {
        const oct = Math.floor(midi / 12);
        const s = midi % 12;
        let idx = 0;
        WHITE_KEY_SEMITONES.forEach(w => { if (w < s) idx++; });
        return oct * 7 + idx;
    }
    midiToY(midi, top, height) {
        const minW = this.whiteIndexOf(this.minMidi);
        const maxW = this.whiteIndexOf(this.maxMidi);
        const span = maxW - minW || 1;
        const isWhite = WHITE_KEY_SEMITONES.includes(midi % 12);
        const myW = this.whiteIndexOf(midi) + (isWhite ? 0 : 0.5);
        return top + (1 - (myW - minW) / span) * height;
    }

    drawPitchAxis(w, h, top, height) {
        this.ctx.save();
        this.ctx.font = "italic 9px 'EB Garamond', serif";
        this.ctx.fillStyle = PALETTE.inkFaint;
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";
        for (let midi = 12; midi <= 108; midi += 12) {
            if (midi < this.minMidi || midi > this.maxMidi) continue;
            const y = this.midiToY(midi, top, height);
            const octave = Math.floor(midi / 12) - 1;
            this.ctx.fillStyle = "rgba(232, 212, 162, 0.22)";
            this.ctx.fillText(`C${octave}`, 14, y);
            this.ctx.strokeStyle = "rgba(232, 212, 162, 0.05)";
            this.ctx.lineWidth = 0.5;
            this.ctx.beginPath();
            this.ctx.moveTo(38, y);
            this.ctx.lineTo(w - 20, y);
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    drawTimeGrid(now, w, h, playheadX, top, height, pxPerSec) {
        const beatDur = 60 / this.tempo;
        const measureDur = this.measureDur;
        const visibleSec = (w - playheadX) / pxPerSec + 1;
        const startT = Math.floor((now - 1.5) / beatDur) * beatDur;
        const endT = now + visibleSec;

        this.ctx.save();
        this.ctx.lineWidth = 0.5;
        for (let t = startT; t <= endT; t += beatDur) {
            const x = playheadX + (t - now) * pxPerSec;
            if (x < 40 || x > w - 20) continue;
            const measurePhase = ((t / measureDur) + 1e-6) % 1;
            const isMeasure = measurePhase < 0.01 || measurePhase > 0.99;
            const isStrongBeat = Math.abs((t / beatDur) % 2) < 0.01; // beats 1, 3
            const edgeFade = Math.min(1,
                Math.min(x - 40, w - 20 - x) / 50
            );
            let baseAlpha;
            if (isMeasure)       baseAlpha = 0.10;
            else if (isStrongBeat) baseAlpha = 0.045;
            else                  baseAlpha = 0.025;
            this.ctx.strokeStyle = `rgba(232, 212, 162, ${baseAlpha * Math.max(0, edgeFade)})`;
            this.ctx.beginPath();
            this.ctx.moveTo(x, top);
            this.ctx.lineTo(x, top + height);
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    drawPlayhead(x, top, height) {
        this.ctx.save();
        const grad = this.ctx.createLinearGradient(0, top, 0, top + height);
        grad.addColorStop(0, "rgba(201, 169, 97, 0)");
        grad.addColorStop(0.5, "rgba(201, 169, 97, 0.38)");
        grad.addColorStop(1, "rgba(201, 169, 97, 0)");
        this.ctx.strokeStyle = grad;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(x, top);
        this.ctx.lineTo(x, top + height);
        this.ctx.stroke();
        this.ctx.restore();
    }

    // Find note at pixel coords (for hover)
    noteAt(mx, my, now, w, h) {
        const top = 24, bottom = 24;
        const height = h - top - bottom;
        const playheadX = w < 768 ? 80 : Math.min(220, w * 0.18);
        const pxPerSec = (w - playheadX - 40) / (MEASURES_VISIBLE * this.measureDur);
        for (const n of this.notes) {
            const x = playheadX + (n.time - now) * pxPerSec;
            const noteW = Math.max(n.duration * pxPerSec, 2);
            if (mx < x || mx > x + noteW) continue;
            const y = this.midiToY(n.midi, top, height);
            const weight = Math.min(1, n.duration / this.measureDur);
            const noteH = 3 + weight * 8;
            if (Math.abs(my - y) <= noteH / 2 + 2) return n;
        }
        return null;
    }

    draw(audioTime) {
        const { w, h } = this.resize();
        this.ctx.fillStyle = PALETTE.bg;
        this.ctx.fillRect(0, 0, w, h);

        if (this.notes.length === 0) return;

        // Smooth interpolation for visual (not audio)
        if (this.isAnimating) {
            this.smoothNow += (audioTime - this.smoothNow) * 0.3;
        } else {
            this.smoothNow = audioTime;
        }
        const now = this.smoothNow;

        const top = 24, bottom = 24;
        const height = h - top - bottom;
        const playheadX = w < 768 ? 80 : Math.min(220, w * 0.18);
        const pxPerSec = (w - playheadX - 40) / (MEASURES_VISIBLE * this.measureDur);

        const sinceStart = audioTime - this.startTime;
        const globalFade = Math.min(1, Math.max(0, sinceStart / 1.5));
        const endFade = audioTime > this.totalTime - 2
            ? Math.max(0, 1 - (audioTime - (this.totalTime - 2)) / 2) : 1;

        this.ctx.globalAlpha = globalFade * endFade;

        this.drawPitchAxis(w, h, top, height);

        if (this.view !== "harmonic-lattice") {
            this.drawTimeGrid(now, w, h, playheadX, top, height, pxPerSec);
        }

        if (this.view === "architectural")    this.drawArchitectural(now, w, h, playheadX, top, height, pxPerSec);
        else if (this.view === "melodic-contour") this.drawMelodicContour(now, w, h, playheadX, top, height, pxPerSec);
        else if (this.view === "harmonic-lattice") this.drawHarmonicLattice(audioTime, w, h);

        if (this.view !== "harmonic-lattice") {
            this.drawPlayhead(playheadX, top, height);
        }

        this.ctx.globalAlpha = 1;

        // End title
        if (audioTime >= this.totalTime && this.totalTime > 0) {
            const fadeOut = Math.max(0, 1 - (audioTime - this.totalTime) / 3);
            if (fadeOut > 0) {
                this.ctx.save();
                this.ctx.globalAlpha = fadeOut * 0.5;
                this.ctx.fillStyle = PALETTE.ink;
                this.ctx.font = "italic 18px 'EB Garamond', serif";
                this.ctx.textAlign = "center";
                this.ctx.textBaseline = "middle";
                this.ctx.fillText("— fin —", w / 2, h / 2);
                this.ctx.restore();
            }
        }
    }

    drawArchitectural(now, w, h, playheadX, top, height, pxPerSec) {
        const lookBack = 3.5;
        const lookForward = (w - playheadX) / pxPerSec;
        const visible = this.notes.filter(n =>
            (n.time + n.duration) > (now - lookBack) && n.time < (now + lookForward)
        );

        visible.forEach(n => {
            const x = playheadX + (n.time - now) * pxPerSec;
            const noteW = Math.max(n.duration * pxPerSec, 2);
            const y = this.midiToY(n.midi, top, height);
            const active = now >= n.time && now <= n.time + n.duration;
            const past = now > n.time + n.duration;

            let alpha;
            if (active) alpha = 1;
            else if (past) alpha = Math.max(0, 0.32 * (1 - (now - (n.time + n.duration)) / lookBack));
            else alpha = 0.55;

            const vel = n.velocity || 0.7;
            alpha *= 0.55 + vel * 0.45;

            // Voice hover dim
            if (this.hoveredVoice !== null && this.hoveredVoice !== n.track) {
                alpha *= 0.25;
            } else if (this.hoveredVoice === n.track) {
                alpha = Math.min(1, alpha * 1.3);
            }

            const weight = Math.min(1, n.duration / this.measureDur);
            const noteH = 3 + weight * 8;
            const color = PALETTE.voices[n.track % PALETTE.voices.length];

            this.ctx.save();
            this.ctx.globalAlpha = alpha;
            this.ctx.fillStyle = color;
            this.roundRect(x, y - noteH / 2, noteW, noteH, Math.min(1.5, noteH / 2));
            this.ctx.fill();

            if (active) {
                this.ctx.strokeStyle = "rgba(255, 248, 220, 0.45)";
                this.ctx.lineWidth = 0.5;
                this.roundRect(x + 0.5, y - noteH/2 + 0.5, noteW - 1, noteH - 1, 1);
                this.ctx.stroke();
            }
            this.ctx.restore();
        });
    }

    drawMelodicContour(now, w, h, playheadX, top, height, pxPerSec) {
        const lookBack = 4;
        const lookForward = (w - playheadX) / pxPerSec;

        Object.entries(this.voiceGroups).forEach(([track, notes]) => {
            const color = PALETTE.voices[track % PALETTE.voices.length];
            const visible = notes.filter(n =>
                n.time > (now - lookBack) && n.time < (now + lookForward)
            );
            if (visible.length < 2) return;

            const hasActive = visible.some(n => now >= n.time && now <= n.time + n.duration);
            const trackNum = parseInt(track);
            let voiceAlpha = hasActive ? 0.7 : 0.32;
            let lineWidth = hasActive ? 1.3 : 0.75;
            if (this.hoveredVoice !== null) {
                if (this.hoveredVoice === trackNum) { voiceAlpha = 0.95; lineWidth = 1.6; }
                else { voiceAlpha *= 0.3; }
            }

            this.ctx.save();
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = lineWidth;
            this.ctx.globalAlpha = voiceAlpha;
            this.ctx.lineCap = "round";
            this.ctx.lineJoin = "round";
            this.ctx.beginPath();
            visible.forEach((n, i) => {
                const x = playheadX + (n.time - now) * pxPerSec;
                const y = this.midiToY(n.midi, top, height);
                if (i === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
            });
            this.ctx.stroke();

            visible.forEach(n => {
                const active = now >= n.time && now <= n.time + n.duration;
                if (!active) return;
                const x = playheadX + (n.time - now) * pxPerSec;
                const y = this.midiToY(n.midi, top, height);
                this.ctx.globalAlpha = 1;
                this.ctx.fillStyle = color;
                this.ctx.beginPath();
                this.ctx.arc(x, y, 3, 0, Math.PI * 2);
                this.ctx.fill();
            });
            this.ctx.restore();
        });
    }

    drawHarmonicLattice(now, w, h) {
        const cx = w / 2, cy = h / 2;
        const radius = Math.min(w, h) * 0.28;
        const fifthsOrder = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
        const pcLabels = ['C','G','D','A','E','B','F♯','C♯','G♯','D♯','A♯','F'];

        this.ctx.save();

        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
            const x = cx + Math.cos(angle) * radius;
            const y = cy + Math.sin(angle) * radius;
            const pc = fifthsOrder[i];
            const isTonic = this.tonicPc !== null && pc === this.tonicPc;

            this.ctx.fillStyle = isTonic
                ? "rgba(201, 169, 97, 0.5)"
                : "rgba(232, 212, 162, 0.12)";
            this.ctx.beginPath();
            this.ctx.arc(x, y, isTonic ? 2.5 : 1.5, 0, Math.PI * 2);
            this.ctx.fill();

            this.ctx.fillStyle = isTonic
                ? "rgba(201, 169, 97, 0.65)"
                : "rgba(232, 212, 162, 0.28)";
            this.ctx.font = isTonic ? "italic 500 11px 'EB Garamond', serif"
                                    : "italic 10px 'EB Garamond', serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            const lx = cx + Math.cos(angle) * (radius + 20);
            const ly = cy + Math.sin(angle) * (radius + 20);
            this.ctx.fillText(pcLabels[i], lx, ly);
        }

        const activeNotes = this.notes.filter(n => now >= n.time && now <= n.time + n.duration);
        if (activeNotes.length === 0) { this.ctx.restore(); return; }

        const points = activeNotes.map(n => {
            const pc = ((n.midi % 12) + 12) % 12;
            const idx = fifthsOrder.indexOf(pc);
            const angle = (idx / 12) * Math.PI * 2 - Math.PI / 2;
            return {
                x: cx + Math.cos(angle) * radius,
                y: cy + Math.sin(angle) * radius,
                n, pc
            };
        });

        const uniquePoints = [];
        const seen = new Set();
        points.forEach(p => {
            if (!seen.has(p.pc)) { seen.add(p.pc); uniquePoints.push(p); }
        });

        if (uniquePoints.length > 1) {
            this.ctx.strokeStyle = PALETTE.gold;
            this.ctx.globalAlpha = 0.28;
            this.ctx.lineWidth = 0.75;
            this.ctx.beginPath();
            uniquePoints.forEach((p, i) => {
                if (i === 0) this.ctx.moveTo(p.x, p.y); else this.ctx.lineTo(p.x, p.y);
            });
            if (uniquePoints.length > 2) this.ctx.closePath();
            this.ctx.stroke();
        }

        points.forEach(p => {
            this.ctx.globalAlpha = 0.9;
            this.ctx.fillStyle = PALETTE.voices[p.n.track % PALETTE.voices.length];
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
            this.ctx.fill();
        });

        this.ctx.restore();
    }

    roundRect(x, y, w, h, r) {
        const ctx = this.ctx;
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}

// ═══ App ═══════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("visualizer");
    const ren = new Renderer(canvas);
    const engine = new AudioEngine();
    const lib = new BachLibrary();

    const tSel = document.getElementById("track-selector");
    const vSel = document.getElementById("view-selector");
    const playBtn = document.getElementById("play-toggle");
    const seek = document.getElementById("seek-slider");
    const prog = document.getElementById("scrubber-progress");
    const timeDisp = document.getElementById("time-display");
    const titleEl = document.getElementById("work-title");
    const metaEl = document.getElementById("work-meta");

    let currentTonicPc = null;
    let hasPlayedOnce = false; // track whether silent intro was used

    ren.clear();
    window.addEventListener("resize", () => { if (!ren.isAnimating) ren.clear(); });

    try {
        await lib.load("./bach.zip");
        tSel.innerHTML = "";
        Object.entries(lib.tree).sort(([a],[b]) => a.localeCompare(b)).forEach(([f, files]) => {
            const g = document.createElement("optgroup"); g.label = f;
            files.sort().forEach(file => {
                const o = document.createElement("option");
                o.value = file;
                o.textContent = parseTitle(file).title;
                g.appendChild(o);
            });
            tSel.appendChild(g);
        });
        tSel.disabled = false;
        playBtn.disabled = false;
        updateTitle(true);
    } catch (e) {
        console.error(e);
        titleEl.textContent = "Could not load library";
        titleEl.classList.remove("breathing", "loading");
    }

    function updateTitle(immediate = false) {
        const apply = () => {
            const parsed = parseTitle(tSel.value || "");
            titleEl.classList.remove("loading", "breathing");
            titleEl.textContent = parsed.title;
            metaEl.textContent = parsed.meta;
            currentTonicPc = parsed.tonic;
        };
        if (immediate) return apply();
        titleEl.style.opacity = '0';
        setTimeout(() => { apply(); titleEl.style.opacity = ''; }, 280);
    }

    vSel.onchange = (e) => {
        ren.view = e.target.value;
        if (!ren.isAnimating && ren.notes.length > 0) {
            ren.draw(engine.pauseOffset || 0);
        }
    };

    tSel.onchange = () => {
        engine.stop();
        ren.notes = []; ren.totalTime = 0;
        ren.isAnimating = false;
        hasPlayedOnce = false;
        ren.clear();
        prog.style.width = "0%";
        seek.value = 0;
        seek.disabled = true;
        playBtn.textContent = "Play";
        playBtn.disabled = false;
        timeDisp.textContent = "0:00 / 0:00";
        updateTitle();
    };

    let rafId = null;
    let isDragging = false;
    const stopLoop = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } };
    const startLoop = () => {
        stopLoop();
        const loop = () => {
            if (!ren.isAnimating) { rafId = null; return; }
            const t = Math.max(0, Tone.Transport.seconds);
            ren.draw(t);
            if (ren.totalTime > 0) {
                const ratio = Math.min(Math.max(t, 0) / ren.totalTime, 1);
                prog.style.width = (ratio * 100) + "%";
                if (!isDragging) seek.value = ratio * 1000;
                timeDisp.textContent = `${formatTime(Math.max(0,t))} / ${formatTime(ren.totalTime)}`;
                if (t >= ren.totalTime + 3.2) {
                    engine.stop();
                    ren.isAnimating = false;
                    hasPlayedOnce = false;
                    playBtn.textContent = "Play";
                    seek.value = 0;
                    prog.style.width = "0%";
                    timeDisp.textContent = `0:00 / ${formatTime(ren.totalTime)}`;
                    return;
                }
            }
            rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
    };

    const doPlay = async () => {
        try {
            if (ren.notes.length === 0) {
                const buf = lib.works.get(tSel.value);
                if (!buf) return;
                const duration = engine.loadTrack(buf);
                ren.setup(engine.notes, duration, engine.tempo, currentTonicPc);
            }
            await Tone.loaded();
            const useIntro = !hasPlayedOnce && engine.pauseOffset === 0;
            ren.startTime = engine.pauseOffset - (useIntro ? SILENT_INTRO : 0);
            await engine.play(engine.pauseOffset, useIntro);
            hasPlayedOnce = true;
            ren.isAnimating = true;
            startLoop();
            playBtn.textContent = "Pause";
            seek.disabled = false;
        } catch (e) { console.error(e); }
    };
    const doPause = () => {
        engine.pause();
        ren.isAnimating = false;
        stopLoop();
        playBtn.textContent = "Resume";
    };
    playBtn.onclick = () => { if (engine.isPlaying) doPause(); else doPlay(); };

    let wasPlayingBeforeDrag = false;
    seek.addEventListener("pointerdown", () => {
        if (ren.totalTime <= 0) return;
        isDragging = true;
        wasPlayingBeforeDrag = engine.isPlaying;
        if (engine.isPlaying) {
            Tone.Transport.pause();
            engine.sampler.releaseAll();
        }
        ren.isAnimating = false;
        stopLoop();
    });
    seek.addEventListener("input", (e) => {
        if (ren.totalTime <= 0) return;
        const t = (e.target.value / 1000) * ren.totalTime;
        ren.startTime = t;
        ren.smoothNow = t;
        ren.draw(t);
        prog.style.width = (e.target.value / 10) + "%";
        timeDisp.textContent = `${formatTime(t)} / ${formatTime(ren.totalTime)}`;
    });
    seek.addEventListener("pointerup", async (e) => {
        if (!isDragging) return;
        isDragging = false;
        if (ren.totalTime <= 0) return;
        const newTime = (e.target.value / 1000) * ren.totalTime;
        engine.pauseOffset = newTime;
        if (wasPlayingBeforeDrag) {
            ren.startTime = newTime;
            ren.smoothNow = newTime;
            await engine.play(newTime, false);
            ren.isAnimating = true;
            startLoop();
        } else {
            ren.draw(newTime);
        }
    });

    // Hover on canvas: highlight voice
    canvas.addEventListener("mousemove", (e) => {
        if (ren.view === "harmonic-lattice") { ren.hoveredVoice = null; return; }
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const now = Math.max(0, Tone.Transport.seconds);
        const note = ren.noteAt(mx, my, now, canvas.clientWidth, canvas.clientHeight);
        ren.hoveredVoice = note ? note.track : null;
        if (!ren.isAnimating) ren.draw(engine.pauseOffset || 0);
    });
    canvas.addEventListener("mouseleave", () => {
        ren.hoveredVoice = null;
        if (!ren.isAnimating) ren.draw(engine.pauseOffset || 0);
    });

    document.addEventListener("keydown", (e) => {
        if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
        if (e.code === "Space") {
            e.preventDefault();
            if (!playBtn.disabled) playBtn.click();
        } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
            if (ren.totalTime <= 0) return;
            e.preventDefault();
            const delta = e.code === "ArrowLeft" ? -5 : 5;
            const current = Math.max(0, Tone.Transport.seconds);
            const newT = Math.max(0, Math.min(ren.totalTime, current + delta));
            engine.pauseOffset = newT;
            ren.startTime = newT;
            ren.smoothNow = newT;
            if (engine.isPlaying) engine.play(newT, false);
            else ren.draw(newT);
            const ratio = newT / ren.totalTime;
            seek.value = ratio * 1000;
            prog.style.width = (ratio * 100) + "%";
            timeDisp.textContent = `${formatTime(newT)} / ${formatTime(ren.totalTime)}`;
        }
    });

    ren.clear();
});
