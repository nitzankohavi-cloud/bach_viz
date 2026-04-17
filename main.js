// ═══════════════════════════════════════════════════════════════════════════════
// Bach · A quiet window into counterpoint
// ═══════════════════════════════════════════════════════════════════════════════

const PALETTES = {
    candlelight: {
        name: "Candlelight",
        voices: ["#E8D4A2", "#C9A961", "#A88754", "#7A5F38", "#4A3B2A"],
        ink: "#E8D4A2", gold: "#C9A961"
    },
    grisaille: {
        name: "Grisaille",
        voices: ["#ECECEC", "#B8B8B8", "#8A8A8A", "#5C5C5C", "#3A3A3A"],
        ink: "#E0E0E0", gold: "#C0C0C0"
    },
    manuscript: {
        name: "Manuscript",
        voices: ["#D4B896", "#A8865E", "#7A5A3A", "#543B24", "#32220F"],
        ink: "#D4B896", gold: "#B08B5E"
    },
    ensemble: {
        name: "Ensemble",
        voices: ["#E8D4A2", "#6B8CAE", "#C97B5F", "#8FA876", "#B08FA0"],
        ink: "#E8D4A2", gold: "#C9A961"
    },
    quartet: {
        name: "Quartet",
        voices: ["#D97757", "#4A8BA8", "#D4A84A", "#6B8E5E", "#8E6B9E"],
        ink: "#E8D4A2", gold: "#C9A961"
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

// ═══ Analysis Engine ═══════════════════════════════════════════════════════════
// Decoupled from rendering. Call analyze() once after loading a track.
// Results: motifs[], keySegments[], cadences[]. Read-only after analysis.
class AnalysisEngine {
    constructor() {
        this.motifs       = [];   // [{ contour: int[], entries: [{track,notes,time,endTime}] }]
        this.keySegments  = [];   // [{ time, endTime, key, pc, mode, color }]
        this.cadences     = [];   // [{ time, type }]
        this.tempo        = 80;
        this.ready        = false;
    }

    analyze(notes, totalTime, tempo) {
        this.tempo   = tempo || 80;
        this.ready   = false;
        this.motifs  = [];
        this.keySegments = [];
        this.cadences    = [];
        if (!notes || notes.length === 0) return;
        this.keySegments = this._detectKeys(notes, totalTime);
        this.cadences    = this._detectCadences(notes, this.keySegments);
        this.motifs      = this._detectMotifs(notes);
        this.ready       = true;
    }

    // Returns {key, pc, mode, color} for a given playback time, or null.
    keyAt(t) {
        return this.keySegments.find(s => t >= s.time && t < s.endTime) || null;
    }

    // Heuristic voice label from average pitch of a track's notes.
    voiceNameFor(track, voiceGroups) {
        const ns  = voiceGroups[track] || [];
        const avg = ns.length ? ns.reduce((s, n) => s + n.midi, 0) / ns.length : 60;
        if (avg > 72) return "Soprano";
        if (avg > 60) return "Alto";
        if (avg > 48) return "Tenor";
        return "Bass";
    }

    // ── Module 1: Subject / Motif detection ──────────────────────────────────
    // Extracts the opening phrase of the first-entering voice as the "subject"
    // and searches for all occurrences (exact interval match → handles all
    // tonal transpositions of the subject automatically).
    _detectMotifs(notes) {
        const tracks = {};
        notes.forEach(n => {
            if (!tracks[n.track]) tracks[n.track] = [];
            tracks[n.track].push(n);
        });
        Object.values(tracks).forEach(t => t.sort((a, b) => a.time - b.time));
        const trackIds = Object.keys(tracks).map(Number).sort((a, b) => a - b);
        if (trackIds.length === 0) return [];

        const MOTIF_LEN  = 5;
        const beatDur    = 60 / this.tempo;
        const MAX_GAP    = beatDur * 1.5;  // max silence allowed within subject

        const toContour = (ns) => {
            const ivs = [];
            for (let i = 0; i < ns.length - 1; i++) ivs.push(ns[i + 1].midi - ns[i].midi);
            return ivs;
        };

        // Find the track whose first note appears earliest.
        const firstTrack = trackIds.reduce((best, id) => {
            const ft = tracks[id][0]?.time ?? Infinity;
            const bt = tracks[best]?.[0]?.time ?? Infinity;
            return ft < bt ? id : best;
        }, trackIds[0]);

        // Collect the opening continuous phrase of that track.
        const fv = tracks[firstTrack];
        const subNotes = [fv[0]];
        for (let i = 1; i < fv.length && subNotes.length < MOTIF_LEN; i++) {
            const gap = fv[i].time - (fv[i - 1].time + fv[i - 1].duration);
            if (gap <= MAX_GAP) subNotes.push(fv[i]);
            else break;
        }
        if (subNotes.length < MOTIF_LEN) return [];
        const subContour = toContour(subNotes.slice(0, MOTIF_LEN));
        const subKey     = subContour.join(',');

        // Search every track for occurrences of the same interval sequence.
        const entries = [];
        trackIds.forEach(id => {
            const tn = tracks[id];
            for (let i = 0; i <= tn.length - MOTIF_LEN; i++) {
                const slice = tn.slice(i, i + MOTIF_LEN);
                let valid = true;
                for (let j = 0; j < slice.length - 1; j++) {
                    if (slice[j + 1].time - (slice[j].time + slice[j].duration) > MAX_GAP) {
                        valid = false; break;
                    }
                }
                if (!valid) continue;
                if (toContour(slice).join(',') === subKey) {
                    entries.push({
                        track:   id,
                        notes:   slice,
                        time:    slice[0].time,
                        endTime: slice[slice.length - 1].time + slice[slice.length - 1].duration
                    });
                }
            }
        });

        entries.sort((a, b) => a.time - b.time);
        if (entries.length < 2) return [];  // not a recurring motif
        return [{ contour: subContour, entries }];
    }

    // ── Module 2: Tonal journey (Krumhansl–Kessler profiles) ─────────────────
    // Slides a window across the piece, correlates pitch-class weights with all
    // 24 key profiles, then smooths and merges consecutive identical segments.
    _detectKeys(notes, totalTime) {
        const KK_MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
        const KK_MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
        const NAMES  = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
        // Circle of fifths order → hue mapping
        const FIFTHS = [0,7,2,9,4,11,6,1,8,3,10,5];

        const keyColor = (pc, mode) => {
            const pos = FIFTHS.indexOf(pc);
            const hue = Math.round((pos / 12) * 360);
            return mode === 'major'
                ? `hsl(${hue},52%,40%)`
                : `hsl(${hue},40%,26%)`;
        };

        const beatDur = 60 / this.tempo;
        const WIN     = beatDur * 8;   // 2-measure analysis window
        const STEP    = beatDur * 4;   // 1-measure step
        const segs    = [];

        for (let t = 0; t < totalTime; t += STEP) {
            const ws = t, we = t + WIN;
            const pcW = new Array(12).fill(0);
            notes.forEach(n => {
                const ov = Math.min(n.time + n.duration, we) - Math.max(n.time, ws);
                if (ov <= 0) return;
                pcW[((n.midi % 12) + 12) % 12] += ov;
            });
            const tot = pcW.reduce((a, b) => a + b, 0);
            if (tot === 0) continue;
            const norm = pcW.map(w => w / tot);

            let best = { score: -Infinity, pc: 0, mode: 'major' };
            for (let r = 0; r < 12; r++) {
                let maj = 0, min = 0;
                for (let i = 0; i < 12; i++) {
                    maj += norm[(i + r) % 12] * KK_MAJ[i];
                    min += norm[(i + r) % 12] * KK_MIN[i];
                }
                if (maj > best.score) best = { score: maj, pc: r, mode: 'major' };
                if (min > best.score) best = { score: min, pc: r, mode: 'minor' };
            }
            segs.push({
                time:    t,
                endTime: Math.min(t + STEP, totalTime),
                key:     NAMES[best.pc],
                pc:      best.pc,
                mode:    best.mode,
                color:   keyColor(best.pc, best.mode)
            });
        }

        // Smooth: collapse lone-segment anomalies (same neighbours → inherit).
        for (let i = 1; i < segs.length - 1; i++) {
            const p = segs[i - 1].pc + segs[i - 1].mode;
            const n = segs[i + 1].pc + segs[i + 1].mode;
            if (p === n && (segs[i].pc + segs[i].mode) !== p) {
                Object.assign(segs[i], {
                    pc: segs[i-1].pc, mode: segs[i-1].mode,
                    key: segs[i-1].key, color: segs[i-1].color
                });
            }
        }

        // Merge consecutive identical keys into one segment.
        const merged = [];
        segs.forEach(s => {
            const last = merged[merged.length - 1];
            if (last && last.key === s.key && last.mode === s.mode) last.endTime = s.endTime;
            else merged.push({ ...s });
        });
        return merged;
    }

    // ── Module 3: Cadence detection (V→I) ─────────────────────────────────────
    // Scans the piece in 2-beat steps, builds a pitch-class snapshot per window,
    // and looks for dominant-function → tonic-function progressions.
    _detectCadences(notes, keySegs) {
        const beatDur = 60 / this.tempo;
        const STEP    = beatDur * 2;
        const total   = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);

        const keyAt = (t) => keySegs.find(s => t >= s.time && t < s.endTime) || null;

        const pcSetAt = (t) => {
            const active = notes.filter(n => n.time < t + STEP && n.time + n.duration > t);
            if (active.length < 2) return null;
            return new Set(active.map(n => ((n.midi % 12) + 12) % 12));
        };

        // Dominant: must have the dominant root AND the leading tone of the key.
        const hasDom = (pcs, kpc) =>
            pcs.has((kpc + 7) % 12) && pcs.has((kpc + 11) % 12);

        // Tonic: root + major or minor third.
        const hasTon = (pcs, kpc) =>
            pcs.has(kpc) && (pcs.has((kpc + 4) % 12) || pcs.has((kpc + 3) % 12));

        const cadences = [];
        let prev = null;
        for (let t = STEP; t < total; t += STEP) {
            const cur = pcSetAt(t);
            if (!cur || !prev) { prev = cur; continue; }
            const key = keyAt(t);
            if (key && hasDom(prev, key.pc) && hasTon(cur, key.pc)) {
                cadences.push({ time: t, type: 'authentic', key });
            }
            prev = cur;
        }

        // Deduplicate: keep only cadences at least 4 beats apart.
        return cadences.filter((c, i) =>
            i === 0 || c.time - cadences[i - 1].time > beatDur * 4
        );
    }
}

// ═══ Audio Engine ══════════════════════════════════════════════════════════════
class AudioEngine {
    constructor() {
        this.sampler = new Tone.Sampler({
            urls: {
                A0:"A0.mp3",  C1:"C1.mp3",  "D#1":"Ds1.mp3", "F#1":"Fs1.mp3",
                A1:"A1.mp3",  C2:"C2.mp3",  "D#2":"Ds2.mp3", "F#2":"Fs2.mp3",
                A2:"A2.mp3",  C3:"C3.mp3",  "D#3":"Ds3.mp3", "F#3":"Fs3.mp3",
                A3:"A3.mp3",  C4:"C4.mp3",  "D#4":"Ds4.mp3", "F#4":"Fs4.mp3",
                A4:"A4.mp3",  C5:"C5.mp3",  "D#5":"Ds5.mp3", "F#5":"Fs5.mp3",
                A5:"A5.mp3",  C6:"C6.mp3",  "D#6":"Ds6.mp3", "F#6":"Fs6.mp3",
                A6:"A6.mp3",  C7:"C7.mp3"
            },
            baseUrl: "https://tonejs.github.io/audio/salamander/",
            release: 0.6
        }).toDestination();
        this.sampler.volume.value = -3;
        this.notes = []; this.isPlaying = false; this.pauseOffset = 0;
        this.scheduledIds = []; this.tempo = 80;
        this.introTimeoutId = null;
        // 0 = flat like organ, 1 = full human expression from MIDI file
        this.dynamicsAmount = 0.4;
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
    cancelIntro() {
        if (this.introTimeoutId) { clearTimeout(this.introTimeoutId); this.introTimeoutId = null; }
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
                const vel = 0.5 + (n.velocity - 0.5) * this.dynamicsAmount;
                const id = Tone.Transport.schedule(t => {
                    this.sampler.triggerAttackRelease(
                        Tone.Frequency(n.midi, "midi").toNote(),
                        Math.max(n.duration, 0.05), t, vel
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
        this._lastChord = null;
        this._lastChordTime = 0;
        // Roadmap
        this.roadmapActive = false;
        this.analysisData  = null;  // set to an AnalysisEngine instance when ready
    }
    setup(notes, dur, tempo) {
        this.notes = notes; this.totalTime = dur;
        this.tempo = tempo || 80;
        this.measureDur = (60 / this.tempo) * 4;
        this.smoothNow = 0;
        this.voiceGroups = {};
        this._lastChord = null;
        this._lastChordTime = 0;
        this.analysisData = null;
        if (notes.length === 0) return;
        let min = 127, max = 0;
        notes.forEach(n => { min = Math.min(min, n.midi); max = Math.max(max, n.midi); });
        this.minMidi = Math.max(0, min - 2);
        this.maxMidi = Math.min(127, max + 2);
        notes.forEach(n => {
            if (!this.voiceGroups[n.track]) this.voiceGroups[n.track] = [];
            this.voiceGroups[n.track].push(n);
        });
        Object.values(this.voiceGroups).forEach(g => g.sort((a, b) => a.time - b.time));
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
        const s   = ((midi % 12) + 12) % 12;
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
        const rightPad  = mobile ? 16 : 40;
        const pxPerSec  = Math.max(20, (w - playheadX - rightPad) / (measuresVisible() * this.measureDur));
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
            this.ctx.fillStyle = "rgba(232,212,162,0.22)";
            if (!mobile) this.ctx.fillText(`C${octave}`, 14, y);
            this.ctx.strokeStyle = "rgba(232,212,162,0.05)";
            this.ctx.lineWidth = 0.5;
            this.ctx.beginPath();
            this.ctx.moveTo(mobile ? 8 : 38, y);
            this.ctx.lineTo(w - 16, y);
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    drawTimeGrid(now, w, top, height, playheadX, pxPerSec) {
        const beatDur    = 60 / this.tempo;
        const measureDur = this.measureDur;
        const visibleSec = (w - playheadX) / pxPerSec + 1;
        const startT     = Math.floor((now - 1.5) / beatDur) * beatDur;
        const endT       = now + visibleSec;
        const leftBound  = isMobile() ? 8 : 40;
        const rightBound = w - 16;
        this.ctx.save();
        this.ctx.lineWidth = 0.5;
        for (let t = startT; t <= endT; t += beatDur) {
            const x = playheadX + (t - now) * pxPerSec;
            if (x < leftBound || x > rightBound) continue;
            const mp       = ((t / measureDur) % 1 + 1) % 1;
            const isMeas   = mp < 0.01 || mp > 0.99;
            const isStrong = Math.round(t / beatDur) % 2 === 0;
            const edge     = Math.min(1, Math.min(x - leftBound, rightBound - x) / 50);
            const alpha    = isMeas ? 0.10 : isStrong ? 0.045 : 0.025;
            this.ctx.strokeStyle = `rgba(232,212,162,${alpha * Math.max(0, edge)})`;
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
        grad.addColorStop(0,   "rgba(201,169,97,0)");
        grad.addColorStop(0.5, "rgba(201,169,97,0.4)");
        grad.addColorStop(1,   "rgba(201,169,97,0)");
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
            const x     = playheadX + (n.time - now) * pxPerSec;
            const noteW = Math.max(n.duration * pxPerSec, 2);
            if (mx < x - 2 || mx > x + noteW + 2) continue;
            const y      = this.midiToY(n.midi, top, height);
            const weight = Math.min(1, n.duration / this.measureDur);
            const noteH  = 3 + weight * 8;
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
            globalFade = Math.min(1, Math.max(0, (audioTime - this.visualStartTime) / 1.0 + 0.3));
        }
        const endFade = (audioTime > this.totalTime - 2 && !inIntro)
            ? Math.max(0, 1 - (audioTime - (this.totalTime - 2)) / 2) : 1;

        this.ctx.globalAlpha = Math.max(0.001, globalFade * endFade);

        this.drawPitchAxis(w, top, height);
        if (this.view !== "voice-constellation") {
            this.drawTimeGrid(now, w, top, height, playheadX, pxPerSec);
        }

        if      (this.view === "architectural")       this.drawArchitectural(now, w, top, height, playheadX, pxPerSec);
        else if (this.view === "melodic-contour")     this.drawMelodicContour(now, w, top, height, playheadX, pxPerSec);
        else if (this.view === "voice-constellation") this.drawVoiceConstellation(Math.max(0, audioTime), w, h);

        // ── Roadmap overlays (architectural + melodic-contour only) ──
        if (this.roadmapActive && this.analysisData?.ready &&
            this.view !== "voice-constellation") {
            this.drawMotifOverlay(now, w, top, height, playheadX, pxPerSec);
            this.drawCadenceMarkers(now, w, top, height, playheadX, pxPerSec);
        }

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

    // ── Roadmap overlay 1: motif brackets ─────────────────────────────────────
    drawMotifOverlay(now, w, top, height, playheadX, pxPerSec) {
        if (!this.analysisData?.ready || !this.analysisData.motifs.length) return;
        const motif     = this.analysisData.motifs[0];
        const lookFwd   = (w - playheadX) / pxPerSec + 0.5;
        const lookBack  = 3.5;
        const palette   = getPalette();
        const baseAlpha = this.ctx.globalAlpha;
        const mobile    = isMobile();

        motif.entries.forEach(entry => {
            if (entry.endTime < now - lookBack || entry.time > now + lookFwd) return;
            const isActive = now >= entry.time && now <= entry.endTime;
            const color    = palette.voices[entry.track % palette.voices.length];

            // Map each note to canvas coords; keep only those on-screen.
            const pts = entry.notes
                .map(n => ({
                    x: playheadX + (n.time - now) * pxPerSec,
                    y: this.midiToY(n.midi, top, height)
                }))
                .filter(p => p.x >= playheadX - 2 && p.x <= w - 16);

            if (pts.length < 2) return;

            const x0       = pts[0].x;
            const x1       = pts[pts.length - 1].x;
            const avgY     = pts.reduce((s, p) => s + p.y, 0) / pts.length;
            const bracketY = avgY + 16;

            this.ctx.save();
            this.ctx.globalAlpha  = baseAlpha * (isActive ? 0.85 : 0.38);
            this.ctx.strokeStyle  = color;
            this.ctx.lineWidth    = isActive ? 1.5 : 0.75;
            if (!isActive) this.ctx.setLineDash([3, 4]);

            // ⌣-bracket below the note cluster
            this.ctx.beginPath();
            this.ctx.moveTo(x0, bracketY - 5);
            this.ctx.lineTo(x0, bracketY);
            this.ctx.lineTo(Math.min(x1, w - 20), bracketY);
            if (x1 <= w - 20) this.ctx.lineTo(x1, bracketY - 5);
            this.ctx.stroke();
            this.ctx.setLineDash([]);

            if (isActive) {
                const vname = this.analysisData.voiceNameFor(entry.track, this.voiceGroups);
                this.ctx.globalAlpha = baseAlpha * 0.7;
                this.ctx.fillStyle   = color;
                this.ctx.font        = `italic ${mobile ? 9 : 10}px 'EB Garamond', serif`;
                this.ctx.textAlign   = "left";
                this.ctx.textBaseline = "top";
                this.ctx.fillText(vname.toLowerCase(), x0 + 2, bracketY + 2);
            }
            this.ctx.restore();
        });

        // Floating announcement: fades in as subject enters, out before it ends.
        const nowEntry = motif.entries.find(e => {
            const el = now - e.time;
            return el >= 0 && el < 1.2;
        });
        if (nowEntry) {
            const el   = now - nowEntry.time;
            const fade = el < 0.2 ? el / 0.2 : Math.max(0, 1 - (el - 0.4) / 0.8);
            if (fade > 0.01) {
                const vname = this.analysisData.voiceNameFor(nowEntry.track, this.voiceGroups);
                const color = palette.voices[nowEntry.track % palette.voices.length];
                this.ctx.save();
                this.ctx.globalAlpha  = baseAlpha * fade * 0.9;
                this.ctx.fillStyle    = color;
                this.ctx.font         = `italic ${mobile ? 12 : 14}px 'EB Garamond', serif`;
                this.ctx.textAlign    = "right";
                this.ctx.textBaseline = "top";
                this.ctx.fillText(`subject · ${vname.toLowerCase()}`,
                    w - (mobile ? 16 : 40), top + 4);
                this.ctx.restore();
            }
        }
    }

    // ── Roadmap overlay 2: cadence diamonds ───────────────────────────────────
    drawCadenceMarkers(now, w, top, height, playheadX, pxPerSec) {
        if (!this.analysisData?.ready) return;
        const lookFwd   = (w - playheadX) / pxPerSec + 0.5;
        const lookBack  = 3.5;
        const palette   = getPalette();
        const baseAlpha = this.ctx.globalAlpha;

        this.analysisData.cadences.forEach(c => {
            if (c.time < now - lookBack || c.time > now + lookFwd) return;
            const x     = playheadX + (c.time - now) * pxPerSec;
            const isPast = c.time < now;
            const alpha  = isPast
                ? Math.max(0, 0.5 * (1 - (now - c.time) / lookBack))
                : 0.72;
            const s = 4;
            const y = top - 7;

            this.ctx.save();
            this.ctx.globalAlpha = baseAlpha * alpha;
            this.ctx.fillStyle   = palette.gold;
            this.ctx.beginPath();
            this.ctx.moveTo(x,     y - s);
            this.ctx.lineTo(x + s, y);
            this.ctx.lineTo(x,     y + s);
            this.ctx.lineTo(x - s, y);
            this.ctx.closePath();
            this.ctx.fill();
            this.ctx.restore();
        });
    }

    drawArchitectural(now, w, top, height, playheadX, pxPerSec) {
        const lookBack  = 3.5;
        const lookFwd   = (w - playheadX) / pxPerSec + 0.5;
        const visible   = this.notes.filter(n =>
            (n.time + n.duration) > (now - lookBack) && n.time < (now + lookFwd)
        );
        const baseAlpha = this.ctx.globalAlpha;
        const palette   = getPalette();

        visible.forEach(n => {
            const x      = playheadX + (n.time - now) * pxPerSec;
            const noteW  = Math.max(n.duration * pxPerSec, 2);
            const y      = this.midiToY(n.midi, top, height);
            const active = now >= n.time && now <= n.time + n.duration;
            const past   = now > n.time + n.duration;

            let alpha;
            if (active)      alpha = 1;
            else if (past)   alpha = Math.max(0, 0.32 * (1 - (now - (n.time + n.duration)) / lookBack));
            else             alpha = 0.55;

            const vel = (typeof n.velocity === 'number') ? n.velocity : 0.7;
            alpha *= 0.55 + vel * 0.45;

            if (this.hoveredVoice !== null) {
                if (this.hoveredVoice === n.track) alpha = Math.min(1, alpha * 1.35);
                else alpha *= 0.25;
            }

            const weight = Math.min(1, n.duration / this.measureDur);
            const noteH  = 3 + weight * 8;
            const color  = palette.voices[n.track % palette.voices.length];

            this.ctx.save();
            this.ctx.globalAlpha = Math.min(1, alpha) * baseAlpha;
            this.ctx.fillStyle   = color;
            this.roundRect(x, y - noteH / 2, noteW, noteH, Math.min(1.5, noteH / 2));
            this.ctx.fill();
            if (active) {
                this.ctx.strokeStyle = "rgba(255,248,220,0.45)";
                this.ctx.lineWidth   = 0.5;
                this.roundRect(x + 0.5, y - noteH / 2 + 0.5,
                    Math.max(1, noteW - 1), Math.max(1, noteH - 1), 1);
                this.ctx.stroke();
            }
            this.ctx.restore();
        });
    }

    drawMelodicContour(now, w, top, height, playheadX, pxPerSec) {
        const lookBack = 4;
        const lookFwd  = (w - playheadX) / pxPerSec + 0.5;
        const baseAlpha = this.ctx.globalAlpha;
        const palette   = getPalette();

        Object.entries(this.voiceGroups).forEach(([trackStr, notes]) => {
            const track   = parseInt(trackStr, 10);
            const color   = palette.voices[track % palette.voices.length];
            const visible = notes.filter(n =>
                n.time > (now - lookBack) && n.time < (now + lookFwd)
            );
            if (visible.length < 2) return;

            const hasActive = visible.some(n => now >= n.time && now <= n.time + n.duration);
            let voiceAlpha  = hasActive ? 0.7 : 0.32;
            let lineWidth   = hasActive ? 1.3 : 0.75;
            if (this.hoveredVoice !== null) {
                if (this.hoveredVoice === track) { voiceAlpha = 0.95; lineWidth = 1.6; }
                else voiceAlpha *= 0.3;
            }

            this.ctx.save();
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth   = lineWidth;
            this.ctx.globalAlpha = voiceAlpha * baseAlpha;
            this.ctx.lineCap = "round"; this.ctx.lineJoin = "round";
            this.ctx.beginPath();
            visible.forEach((n, i) => {
                const x = playheadX + (n.time - now) * pxPerSec;
                const y = this.midiToY(n.midi, top, height);
                if (i === 0) this.ctx.moveTo(x, y); else this.ctx.lineTo(x, y);
            });
            this.ctx.stroke();
            visible.forEach(n => {
                if (!(now >= n.time && now <= n.time + n.duration)) return;
                const x = playheadX + (n.time - now) * pxPerSec;
                const y = this.midiToY(n.midi, top, height);
                this.ctx.globalAlpha = baseAlpha;
                this.ctx.fillStyle   = color;
                this.ctx.beginPath();
                this.ctx.arc(x, y, 3, 0, Math.PI * 2);
                this.ctx.fill();
            });
            this.ctx.restore();
        });
    }

    // ── Chord detection ────────────────────────────────────────────────────────
    detectChord(activeNotes) {
        if (activeNotes.length < 2) return null;
        const pcSet = new Set();
        activeNotes.forEach(n => pcSet.add(((n.midi % 12) + 12) % 12));
        const pcs = Array.from(pcSet).sort((a, b) => a - b);
        if (pcs.length < 2) return null;
        const bassNote = activeNotes.reduce((lo, n) => n.midi < lo.midi ? n : lo);
        const bassPc   = ((bassNote.midi % 12) + 12) % 12;
        const templates = [
            { name: "",     intervals: [0,4,7],    priority: 10 },
            { name: "m",    intervals: [0,3,7],    priority: 10 },
            { name: "°",    intervals: [0,3,6],    priority: 8  },
            { name: "⁺",    intervals: [0,4,8],    priority: 6  },
            { name: "⁷",    intervals: [0,4,7,10], priority: 9  },
            { name: "maj⁷", intervals: [0,4,7,11], priority: 9  },
            { name: "m⁷",   intervals: [0,3,7,10], priority: 9  },
            { name: "ø",    intervals: [0,3,6,10], priority: 8  },
            { name: "°⁷",   intervals: [0,3,6,9],  priority: 7  },
            { name: "sus⁴", intervals: [0,5,7],    priority: 5  },
            { name: "sus²", intervals: [0,2,7],    priority: 5  },
        ];
        const NOTE_NAMES = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
        let best = null;
        for (const rootPc of pcs) {
            for (const tmpl of templates) {
                const expected = tmpl.intervals.map(iv => (rootPc + iv) % 12);
                const matched  = expected.filter(pc => pcSet.has(pc)).length;
                const extras   = pcs.filter(pc => !expected.includes(pc)).length;
                if (matched < expected.length || extras > 1) continue;
                let score = tmpl.priority * (matched / expected.length) * 10 - extras * 2;
                if (rootPc === bassPc) score += 5;
                if (!best || score > best.score)
                    best = { name: NOTE_NAMES[rootPc] + tmpl.name, root: rootPc,
                             quality: tmpl.name, score };
            }
        }
        if (!best && pcs.length === 2) {
            const iv = ((pcs[1] - pcs[0]) + 12) % 12;
            const IV_NAMES = { 1:"m2",2:"M2",3:"m3",4:"M3",5:"P4",6:"TT",
                               7:"P5",8:"m6",9:"M6",10:"m7",11:"M7" };
            if (IV_NAMES[iv])
                return { name: NOTE_NAMES[pcs[0]] + "–" + NOTE_NAMES[pcs[1]],
                         interval: IV_NAMES[iv] };
        }
        return best;
    }

    drawVoiceConstellation(now, w, h) {
        const mobile    = isMobile();
        const top       = mobile ? 60 : 90;
        const bottom    = mobile ? 40 : 60;
        const height    = Math.max(10, h - top - bottom);
        const centerX   = w / 2;
        const baseAlpha = this.ctx.globalAlpha;
        const palette   = getPalette();

        // Octave reference lines
        this.ctx.save();
        this.ctx.font = `italic ${mobile ? 9 : 10}px 'EB Garamond', serif`;
        this.ctx.textAlign = "left"; this.ctx.textBaseline = "middle";
        for (let midi = 12; midi <= 108; midi += 12) {
            if (midi < this.minMidi || midi > this.maxMidi) continue;
            const y = this.midiToY(midi, top, height);
            this.ctx.strokeStyle = "rgba(232,212,162,0.05)";
            this.ctx.lineWidth   = 0.5;
            this.ctx.beginPath();
            this.ctx.moveTo(w * 0.15, y); this.ctx.lineTo(w * 0.85, y);
            this.ctx.stroke();
            this.ctx.fillStyle = "rgba(232,212,162,0.2)";
            this.ctx.fillText(`C${Math.floor(midi / 12) - 1}`, w * 0.12, y);
        }
        this.ctx.restore();

        const activeNotes = this.notes.filter(n => now >= n.time && now <= n.time + n.duration);

        // Chord detection with 0.4s persistence
        const detected = this.detectChord(activeNotes);
        if (detected) { this._lastChord = detected; this._lastChordTime = now; }
        const chord = (now - (this._lastChordTime || 0) < 0.4) ? this._lastChord : null;

        if (chord?.name) {
            const QUAL_MAP = {
                "":"major","m":"minor","°":"diminished","⁺":"augmented",
                "⁷":"dominant 7th","maj⁷":"major 7th","m⁷":"minor 7th",
                "ø":"half-diminished","°⁷":"diminished 7th",
                "sus⁴":"suspended 4th","sus²":"suspended 2nd"
            };
            this.ctx.save();
            this.ctx.globalAlpha = baseAlpha * 0.85;
            this.ctx.fillStyle   = palette.ink;
            this.ctx.textAlign   = "center"; this.ctx.textBaseline = "middle";
            this.ctx.font = `italic 500 ${mobile ? 28 : 38}px 'EB Garamond', serif`;
            this.ctx.fillText(chord.name, centerX, mobile ? 28 : 42);
            if (chord.interval || chord.quality !== undefined) {
                this.ctx.globalAlpha = baseAlpha * 0.35;
                this.ctx.fillStyle   = palette.gold;
                this.ctx.font = `italic ${mobile ? 9 : 10}px 'EB Garamond', serif`;
                const lbl = chord.interval
                    ? (chord.interval + "  ·  interval").toUpperCase()
                    : (QUAL_MAP[chord.quality] || "").toUpperCase().split('').join(' ');
                if (lbl) this.ctx.fillText(lbl, centerX, mobile ? 48 : 68);
            }
            this.ctx.restore();
        }

        // ── Roadmap key label (constellation view) ──
        if (this.roadmapActive && this.analysisData?.ready) {
            const seg = this.analysisData.keyAt(now);
            if (seg) {
                const kLabel = seg.key + (seg.mode === 'minor' ? ' minor' : ' major');
                this.ctx.save();
                this.ctx.globalAlpha  = baseAlpha * 0.32;
                this.ctx.fillStyle    = palette.gold;
                this.ctx.font         = `italic ${mobile ? 10 : 11}px 'EB Garamond', serif`;
                this.ctx.textAlign    = "center";
                this.ctx.textBaseline = "bottom";
                this.ctx.fillText(kLabel.toUpperCase().split('').join(' '),
                    centerX, h - (mobile ? 18 : 28));
                this.ctx.restore();
            }
        }

        if (activeNotes.length === 0) return;
        activeNotes.sort((a, b) => a.track - b.track || a.midi - b.midi);

        const spread = Math.min(w * 0.5, 400);
        const points = activeNotes.map((n, i) => {
            const ratio = activeNotes.length === 1 ? 0.5 : i / (activeNotes.length - 1);
            return {
                x: centerX - spread / 2 + ratio * spread,
                y: this.midiToY(n.midi, top, height),
                n
            };
        });

        if (points.length > 1) {
            this.ctx.save();
            this.ctx.strokeStyle = palette.gold;
            this.ctx.globalAlpha = baseAlpha * 0.25;
            this.ctx.lineWidth   = 0.75;
            this.ctx.beginPath();
            points.forEach((p, i) => {
                if (i === 0) this.ctx.moveTo(p.x, p.y); else this.ctx.lineTo(p.x, p.y);
            });
            this.ctx.stroke();
            this.ctx.restore();
        }

        const NOTE_NAMES = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
        points.forEach(p => {
            const color = palette.voices[p.n.track % palette.voices.length];
            this.ctx.save();
            const grad = this.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 22);
            grad.addColorStop(0, color); grad.addColorStop(1, "rgba(0,0,0,0)");
            this.ctx.globalAlpha = baseAlpha * 0.28;
            this.ctx.fillStyle   = grad;
            this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 22, 0, Math.PI * 2); this.ctx.fill();
            this.ctx.restore();

            this.ctx.save();
            this.ctx.globalAlpha = baseAlpha;
            this.ctx.fillStyle   = color;
            this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); this.ctx.fill();
            this.ctx.restore();

            this.ctx.save();
            this.ctx.globalAlpha  = baseAlpha * 0.5;
            this.ctx.fillStyle    = palette.ink;
            this.ctx.font         = `italic ${mobile ? 10 : 11}px 'EB Garamond', serif`;
            this.ctx.textAlign    = "center"; this.ctx.textBaseline = "top";
            const pc = ((p.n.midi % 12) + 12) % 12;
            this.ctx.fillText(`${NOTE_NAMES[pc]}${Math.floor(p.n.midi / 12) - 1}`,
                p.x, p.y + 10);
            this.ctx.restore();
        });
    }

    roundRect(x, y, w, h, r) {
        const c = this.ctx;
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        c.beginPath();
        c.moveTo(x + r, y);
        c.lineTo(x + w - r, y);
        c.quadraticCurveTo(x + w, y, x + w, y + r);
        c.lineTo(x + w, y + h - r);
        c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        c.lineTo(x + r, y + h);
        c.quadraticCurveTo(x, y + h, x, y + h - r);
        c.lineTo(x, y + r);
        c.quadraticCurveTo(x, y, x + r, y);
        c.closePath();
    }
}

// ═══ App ═══════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
    const canvas        = document.getElementById("visualizer");
    const ren           = new Renderer(canvas);
    const engine        = new AudioEngine();
    const lib           = new BachLibrary();
    const analysis      = new AnalysisEngine();

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
    const dynamicsSlider = document.getElementById("dynamics-slider");
    const dynamicsLabel  = document.getElementById("dynamics-label");
    const roadmapBtn    = document.getElementById("roadmap-toggle");
    const tonalMapWrap  = document.getElementById("tonal-map-wrap");
    const tonalCanvas   = document.getElementById("tonal-map-canvas");

    let hasPlayedOnce = false;
    let introActive   = false;
    let introStartWallTime = 0;
    let roadmapActive = false;

    ren.clear();
    window.addEventListener("resize", () => {
        if (!ren.isAnimating) ren.clear();
        if (roadmapActive && analysis.ready) drawTonalMap();
    });
    window.addEventListener("orientationchange", () => {
        setTimeout(() => { ren.clear(); if (roadmapActive && analysis.ready) drawTonalMap(); }, 100);
    });

    // ── Tonal map renderer ───────────────────────────────────────────────────
    // Draws the full harmonic timeline onto the small canvas below the scrubber.
    function drawTonalMap(currentTime) {
        if (!tonalCanvas || !analysis.ready || !ren.totalTime) return;
        const ctx  = tonalCanvas.getContext("2d");
        const dpr  = window.devicePixelRatio || 1;
        const cw   = tonalCanvas.clientWidth;
        const ch   = tonalCanvas.clientHeight;
        if (cw === 0 || ch === 0) return;
        tonalCanvas.width  = Math.floor(cw * dpr);
        tonalCanvas.height = Math.floor(ch * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);

        const total = ren.totalTime;

        // Colored key segments
        analysis.keySegments.forEach(seg => {
            const x0 = (seg.time    / total) * cw;
            const x1 = (seg.endTime / total) * cw;
            ctx.fillStyle = seg.color;
            ctx.fillRect(Math.floor(x0), 0, Math.ceil(x1 - x0) + 1, ch);
        });

        // Key labels at each transition (skip if too crowded)
        const fs = Math.max(8, Math.floor(ch * 0.64));
        ctx.font         = `${fs}px sans-serif`;
        ctx.textBaseline = "middle";
        let lastLx = -999;
        let lastLbl = null;
        analysis.keySegments.forEach(seg => {
            const lbl = seg.key + (seg.mode === 'minor' ? 'm' : '');
            if (lbl === lastLbl) return;
            lastLbl = lbl;
            const x = (seg.time / total) * cw + 3;
            if (x - lastLx < 34) return;
            lastLx = x;
            ctx.fillStyle = "rgba(255,255,255,0.7)";
            ctx.fillText(lbl, x, ch / 2);
        });

        // Cadence dots
        analysis.cadences.forEach(c => {
            const x = (c.time / total) * cw;
            ctx.beginPath();
            ctx.arc(x, ch / 2, 2, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,248,220,0.7)";
            ctx.fill();
        });

        // Playhead cursor
        const t = currentTime ?? (ren.isAnimating ? Math.max(0, Tone.Transport.seconds) : (engine.pauseOffset || 0));
        if (t >= 0 && total > 0) {
            const px = (t / total) * cw;
            ctx.strokeStyle = "rgba(255,248,220,0.9)";
            ctx.lineWidth   = 1.5;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ch); ctx.stroke();
        }
    }

    // ── Roadmap toggle ───────────────────────────────────────────────────────
    if (roadmapBtn) {
        roadmapBtn.addEventListener("click", () => {
            roadmapActive = !roadmapActive;
            ren.roadmapActive = roadmapActive;
            roadmapBtn.classList.toggle("active", roadmapActive);

            if (tonalMapWrap) {
                tonalMapWrap.style.display = roadmapActive ? "block" : "none";
            }
            if (roadmapActive && analysis.ready) {
                drawTonalMap();
            }
            if (!ren.isAnimating && ren.notes.length > 0) {
                ren.draw(engine.pauseOffset || 0, false);
            }
        });
    }

    // ── Dynamics slider ──────────────────────────────────────────────────────
    if (dynamicsSlider) {
        dynamicsSlider.value = Math.round(engine.dynamicsAmount * 100);
        const updateDynLabel = (v) => {
            if (!dynamicsLabel) return;
            const pct = Math.round(v);
            dynamicsLabel.textContent =
                pct <=  5 ? "organ" :
                pct <= 30 ? "subtle" :
                pct <= 60 ? "expressive" :
                pct <= 80 ? "dramatic" : "full";
        };
        updateDynLabel(dynamicsSlider.value);
        dynamicsSlider.addEventListener("input", e => {
            engine.dynamicsAmount = e.target.value / 100;
            updateDynLabel(e.target.value);
        });
    }

    // ── Palette picker ───────────────────────────────────────────────────────
    function renderPaletteToggle() {
        paletteToggle.innerHTML = '';
        getPalette().voices.slice(0, 4).forEach(c => {
            const s = document.createElement("span");
            s.className = "strip"; s.style.background = c;
            paletteToggle.appendChild(s);
        });
    }
    function renderPaletteMenu() {
        paletteMenu.innerHTML = '';
        Object.entries(PALETTES).forEach(([key, p]) => {
            const btn = document.createElement("button");
            btn.className = "palette-option" + (key === activePalette ? " active" : "");
            const sw = document.createElement("div"); sw.className = "palette-swatches";
            p.voices.slice(0, 4).forEach(c => {
                const s = document.createElement("span");
                s.className = "strip"; s.style.background = c; sw.appendChild(s);
            });
            const lbl = document.createElement("span"); lbl.textContent = p.name;
            btn.appendChild(sw); btn.appendChild(lbl);
            btn.onclick = (e) => {
                e.stopPropagation();
                activePalette = key;
                renderPaletteToggle(); renderPaletteMenu();
                paletteMenu.classList.remove("open");
                if (!ren.isAnimating && ren.notes.length > 0)
                    ren.draw(engine.pauseOffset || 0, false);
            };
            paletteMenu.appendChild(btn);
        });
    }
    paletteToggle.onclick = (e) => { e.stopPropagation(); paletteMenu.classList.toggle("open"); };
    document.addEventListener("click", (e) => {
        if (!paletteMenu.contains(e.target) && e.target !== paletteToggle)
            paletteMenu.classList.remove("open");
    });
    renderPaletteToggle(); renderPaletteMenu();

    // ── Library ──────────────────────────────────────────────────────────────
    try {
        await lib.load("./bach.zip");
        tSel.innerHTML = "";
        const folders = Object.entries(lib.tree).sort(([a], [b]) => a.localeCompare(b));
        if (folders.length === 0) {
            tSel.innerHTML = "<option>No MIDI files found</option>";
            titleEl.textContent = "Library empty";
            titleEl.classList.remove("breathing", "loading");
        } else {
            folders.forEach(([f, files]) => {
                const g = document.createElement("optgroup"); g.label = f;
                files.sort().forEach(file => {
                    const o = document.createElement("option");
                    o.value = file; o.textContent = parseTitle(file).title;
                    g.appendChild(o);
                });
                tSel.appendChild(g);
            });
            tSel.disabled = false; playBtn.disabled = false;
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
            metaEl.textContent  = parsed.meta;
            titleEl.style.opacity = '';
        };
        if (immediate) { apply(); return; }
        titleEl.style.opacity = '0';
        setTimeout(apply, 260);
    }

    vSel.onchange = (e) => {
        ren.view = e.target.value;
        if (!ren.isAnimating && ren.notes.length > 0)
            ren.draw(engine.pauseOffset || 0, false);
        else if (!ren.isAnimating)
            ren.clear();
    };

    tSel.onchange = () => {
        engine.stop();
        ren.notes = []; ren.totalTime = 0;
        ren.isAnimating = false; ren.smoothNow = 0;
        hasPlayedOnce = false; introActive = false;
        analysis.ready = false; ren.analysisData = null;
        ren.clear();
        prog.style.width = "0%"; seek.value = 0; seek.disabled = true;
        playBtn.textContent = "Play"; playBtn.disabled = false;
        timeDisp.textContent = "0:00 / 0:00";
        // Clear tonal map
        if (tonalCanvas) {
            const ctx = tonalCanvas.getContext("2d");
            ctx.clearRect(0, 0, tonalCanvas.width, tonalCanvas.height);
        }
        updateTitle(false);
    };

    // ── Render loop ──────────────────────────────────────────────────────────
    let rafId     = null;
    let isDragging = false;
    const stopLoop  = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } };
    const startLoop = () => {
        stopLoop();
        const loop = () => {
            if (!ren.isAnimating) { rafId = null; return; }

            if (introActive) {
                const elapsed = (performance.now() - introStartWallTime) / 1000;
                const ip      = Math.min(1, elapsed / SILENT_INTRO);
                ren.draw(0, true, ip);
                rafId = requestAnimationFrame(loop);
                return;
            }

            const t = Math.max(0, Tone.Transport.seconds);
            ren.draw(t, false);

            // Update tonal map playhead every frame when roadmap is on
            if (roadmapActive && analysis.ready) drawTonalMap(t);

            if (ren.totalTime > 0) {
                const ratio = Math.min(Math.max(t, 0) / ren.totalTime, 1);
                prog.style.width = (ratio * 100) + "%";
                if (!isDragging) seek.value = ratio * 1000;
                timeDisp.textContent = `${formatTime(t)} / ${formatTime(ren.totalTime)}`;
                if (t >= ren.totalTime + 3.2) {
                    engine.stop(); ren.isAnimating = false; hasPlayedOnce = false;
                    playBtn.textContent = "Play"; seek.value = 0; prog.style.width = "0%";
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
                // Run analysis in background (fast, but defer to not block UI)
                setTimeout(() => {
                    analysis.analyze(engine.notes, duration, engine.tempo);
                    ren.analysisData = analysis;
                    if (roadmapActive && analysis.ready) drawTonalMap();
                }, 0);
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
        engine.pause(); ren.isAnimating = false; stopLoop();
        playBtn.textContent = "Resume";
    };
    playBtn.onclick = () => {
        if (engine.isPlaying || introActive) doPause(); else doPlay();
    };

    // ── Scrubber ─────────────────────────────────────────────────────────────
    let wasPlayingBeforeDrag = false;
    const onSeekStart = () => {
        if (ren.totalTime <= 0) return;
        isDragging = true;
        wasPlayingBeforeDrag = engine.isPlaying && !introActive;
        if (engine.isPlaying) {
            engine.cancelIntro(); introActive = false;
            Tone.Transport.pause(); engine.sampler.releaseAll();
        }
        ren.isAnimating = false; stopLoop();
    };
    const onSeekInput = (e) => {
        if (ren.totalTime <= 0) return;
        const t = (e.target.value / 1000) * ren.totalTime;
        ren.visualStartTime = t; ren.smoothNow = t;
        ren.draw(t, false);
        prog.style.width = (e.target.value / 10) + "%";
        timeDisp.textContent = `${formatTime(t)} / ${formatTime(ren.totalTime)}`;
        if (roadmapActive && analysis.ready) drawTonalMap(t);
    };
    const onSeekEnd = async (e) => {
        if (!isDragging) return;
        isDragging = false;
        if (ren.totalTime <= 0) return;
        const newTime = (e.target.value / 1000) * ren.totalTime;
        engine.pauseOffset = newTime;
        if (wasPlayingBeforeDrag) {
            ren.visualStartTime = newTime; ren.smoothNow = newTime;
            await engine.play(newTime, false, () => {});
            ren.isAnimating = true; startLoop();
        } else {
            ren.draw(newTime, false);
            if (roadmapActive && analysis.ready) drawTonalMap(newTime);
        }
    };
    seek.addEventListener("pointerdown", onSeekStart);
    seek.addEventListener("input",       onSeekInput);
    seek.addEventListener("pointerup",   onSeekEnd);
    seek.addEventListener("pointercancel", onSeekEnd);

    // ── Hover (desktop only) ─────────────────────────────────────────────────
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
            const note = ren.noteAt(e.clientX - rect.left, e.clientY - rect.top,
                introActive ? 0 : Math.max(0, Tone.Transport.seconds),
                canvas.clientWidth, canvas.clientHeight);
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

    // ── Keyboard ─────────────────────────────────────────────────────────────
    document.addEventListener("keydown", (e) => {
        if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
        if (e.code === "Space") {
            e.preventDefault();
            if (!playBtn.disabled) playBtn.click();
        } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
            if (ren.totalTime <= 0) return;
            e.preventDefault();
            const delta   = e.code === "ArrowLeft" ? -5 : 5;
            const current = Math.max(0, Tone.Transport.seconds);
            const newT    = Math.max(0, Math.min(ren.totalTime, current + delta));
            engine.pauseOffset = newT; ren.visualStartTime = newT; ren.smoothNow = newT;
            if (engine.isPlaying && !introActive) engine.play(newT, false, () => {});
            else ren.draw(newT, false);
            const ratio = newT / ren.totalTime;
            seek.value = ratio * 1000; prog.style.width = (ratio * 100) + "%";
            timeDisp.textContent = `${formatTime(newT)} / ${formatTime(ren.totalTime)}`;
            if (roadmapActive && analysis.ready) drawTonalMap(newT);
        }
    });

    ren.clear();
});
