// ═══════════════════════════════════════════════════════════════════════════════
// Bach · A quiet window into counterpoint
// ═══════════════════════════════════════════════════════════════════════════════

const PALETTES = {
    candlelight: {
        name: "Candlelight",
        voices: ["#E8D4A2", "#C9A961", "#A88754", "#7A5F38", "#4A3B2A"],
        ink: "#E8D4A2",
        gold: "#C9A961"
    },
    grisaille: {
        name: "Grisaille",
        voices: ["#ECECEC", "#B8B8B8", "#8A8A8A", "#5C5C5C", "#3A3A3A"],
        ink: "#E0E0E0",
        gold: "#C0C0C0"
    },
    manuscript: {
        name: "Manuscript",
        voices: ["#D4B896", "#A8865E", "#7A5A3A", "#543B24", "#32220F"],
        ink: "#D4B896",
        gold: "#B08B5E"
    },
    ensemble: {
        name: "Ensemble",
        // Five distinct colors chosen for maximal voice distinction:
        // warm ivory, slate blue, burnished copper, sage green, dusty rose.
        // All muted (desaturated) so they feel like a chamber group, not a carnival.
        voices: ["#E8D4A2", "#6B8CAE", "#C97B5F", "#8FA876", "#B08FA0"],
        ink: "#E8D4A2",
        gold: "#C9A961"
    },
    quartet: {
        name: "Quartet",
        // Four strong colors for those who want maximum contrast.
        // Inspired by the voicing of a string quartet: each instrument has its hue.
        voices: ["#D97757", "#4A8BA8", "#D4A84A", "#6B8E5E", "#8E6B9E"],
        ink: "#E8D4A2",
        gold: "#C9A961"
    }
};

const BG_COLOR = "#0A0908";
let activePalette = "candlelight";
const getPalette = () => PALETTES[activePalette];

const SILENT_INTRO = 1.5;
const WHITE_KEY_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const isMobile = () => window.innerWidth < 640;
const measuresVisible = () => isMobile() ? 4 : 8;

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
    const pretty = title.split(' ').map(w =>
        w.length <= 2 && w.toLowerCase() !== 'no'
            ? w.toLowerCase()
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    ).join(' ');
    return { title: pretty || 'Untitled', meta: bwv };
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
        for (const f of files) {
            this.works.set(f.name, await f.entry.async("arraybuffer"));
        }
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
        this.introTimeoutId = null;
    }
    loadTrack(buf) {
        const midi = new window.Midi(buf);
        this.tempo = (midi.header.tempos && midi.header.tempos[0] && midi.header.tempos[0].bpm) || 80;
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
    cancelIntro() {
        if (this.introTimeoutId) {
            clearTimeout(this.introTimeoutId);
            this.introTimeoutId = null;
        }
    }
    async play(startAt, useIntro, onIntroComplete) {
        if (Tone.context.state !== 'running') await Tone.start();
        Tone.Transport.stop();
        this.clearScheduled();
        this.cancelIntro();
        this.sampler.releaseAll();

        const actuallyStart = () => {
            Tone.Transport.seconds = startAt;
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
            if (onIntroComplete) onIntroComplete();
        };

        if (useIntro) {
            this.isPlaying = true;
            this.introTimeoutId = setTimeout(() => {
                this.introTimeoutId = null;
                actuallyStart();
            }, SILENT_INTRO * 1000);
        } else {
            actuallyStart();
        }
    }
    pause() {
        this.cancelIntro();
        this.isPlaying = false;
        this.pauseOffset = Math.max(0, Tone.Transport.seconds);
        Tone.Transport.pause();
        this.sampler.releaseAll();
    }
    stop() {
        this.cancelIntro();
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
        this.visualStartTime = 0;
        this.smoothNow = 0;
        this.hoveredVoice = null;
        this.voiceGroups = {};
    }
    setup(notes, dur, tempo) {
        this.notes = notes; this.totalTime = dur;
        this.tempo = tempo || 80;
        this.measureDur = (60 / this.tempo) * 4;
        this.smoothNow = 0;
        this.voiceGroups = {};
        if (notes.length === 0) return;
        let min = 127, max = 0;
        notes.forEach(n => { min = Math.min(min, n.midi); max = Math.max(max, n.midi); });
        this.minMidi = Math.max(0, min - 2);
        this.maxMidi = Math.min(127, max + 2);
        notes.forEach(n => {
            if (!this.voiceGroups[n.track]) this.voiceGroups[n.track] = [];
            this.voiceGroups[n.track].push(n);
        });
        Object.values(this.voiceGroups).forEach(g => g.sort((a,b) => a.time - b.time));
    }
    resize() {
        const dpr = window.devicePixelRatio || 1;
        const cw = this.canvas.clientWidth || 1, ch = this.canvas.clientHeight || 1;
        const tw = Math.floor(cw * dpr), th = Math.floor(ch * dpr);
        if (this.canvas.width !== tw) this.canvas.width = tw;
        if (this.canvas.height !== th) this.canvas.height = th;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w: cw, h: ch };
    }
    clear() {
        const { w, h } = this.resize();
        this.ctx.fillStyle = BG_COLOR;
        this.ctx.fillRect(0, 0, w, h);
    }

    whiteIndexOf(midi) {
        const oct = Math.floor(midi / 12);
        const s = ((midi % 12) + 12) % 12;
        let idx = 0;
        WHITE_KEY_SEMITONES.forEach(w => { if (w < s) idx++; });
        return oct * 7 + idx;
    }
    midiToY(midi, top, height) {
        const minW = this.whiteIndexOf(this.minMidi);
        const maxW = this.whiteIndexOf(this.maxMidi);
        const span = maxW - minW || 1;
        const isWhite = WHITE_KEY_SEMITONES.includes(((midi % 12) + 12) % 12);
        const myW = this.whiteIndexOf(midi) + (isWhite ? 0 : 0.5);
        return top + (1 - (myW - minW) / span) * height;
    }

    getLayout(w, h) {
        const mobile = isMobile();
        const top = mobile ? 16 : 24;
        const bottom = mobile ? 16 : 24;
        const height = Math.max(10, h - top - bottom);
        const playheadX = mobile ? 56 : Math.min(220, w * 0.18);
        const rightPad = mobile ? 16 : 40;
        const pxPerSec = Math.max(20, (w - playheadX - rightPad) / (measuresVisible() * this.measureDur));
        return { top, bottom, height, playheadX, rightPad, pxPerSec };
    }

    drawPitchAxis(w, top, height) {
        this.ctx.save();
        const mobile = isMobile();
        this.ctx.font = `italic ${mobile ? 8 : 9}px 'EB Garamond', serif`;
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";
        for (let midi = 12; midi <= 108; midi += 12) {
            if (midi < this.minMidi || midi > this.maxMidi) continue;
            const y = this.midiToY(midi, top, height);
            const octave = Math.floor(midi / 12) - 1;
            this.ctx.fillStyle = "rgba(232, 212, 162, 0.22)";
            if (!mobile) this.ctx.fillText(`C${octave}`, 14, y);
            this.ctx.strokeStyle = "rgba(232, 212, 162, 0.05)";
            this.ctx.lineWidth = 0.5;
            this.ctx.beginPath();
            this.ctx.moveTo(mobile ? 8 : 38, y);
            this.ctx.lineTo(w - 16, y);
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    drawTimeGrid(now, w, top, height, playheadX, pxPerSec) {
        const beatDur = 60 / this.tempo;
        const measureDur = this.measureDur;
        const visibleSec = (w - playheadX) / pxPerSec + 1;
        const startT = Math.floor((now - 1.5) / beatDur) * beatDur;
        const endT = now + visibleSec;
        const leftBound = isMobile() ? 8 : 40;
        const rightBound = w - 16;

        this.ctx.save();
        this.ctx.lineWidth = 0.5;
        for (let t = startT; t <= endT; t += beatDur) {
            const x = playheadX + (t - now) * pxPerSec;
            if (x < leftBound || x > rightBound) continue;
            const measurePhase = ((t / measureDur) % 1 + 1) % 1;
            const isMeasure = measurePhase < 0.01 || measurePhase > 0.99;
            const beatIdx = Math.round(t / beatDur);
            const isStrongBeat = beatIdx % 2 === 0;
            const edgeFade = Math.min(1, Math.min(x - leftBound, rightBound - x) / 50);
            let alpha;
            if (isMeasure) alpha = 0.10;
            else if (isStrongBeat) alpha = 0.045;
            else alpha = 0.025;
            this.ctx.strokeStyle = `rgba(232, 212, 162, ${alpha * Math.max(0, edgeFade)})`;
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
        grad.addColorStop(0.5, "rgba(201, 169, 97, 0.4)");
        grad.addColorStop(1, "rgba(201, 169, 97, 0)");
        this.ctx.strokeStyle = grad;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(x, top);
        this.ctx.lineTo(x, top + height);
        this.ctx.stroke();
        this.ctx.restore();
    }

    noteAt(mx, my, now, w, h) {
        const { top, height, playheadX, pxPerSec } = this.getLayout(w, h);
        for (const n of this.notes) {
            const x = playheadX + (n.time - now) * pxPerSec;
            const noteW = Math.max(n.duration * pxPerSec, 2);
            if (mx < x - 2 || mx > x + noteW + 2) continue;
            const y = this.midiToY(n.midi, top, height);
            const weight = Math.min(1, n.duration / this.measureDur);
            const noteH = 3 + weight * 8;
            if (Math.abs(my - y) <= noteH / 2 + 3) return n;
        }
        return null;
    }

    draw(audioTime, inIntro = false, introProgress = 0) {
        const { w, h } = this.resize();
        this.ctx.fillStyle = BG_COLOR;
        this.ctx.fillRect(0, 0, w, h);

        if (this.notes.length === 0) return;

        const targetNow = inIntro ? -SILENT_INTRO * (1 - introProgress) : audioTime;

        if (this.isAnimating) {
            const diff = targetNow - this.smoothNow;
            this.smoothNow += diff * (Math.abs(diff) > 1 ? 1 : 0.3);
        } else {
            this.smoothNow = targetNow;
        }
        const now = this.smoothNow;

        const { top, height, playheadX, pxPerSec } = this.getLayout(w, h);

        let globalFade;
        if (inIntro) {
            globalFade = introProgress;
        } else {
            const sinceStart = audioTime - this.visualStartTime;
            globalFade = Math.min(1, Math.max(0, sinceStart / 1.0 + 0.3));
        }
        const endFade = audioTime > this.totalTime - 2 && !inIntro
            ? Math.max(0, 1 - (audioTime - (this.totalTime - 2)) / 2) : 1;

        this.ctx.globalAlpha = Math.max(0.001, globalFade * endFade);

        this.drawPitchAxis(w, top, height);

        if (this.view !== "voice-constellation") {
            this.drawTimeGrid(now, w, top, height, playheadX, pxPerSec);
        }

        if (this.view === "architectural")            this.drawArchitectural(now, w, top, height, playheadX, pxPerSec);
        else if (this.view === "melodic-contour")     this.drawMelodicContour(now, w, top, height, playheadX, pxPerSec);
        else if (this.view === "voice-constellation") this.drawVoiceConstellation(Math.max(0, audioTime), w, h);

        if (this.view !== "voice-constellation") {
            this.drawPlayhead(playheadX, top, height);
        }

        this.ctx.globalAlpha = 1;

        if (audioTime >= this.totalTime && this.totalTime > 0 && !inIntro) {
            const fadeOut = Math.max(0, 1 - (audioTime - this.totalTime) / 3);
            if (fadeOut > 0) {
                this.ctx.save();
                this.ctx.globalAlpha = fadeOut * 0.55;
                this.ctx.fillStyle = getPalette().ink;
                this.ctx.font = `italic ${isMobile() ? 16 : 18}px 'EB Garamond', serif`;
                this.ctx.textAlign = "center";
                this.ctx.textBaseline = "middle";
                this.ctx.fillText("— fin —", w / 2, h / 2);
                this.ctx.restore();
            }
        }
    }

    drawArchitectural(now, w, top, height, playheadX, pxPerSec) {
        const lookBack = 3.5;
        const lookForward = (w - playheadX) / pxPerSec + 0.5;
        const visible = this.notes.filter(n =>
            (n.time + n.duration) > (now - lookBack) && n.time < (now + lookForward)
        );

        const baseAlpha = this.ctx.globalAlpha;
        const palette = getPalette();

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

            const vel = (typeof n.velocity === 'number') ? n.velocity : 0.7;
            alpha *= 0.55 + vel * 0.45;

            if (this.hoveredVoice !== null) {
                if (this.hoveredVoice === n.track) alpha = Math.min(1, alpha * 1.35);
                else alpha *= 0.25;
            }

            const weight = Math.min(1, n.duration / this.measureDur);
            const noteH = 3 + weight * 8;
            const color = palette.voices[n.track % palette.voices.length];

            this.ctx.save();
            this.ctx.globalAlpha = Math.min(1, alpha) * baseAlpha;
            this.ctx.fillStyle = color;
            this.roundRect(x, y - noteH / 2, noteW, noteH, Math.min(1.5, noteH / 2));
            this.ctx.fill();

            if (active) {
                this.ctx.strokeStyle = "rgba(255, 248, 220, 0.45)";
                this.ctx.lineWidth = 0.5;
                this.roundRect(x + 0.5, y - noteH/2 + 0.5, Math.max(1, noteW - 1), Math.max(1, noteH - 1), 1);
                this.ctx.stroke();
            }
            this.ctx.restore();
        });
    }

    drawMelodicContour(now, w, top, height, playheadX, pxPerSec) {
        const lookBack = 4;
        const lookForward = (w - playheadX) / pxPerSec + 0.5;
        const baseAlpha = this.ctx.globalAlpha;
        const palette = getPalette();

        Object.entries(this.voiceGroups).forEach(([trackStr, notes]) => {
            const track = parseInt(trackStr, 10);
            const color = palette.voices[track % palette.voices.length];
            const visible = notes.filter(n =>
                n.time > (now - lookBack) && n.time < (now + lookForward)
            );
            if (visible.length < 2) return;

            const hasActive = visible.some(n => now >= n.time && now <= n.time + n.duration);
            let voiceAlpha = hasActive ? 0.7 : 0.32;
            let lineWidth = hasActive ? 1.3 : 0.75;
            if (this.hoveredVoice !== null) {
                if (this.hoveredVoice === track) { voiceAlpha = 0.95; lineWidth = 1.6; }
                else { voiceAlpha *= 0.3; }
            }

            this.ctx.save();
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = lineWidth;
            this.ctx.globalAlpha = voiceAlpha * baseAlpha;
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
                this.ctx.globalAlpha = baseAlpha;
                this.ctx.fillStyle = color;
                this.ctx.beginPath();
                this.ctx.arc(x, y, 3, 0, Math.PI * 2);
                this.ctx.fill();
            });
            this.ctx.restore();
        });
    }

    // ═══ Chord detection ══════════════════════════════════════════════════════════
    // Returns { name, root, quality } or null if inconclusive.
    detectChord(activeNotes) {
        if (activeNotes.length < 2) return null;
        // Get unique pitch classes
        const pcSet = new Set();
        activeNotes.forEach(n => pcSet.add(((n.midi % 12) + 12) % 12));
        const pcs = Array.from(pcSet).sort((a, b) => a - b);
        if (pcs.length < 2) return null;
        // Find lowest-sounding note (bass) as primary root candidate
        const bassNote = activeNotes.reduce((lo, n) => n.midi < lo.midi ? n : lo);
        const bassPc = ((bassNote.midi % 12) + 12) % 12;
        // Chord templates (intervals from root)
        const templates = [
            { name: "",      intervals: [0, 4, 7],       priority: 10 }, // major
            { name: "m",     intervals: [0, 3, 7],       priority: 10 }, // minor
            { name: "°",     intervals: [0, 3, 6],       priority: 8  }, // diminished
            { name: "⁺",     intervals: [0, 4, 8],       priority: 6  }, // augmented
            { name: "⁷",     intervals: [0, 4, 7, 10],   priority: 9  }, // dom 7
            { name: "maj⁷",  intervals: [0, 4, 7, 11],   priority: 9  }, // maj 7
            { name: "m⁷",    intervals: [0, 3, 7, 10],   priority: 9  }, // min 7
            { name: "ø",     intervals: [0, 3, 6, 10],   priority: 8  }, // half-dim
            { name: "°⁷",    intervals: [0, 3, 6, 9],    priority: 7  }, // dim 7
            { name: "sus⁴",  intervals: [0, 5, 7],       priority: 5  }, // sus4
            { name: "sus²",  intervals: [0, 2, 7],       priority: 5  }, // sus2
        ];
        const noteNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
        // Try each PC as potential root, score each template
        let best = null;
        for (const rootPc of pcs) {
            for (const tmpl of templates) {
                const expected = tmpl.intervals.map(iv => (rootPc + iv) % 12);
                // How many template tones are present?
                const matched = expected.filter(pc => pcSet.has(pc)).length;
                // How many extra tones are NOT in template?
                const extras = pcs.filter(pc => !expected.includes(pc)).length;
                // Coverage: matched / template size
                const coverage = matched / expected.length;
                // Must match all template tones
                if (matched < expected.length) continue;
                // Allow at most 1 extra (could be tension/passing tone)
                if (extras > 1) continue;
                // Score: prioritize coverage, penalize extras, bonus if root is bass
                let score = tmpl.priority * coverage * 10;
                score -= extras * 2;
                if (rootPc === bassPc) score += 5;
                if (!best || score > best.score) {
                    best = {
                        name: noteNames[rootPc] + tmpl.name,
                        root: rootPc,
                        quality: tmpl.name,
                        score
                    };
                }
            }
        }
        // Fallback: just an interval (two notes)
        if (!best && pcs.length === 2) {
            const interval = ((pcs[1] - pcs[0]) + 12) % 12;
            const intervalNames = {
                1: "m2", 2: "M2", 3: "m3", 4: "M3", 5: "P4",
                6: "TT", 7: "P5", 8: "m6", 9: "M6", 10: "m7", 11: "M7"
            };
            const iv = intervalNames[interval] || null;
            if (iv) {
                return { name: noteNames[pcs[0]] + "–" + noteNames[pcs[1]], interval: iv };
            }
        }
        return best;
    }

    drawVoiceConstellation(now, w, h) {
        const mobile = isMobile();
        const top = mobile ? 60 : 90;           // more room on top for chord label
        const bottom = mobile ? 40 : 60;
        const height = Math.max(10, h - top - bottom);
        const centerX = w / 2;
        const baseAlpha = this.ctx.globalAlpha;
        const palette = getPalette();
        // Octave reference lines
        this.ctx.save();
        this.ctx.font = `italic ${mobile ? 9 : 10}px 'EB Garamond', serif`;
        this.ctx.textAlign = "left";
        this.ctx.textBaseline = "middle";
        for (let midi = 12; midi <= 108; midi += 12) {
            if (midi < this.minMidi || midi > this.maxMidi) continue;
            const y = this.midiToY(midi, top, height);
            const octave = Math.floor(midi / 12) - 1;
            this.ctx.strokeStyle = "rgba(232, 212, 162, 0.05)";
            this.ctx.lineWidth = 0.5;
            this.ctx.beginPath();
            this.ctx.moveTo(w * 0.15, y);
            this.ctx.lineTo(w * 0.85, y);
            this.ctx.stroke();
            this.ctx.fillStyle = "rgba(232, 212, 162, 0.2)";
            this.ctx.fillText(`C${octave}`, w * 0.12, y);
        }
        this.ctx.restore();
        const activeNotes = this.notes.filter(n =>
            now >= n.time && now <= n.time + n.duration
        );
        // ─── Chord detection with smoothing ───────────────────────────────────
        const detected = this.detectChord(activeNotes);
        if (detected) {
            this._lastChord = detected;
            this._lastChordTime = now;
        }
        // Keep showing last chord for 0.4s after it disappears (stability)
        const chord = (now - (this._lastChordTime || 0) < 0.4) ? this._lastChord : null;
        // ─── Draw chord label ─────────────────────────────────────────────────
        if (chord && chord.name) {
            this.ctx.save();
            this.ctx.globalAlpha = baseAlpha * 0.85;
            this.ctx.fillStyle = palette.ink;
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            // Main chord name
            this.ctx.font = `italic 500 ${mobile ? 28 : 38}px 'EB Garamond', serif`;
            this.ctx.fillText(chord.name, centerX, mobile ? 28 : 42);
            // Subtle descriptor below
            if (chord.interval) {
                this.ctx.globalAlpha = baseAlpha * 0.35;
                this.ctx.font = `italic ${mobile ? 9 : 10}px 'EB Garamond', serif`;
                this.ctx.fillStyle = palette.gold;
                // Add letter-spacing via manual rendering
                const label = chord.interval + "  ·  interval";
                this.ctx.fillText(label.toUpperCase(), centerX, mobile ? 48 : 68);
            } else if (chord.quality !== undefined) {
                this.ctx.globalAlpha = baseAlpha * 0.35;
                this.ctx.font = `italic ${mobile ? 9 : 10}px 'EB Garamond', serif`;
                this.ctx.fillStyle = palette.gold;
                const qualityMap = {
                    "":      "major",
                    "m":     "minor",
                    "°":     "diminished",
                    "⁺":     "augmented",
                    "⁷":     "dominant 7th",
                    "maj⁷":  "major 7th",
                    "m⁷":    "minor 7th",
                    "ø":     "half-diminished",
                    "°⁷":    "diminished 7th",
                    "sus⁴":  "suspended 4th",
                    "sus²":  "suspended 2nd",
                };
                const label = qualityMap[chord.quality] || "";
                if (label) {
                    // Spaced uppercase
                    const spaced = label.toUpperCase().split('').join(' ');
                    this.ctx.fillText(spaced, centerX, mobile ? 48 : 68);
                }
            }
            this.ctx.restore();
        }
        if (activeNotes.length === 0) return;
        // Sort by track for stable layout
        activeNotes.sort((a, b) => a.track - b.track || a.midi - b.midi);
        const spread = Math.min(w * 0.5, 400);
        const points = activeNotes.map((n, i) => {
            const ratio = activeNotes.length === 1 ? 0.5 : i / (activeNotes.length - 1);
            const x = centerX - spread / 2 + ratio * spread;
            const y = this.midiToY(n.midi, top, height);
            return { x, y, n };
        });
        // Chord connecting line
        if (points.length > 1) {
            this.ctx.save();
            this.ctx.strokeStyle = palette.gold;
            this.ctx.globalAlpha = baseAlpha * 0.25;
            this.ctx.lineWidth = 0.75;
            this.ctx.beginPath();
            points.forEach((p, i) => {
                if (i === 0) this.ctx.moveTo(p.x, p.y);
                else this.ctx.lineTo(p.x, p.y);
            });
            this.ctx.stroke();
            this.ctx.restore();
        }
        // Points with glow + note name label
        const noteNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
        points.forEach(p => {
            const color = palette.voices[p.n.track % palette.voices.length];
            // Outer glow
            this.ctx.save();
            const gradient = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 22);
            gradient.addColorStop(0, color);
            gradient.addColorStop(1, "rgba(0,0,0,0)");
            this.ctx.globalAlpha = baseAlpha * 0.28;
            this.ctx.fillStyle = gradient;
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
            // Core dot
            this.ctx.save();
            this.ctx.globalAlpha = baseAlpha;
            this.ctx.fillStyle = color;
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
            // Note name next to point (small, italic)
            this.ctx.save();
            this.ctx.globalAlpha = baseAlpha * 0.5;
            this.ctx.fillStyle = palette.ink;
            this.ctx.font = `italic ${mobile ? 10 : 11}px 'EB Garamond', serif`;
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "top";
            const pc = ((p.n.midi % 12) + 12) % 12;
            const octave = Math.floor(p.n.midi / 12) - 1;
            this.ctx.fillText(`${noteNames[pc]}${octave}`, p.x, p.y + 10);
            this.ctx.restore();
        });
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
    const paletteToggle = document.getElementById("palette-toggle");
    const paletteMenu = document.getElementById("palette-menu");

    let hasPlayedOnce = false;
    let introActive = false;
    let introStartWallTime = 0;

    ren.clear();
    window.addEventListener("resize", () => { if (!ren.isAnimating) ren.clear(); });
    window.addEventListener("orientationchange", () => { setTimeout(() => ren.clear(), 100); });

    // ─── Palette picker ──────────────────────────────────────────────────────
    function renderPaletteToggle() {
        paletteToggle.innerHTML = '';
        getPalette().voices.slice(0, 4).forEach(c => {
            const s = document.createElement("span");
            s.className = "strip";
            s.style.background = c;
            paletteToggle.appendChild(s);
        });
    }
    function renderPaletteMenu() {
        paletteMenu.innerHTML = '';
        Object.entries(PALETTES).forEach(([key, p]) => {
            const btn = document.createElement("button");
            btn.className = "palette-option" + (key === activePalette ? " active" : "");
            const swatches = document.createElement("div");
            swatches.className = "palette-swatches";
            p.voices.slice(0, 4).forEach(c => {
                const s = document.createElement("span");
                s.className = "strip";
                s.style.background = c;
                swatches.appendChild(s);
            });
            const label = document.createElement("span");
            label.textContent = p.name;
            btn.appendChild(swatches);
            btn.appendChild(label);
            btn.onclick = (e) => {
                e.stopPropagation();
                activePalette = key;
                renderPaletteToggle();
                renderPaletteMenu();
                paletteMenu.classList.remove("open");
                if (!ren.isAnimating && ren.notes.length > 0) {
                    ren.draw(engine.pauseOffset || 0, false);
                }
            };
            paletteMenu.appendChild(btn);
        });
    }
    paletteToggle.onclick = (e) => {
        e.stopPropagation();
        paletteMenu.classList.toggle("open");
    };
    document.addEventListener("click", (e) => {
        if (!paletteMenu.contains(e.target) && e.target !== paletteToggle) {
            paletteMenu.classList.remove("open");
        }
    });
    renderPaletteToggle();
    renderPaletteMenu();

    // ─── Library ─────────────────────────────────────────────────────────────
    try {
        await lib.load("./bach.zip");
        tSel.innerHTML = "";
        const folders = Object.entries(lib.tree).sort(([a],[b]) => a.localeCompare(b));
        if (folders.length === 0) {
            tSel.innerHTML = "<option>No MIDI files found</option>";
            titleEl.textContent = "Library empty";
            titleEl.classList.remove("breathing","loading");
        } else {
            folders.forEach(([f, files]) => {
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
        }
    } catch (e) {
        console.error("Library load failed:", e);
        titleEl.textContent = "Could not load library";
        titleEl.classList.remove("breathing", "loading");
    }

    function updateTitle(immediate) {
        const apply = () => {
            const parsed = parseTitle(tSel.value || "");
            titleEl.classList.remove("loading", "breathing");
            titleEl.textContent = parsed.title;
            metaEl.textContent = parsed.meta;
            titleEl.style.opacity = '';
        };
        if (immediate) { apply(); return; }
        titleEl.style.opacity = '0';
        setTimeout(apply, 260);
    }

    vSel.onchange = (e) => {
        ren.view = e.target.value;
        if (!ren.isAnimating && ren.notes.length > 0) {
            ren.draw(engine.pauseOffset || 0, false);
        } else if (!ren.isAnimating) {
            ren.clear();
        }
    };

    tSel.onchange = () => {
        engine.stop();
        ren.notes = []; ren.totalTime = 0;
        ren.isAnimating = false;
        ren.smoothNow = 0;
        hasPlayedOnce = false;
        introActive = false;
        ren.clear();
        prog.style.width = "0%";
        seek.value = 0;
        seek.disabled = true;
        playBtn.textContent = "Play";
        playBtn.disabled = false;
        timeDisp.textContent = "0:00 / 0:00";
        updateTitle(false);
    };

    // ─── Render loop ─────────────────────────────────────────────────────────
    let rafId = null;
    let isDragging = false;
    const stopLoop = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } };
    const startLoop = () => {
        stopLoop();
        const loop = () => {
            if (!ren.isAnimating) { rafId = null; return; }

            if (introActive) {
                const elapsed = (performance.now() - introStartWallTime) / 1000;
                const introProgress = Math.min(1, elapsed / SILENT_INTRO);
                ren.draw(0, true, introProgress);
                rafId = requestAnimationFrame(loop);
                return;
            }

            const t = Math.max(0, Tone.Transport.seconds);
            ren.draw(t, false);

            if (ren.totalTime > 0) {
                const ratio = Math.min(Math.max(t, 0) / ren.totalTime, 1);
                prog.style.width = (ratio * 100) + "%";
                if (!isDragging) seek.value = ratio * 1000;
                timeDisp.textContent = `${formatTime(t)} / ${formatTime(ren.totalTime)}`;
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
                ren.setup(engine.notes, duration, engine.tempo);
            }
            await Tone.loaded();
            const useIntro = !hasPlayedOnce && engine.pauseOffset === 0;
            ren.visualStartTime = engine.pauseOffset;
            if (useIntro) {
                introActive = true;
                introStartWallTime = performance.now();
                ren.smoothNow = -SILENT_INTRO;
            } else {
                introActive = false;
            }
            await engine.play(engine.pauseOffset, useIntro, () => {
                introActive = false;
                ren.visualStartTime = Tone.Transport.seconds;
            });
            hasPlayedOnce = true;
            ren.isAnimating = true;
            startLoop();
            playBtn.textContent = "Pause";
            seek.disabled = false;
        } catch (e) { console.error("Play failed:", e); }
    };
    const doPause = () => {
        introActive = false;
        engine.pause();
        ren.isAnimating = false;
        stopLoop();
        playBtn.textContent = "Resume";
    };
    playBtn.onclick = () => { if (engine.isPlaying || introActive) doPause(); else doPlay(); };

    // ─── Scrubber ────────────────────────────────────────────────────────────
    let wasPlayingBeforeDrag = false;
    const onSeekStart = () => {
        if (ren.totalTime <= 0) return;
        isDragging = true;
        wasPlayingBeforeDrag = engine.isPlaying && !introActive;
        if (engine.isPlaying) {
            engine.cancelIntro();
            introActive = false;
            Tone.Transport.pause();
            engine.sampler.releaseAll();
        }
        ren.isAnimating = false;
        stopLoop();
    };
    const onSeekInput = (e) => {
        if (ren.totalTime <= 0) return;
        const t = (e.target.value / 1000) * ren.totalTime;
        ren.visualStartTime = t;
        ren.smoothNow = t;
        ren.draw(t, false);
        prog.style.width = (e.target.value / 10) + "%";
        timeDisp.textContent = `${formatTime(t)} / ${formatTime(ren.totalTime)}`;
    };
    const onSeekEnd = async (e) => {
        if (!isDragging) return;
        isDragging = false;
        if (ren.totalTime <= 0) return;
        const newTime = (e.target.value / 1000) * ren.totalTime;
        engine.pauseOffset = newTime;
        if (wasPlayingBeforeDrag) {
            ren.visualStartTime = newTime;
            ren.smoothNow = newTime;
            await engine.play(newTime, false, () => {});
            ren.isAnimating = true;
            startLoop();
        } else {
            ren.draw(newTime, false);
        }
    };
    seek.addEventListener("pointerdown", onSeekStart);
    seek.addEventListener("input", onSeekInput);
    seek.addEventListener("pointerup", onSeekEnd);
    seek.addEventListener("pointercancel", onSeekEnd);

    // ─── Hover (desktop only) ────────────────────────────────────────────────
    if (window.matchMedia("(hover: hover)").matches) {
        canvas.addEventListener("mousemove", (e) => {
            if (ren.view === "voice-constellation") {
                if (ren.hoveredVoice !== null) {
                    ren.hoveredVoice = null;
                    if (!ren.isAnimating) ren.draw(engine.pauseOffset || 0, false);
                }
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const now = introActive ? 0 : Math.max(0, Tone.Transport.seconds);
            const note = ren.noteAt(mx, my, now, canvas.clientWidth, canvas.clientHeight);
            const newVoice = note ? note.track : null;
            if (newVoice !== ren.hoveredVoice) {
                ren.hoveredVoice = newVoice;
                if (!ren.isAnimating) ren.draw(engine.pauseOffset || 0, false);
            }
        });
        canvas.addEventListener("mouseleave", () => {
            if (ren.hoveredVoice !== null) {
                ren.hoveredVoice = null;
                if (!ren.isAnimating) ren.draw(engine.pauseOffset || 0, false);
            }
        });
    }

    // ─── Keyboard ────────────────────────────────────────────────────────────
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
            ren.visualStartTime = newT;
            ren.smoothNow = newT;
            if (engine.isPlaying && !introActive) {
                engine.play(newT, false, () => {});
            } else {
                ren.draw(newT, false);
            }
            const ratio = newT / ren.totalTime;
            seek.value = ratio * 1000;
            prog.style.width = (ratio * 100) + "%";
            timeDisp.textContent = `${formatTime(newT)} / ${formatTime(ren.totalTime)}`;
        }
    });

    ren.clear();
});
