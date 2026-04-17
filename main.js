// ═══════════════════════════════════════════════════════════════════════════════
// Bach Visualisation · Master Edition (Responsive & Mobile Ready)
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

            filePromises.push(
                zipEntry.async("arraybuffer").then(buffer => {
                    this.works.set(cleanPath, buffer);
                })
            );
        });
        
        await Promise.all(filePromises);
        if (this.works.size === 0) throw new Error("No MIDI files found in ZIP.");
    }

    getWork(path) {
        return this.works.get(path);
    }
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
                notes.push({
                    time: note.time,
                    duration: note.duration,
                    midi: note.midi,
                    velocity: note.velocity,
                    trackIndex: index
                });
                if (note.time + note.duration > totalDuration) {
                    totalDuration = note.time + note.duration;
                }
            });
        });

        this.currentNotes = notes;
        return { notes, totalDuration };
    }

    async play(startTime = this.pauseOffset) {
        await Tone.start();
        await Tone.loaded(); 
        
        this.isPlaying = true;
        this.pauseOffset = startTime;
        
        Tone.Transport.stop();
        Tone.Transport.cancel(0);
        Tone.Transport.position = startTime;

        this.currentNotes.forEach(note => {
            if (note.time < startTime) return; 
            
            Tone.Transport.schedule((time) => {
                this.piano.triggerAttackRelease(
                    Tone.Frequency(note.midi, "midi").toNote(),
                    note.duration,
                    time,
                    note.velocity
                );
            }, note.time);
        });

        Tone.Transport.start();
    }

    pause() {
        this.isPlaying = false;
        Tone.Transport.pause();
        this.pauseOffset = Tone.Transport.seconds;
        this.piano.releaseAll();
    }

    stop() {
        this.isPlaying = false;
        Tone.Transport.stop();
        Tone.Transport.cancel(0);
        this.pauseOffset = 0;
        this.piano.releaseAll();
    }

    getCurrentTime() {
        if (!this.isPlaying) return this.pauseOffset;
        return Tone.Transport.seconds;
    }
}

class CanvasRenderer {
    constructor(canvas) {
        if (!canvas) throw new Error("CanvasRenderer: canvas element required");
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

        this.FRAME_PREDICTION = 0.016; 

        this.noteEvents = [];
        this.totalDuration = 0;
        this.isAnimating = false;
        this.rafId = null;
        this._voiceNotes = [[], [], [], [], []];
        this._lastSize = { w: 0, h: 0, dpr: 0 };

        this.playheadX = 180;
        this.pixelsPerSecond = 180;
        this.noteHeight = 12;
        this.pitchMargin = 4;
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
        this.analyticalView = "melodic-contour"; 
        this._layout = { width: 1, height: 1, topPad: 40, bottomPad: 48, usableHeight: 1, midiSpan: 1, startTime: 0, endTime: 0 };

        this.onProgress = null; 
        this.resizeForDpi();
    }

    setPalette(index) {
        if (this.palettes[index]) {
            this.currentPaletteIndex = index;
            this.voiceColors = this.palettes[index];
            if (!this.isAnimating && this.noteEvents.length > 0) {
                 this.drawFrame(this._lastDrawnTime || 0);
            }
        }
    }

    _ny(midi, l) { return l.topPad + (1 - (midi - this.minMidi) / l.midiSpan) * l.usableHeight; }
    _nx(time, now, l) { return this.playheadX + (time - now) * this.pixelsPerSecond; }

    reset() {
        this.stop();
        this.noteEvents = [];
        this._voiceNotes = [[], [], [], [], []];
        this.totalDuration = 0;
    }

    setMidiData(noteEvents, totalDuration) {
        this.noteEvents = [...noteEvents].sort((a, b) => a.time - b.time);
        this.totalDuration = Number(totalDuration) || 0;

        let min = 127, max = 0;
        for (const n of this.noteEvents) {
            if (n.midi < min) min = n.midi;
            if (n.midi > max) max = n.midi;
        }
        if (min > max) { min = 48; max = 72; } 

        this.minMidi = Math.max(0, min - this.pitchMargin);
        this.maxMidi = Math.min(127, max + this.pitchMargin);

        this._voiceNotes = [[], [], [], [], []];
        for (const n of this.noteEvents) {
            const v = Math.max(0, Math.min(4, n.trackIndex | 0));
            this._voiceNotes[v].push(n);
        }
    }

    setView(view) {
        const valid = ["melodic-contour", "architectural", "harmonic-lattice"];
        if (valid.includes(view)) {
            this.analyticalView = view;
            if (!this.isAnimating && this.noteEvents.length > 0) {
                 this.drawFrame(this._lastDrawnTime || 0);
            }
        }
    }

    start(getCurrentTime) {
        this.isAnimating = true;

        const animate = () => {
            if (!this.isAnimating) return;
            const rawTime = getCurrentTime();
            const visualTime = Math.max(0, rawTime + this.FRAME_PREDICTION);
            this.drawFrame(visualTime);

            if (this.onProgress && this.totalDuration > 0) {
                this.onProgress(Math.min(1, rawTime / this.totalDuration));
            }

            if (this.totalDuration > 0 && rawTime >= this.totalDuration + 1) {
                this.stop();
                return;
            }
            this.rafId = window.requestAnimationFrame(animate);
        };
        this.rafId = window.requestAnimationFrame(animate);
    }

    stop() {
        this.isAnimating = false;
        if (this.rafId !== null) {
            window.cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    resizeForDpi() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));

        if (this._lastSize.w === w && this._lastSize.h === h && this._lastSize.dpr === dpr) return;

        this.canvas.width = w;
        this.canvas.height = h;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._lastSize = { w, h, dpr };
    }

    drawPlaceholder(text = "AWAITING DATA") {
        this.resizeForDpi();
        const { ctx } = this;
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;

        ctx.fillStyle = this.bgColor;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "rgba(255,255,255,0.32)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "300 12px 'EB Garamond', Georgia, serif";
        ctx.fillText(text.toUpperCase(), w / 2, h / 2);
    }

    drawFrame(now) {
        this._lastDrawnTime = now;
        this.resizeForDpi();
        const l = this._layout;
        l.width = this.canvas.clientWidth;
        l.height = this.canvas.clientHeight;
        l.usableHeight = Math.max(1, l.height - l.topPad - l.bottomPad);
        l.midiSpan = Math.max(1, this.maxMidi - this.minMidi);
        
        // 📱 התאמה דינאמית למובייל 📱
        // מזיז את הפלייהד אחורה ומאט את המהירות במסכים צרים כדי לתת חוויה טובה יותר
        const isMobile = l.width < 768;
        this.playheadX = isMobile ? Math.min(80, l.width * 0.2) : 180;
        this.pixelsPerSecond = isMobile ? 120 : 180;

        l.startTime = now - this.playheadX / this.pixelsPerSecond;
        l.endTime = now + (l.width - this.playheadX) / this.pixelsPerSecond;

        const ctx = this.ctx;
        ctx.fillStyle = this.bgColor;
        ctx.fillRect(0, 0, l.width, l.height);

        this._drawGrid(l);

        const buf = 2.0; 
        const visibleNotes = this.noteEvents.filter(
            n => (n.time + n.duration) > l.startTime - buf && n.time < l.endTime + buf
        );

        if (this.analyticalView === "melodic-contour") this._drawContour(now, l, visibleNotes);
        else if (this.analyticalView === "architectural") this._drawArchitectural(now, l, visibleNotes);
        else this._drawLattice(now, l, visibleNotes);

        this._drawPlayhead(l, now);
        this._drawVignette(l);
    }

    _drawGrid(l) {
        const ctx = this.ctx;
        ctx.save();
        for (let m = this.minMidi; m <= this.maxMidi; m++) {
            const pc = m % 12;
            if (pc !== 0 && pc !== 5) continue;
            const y = Math.floor(this._ny(m, l)) + 0.5;
            const isC = pc === 0;

            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(l.width, y);
            ctx.strokeStyle = isC ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.04)";
            ctx.lineWidth = 1;
            ctx.setLineDash(isC ? [1, 6] : [1, 10]);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawVignette(l) {
        const ctx = this.ctx;
        const fadeLeft = this.playheadX * 0.4;
        const lg = ctx.createLinearGradient(0, 0, fadeLeft, 0);
        lg.addColorStop(0, this.bgColor);
        lg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = lg;
        ctx.fillRect(0, 0, fadeLeft, l.height);

        const fadeRight = Math.min(150, l.width * 0.3); // מותאם למובייל
        const rg = ctx.createLinearGradient(l.width - fadeRight, 0, l.width, 0);
        rg.addColorStop(0, "rgba(0,0,0,0)");
        rg.addColorStop(1, this.bgColor);
        ctx.fillStyle = rg;
        ctx.fillRect(l.width - fadeRight, 0, fadeRight, l.height);
    }

    _drawPlayhead(l) {
        const ctx = this.ctx;
        const x = Math.round(this.playheadX) + 0.5;
        ctx.save();
        
        ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
        ctx.lineWidth = 1;
        
        ctx.beginPath();
        ctx.moveTo(x, l.topPad);
        ctx.lineTo(x, l.height - l.bottomPad);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
        ctx.beginPath(); ctx.moveTo(x, l.topPad - 4); ctx.lineTo(x+3, l.topPad); ctx.lineTo(x, l.topPad+4); ctx.lineTo(x-3, l.topPad); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, l.height - l.bottomPad - 4); ctx.lineTo(x+3, l.height - l.bottomPad); ctx.lineTo(x, l.height - l.bottomPad+4); ctx.lineTo(x-3, l.height - l.bottomPad); ctx.fill();
        
        ctx.restore();
    }

    _drawContour(now, l, visibleNotes) {
        const ctx = this.ctx;
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        for (let v = 0; v < 5; v++) {
            const vn = this._voiceNotes[v];
            if (!vn || vn.length < 2) continue;
            const color = this.voiceColors[v];

            ctx.beginPath();
            let first = true;
            vn.forEach((n) => {
                if (n.time < l.startTime - 2) return; 
                if (n.time > l.endTime) return;
                
                const x = this._nx(n.time, now, l);
                const y = this._ny(n.midi, l);
                first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                first = false;
            });
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5; 
            ctx.globalAlpha = 0.4;
            ctx.stroke();
        }
        ctx.restore();

        for (const n of visibleNotes) {
            const x = this._nx(n.time, now, l);
            const y = this._ny(n.midi, l);
            const color = this.voiceColors[n.trackIndex % 5];
            const age = now - n.time;
            const active = now >= n.time && now <= n.time + n.duration;

            ctx.save();
            if (active) {
                ctx.fillStyle = this.bgColor;
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                
                ctx.fillStyle = "#FFFFFF";
                ctx.beginPath();
                ctx.arc(x, y, 2.5, 0, Math.PI * 2);
                ctx.fill();
            } else {
                const isFuture = age < 0;
                const alpha = isFuture ? Math.max(0.1, 1 - Math.abs(age) * 0.5) : Math.max(0, 0.5 - age * 0.15);
                
                ctx.globalAlpha = alpha;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
    }

    _drawArchitectural(now, l, visibleNotes) {
        const ctx = this.ctx;
        for (const n of visibleNotes) {
            const x = this._nx(n.time, now, l);
            const y = this._ny(n.midi, l) - this.noteHeight / 2;
            const w = Math.max(4, n.duration * this.pixelsPerSecond);
            const color = this.voiceColors[n.trackIndex % 5];
            const active = now >= n.time && now <= n.time + n.duration;

            ctx.save();
            ctx.fillStyle = color;
            ctx.globalAlpha = active ? 0.95 : (now - n.time > 0 ? 0.15 : 0.6);
            
            ctx.beginPath();
            ctx.rect(x, y, w, this.noteHeight);
            ctx.fill();

            if (active) {
                ctx.strokeStyle = "#FFFFFF";
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    _drawLattice(now, l, visibleNotes) {
        const ctx = this.ctx;
        const cx = this.playheadX;

        const sounding = [];
        const upcoming = [];

        for (const n of visibleNotes) {
            if (now >= n.time && now <= n.time + n.duration) {
                sounding.push(n);
            } else if (n.time > now && n.time < now + 2.0) {
                upcoming.push(n);
            }
        }

        for (const n of upcoming) {
            const x = this._nx(n.time, now, l);
            const y = this._ny(n.midi, l);
            const color = this.voiceColors[n.trackIndex % 5];
            
            ctx.save();
            const distanceFactor = Math.max(0, 1 - (n.time - now) / 2.0);
            
            ctx.strokeStyle = color;
            ctx.lineWidth = 2; 
            ctx.globalAlpha = distanceFactor * 0.4;
            
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 15, y);
            ctx.stroke();
            
            ctx.globalAlpha = distanceFactor * 0.08;
            ctx.beginPath();
            ctx.moveTo(cx, y);
            ctx.lineTo(x, y);
            ctx.stroke();
            
            ctx.restore();
        }

        if (sounding.length === 0) return;

        sounding.sort((a, b) => b.midi - a.midi);
        const ys = sounding.map(n => this._ny(n.midi, l));

        ctx.save();
        if (sounding.length >= 2) {
            const topY = Math.min(...ys);
            const botY = Math.max(...ys);

            ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(cx, topY);
            ctx.lineTo(cx, botY);
            ctx.stroke();
            
            const gradient = ctx.createLinearGradient(cx - 20, 0, cx + 20, 0);
            gradient.addColorStop(0, "rgba(255,255,255,0)");
            gradient.addColorStop(0.5, "rgba(255,255,255,0.06)");
            gradient.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = gradient;
            ctx.fillRect(cx - 20, topY, 40, botY - topY);
        }
        ctx.restore();

        for (const n of sounding) {
            const y = this._ny(n.midi, l);
            const color = this.voiceColors[n.trackIndex % 5];
            
            ctx.save();
            ctx.translate(cx, y);
            
            const glow = ctx.createRadialGradient(0, 0, 8, 0, 0, 24);
            glow.addColorStop(0, color);
            glow.addColorStop(1, "rgba(0,0,0,0)");
            ctx.globalAlpha = 0.25;
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(0, 0, 24, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = 1.0;

            ctx.beginPath();
            ctx.arc(0, 0, 14, 0, Math.PI * 2);
            ctx.fillStyle = this.bgColor;
            ctx.fill();
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = color;
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(0, 0, 7, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();

            const tailProgression = (now - n.time) * this.pixelsPerSecond;
            const maxTail = 50; 
            const tailLength = Math.min(tailProgression, maxTail);
            
            if (tailLength > 2) {
                ctx.beginPath();
                ctx.moveTo(-14, 0);
                ctx.lineTo(-14 - tailLength, 0);
                const tailGrad = ctx.createLinearGradient(-14, 0, -14 - tailLength, 0);
                tailGrad.addColorStop(0, color);
                tailGrad.addColorStop(1, "rgba(0,0,0,0)");
                ctx.strokeStyle = tailGrad;
                ctx.lineWidth = 3.5;
                ctx.stroke();
            }
            
            ctx.restore();
        }
    }
}

function buildPalettePicker(renderer) {
    const container = document.getElementById("palette-picker-container");
    if (!container) return;
    container.innerHTML = '';
    
    renderer.palettes.forEach((palette, index) => {
        const btn = document.createElement("div");
        btn.className = `palette-btn ${index === renderer.currentPaletteIndex ? 'active' : ''}`;
        
        palette.forEach(color => {
            const strip = document.createElement("div");
            strip.className = "palette-color-strip";
            strip.style.backgroundColor = color;
            btn.appendChild(strip);
        });

        btn.addEventListener("click", () => {
            document.querySelectorAll(".palette-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderer.setPalette(index);
        });

        container.appendChild(btn);
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("visualizer");
    const renderer = new CanvasRenderer(canvas);
    const audio = new AudioEngine();
    
    buildPalettePicker(renderer);

    const btnPlay = document.getElementById("btn-play");
    const btnPause = document.getElementById("btn-pause");
    const btnStop = document.getElementById("btn-stop");
    
    const viewSelector = document.getElementById("view-selector");
    const trackSelector = document.getElementById("track-selector");
    const seekSlider = document.getElementById("seek-slider");
    const progressFill = document.getElementById("progress-fill");
    
    const zipFallbackWrapper = document.getElementById("zip-fallback");
    const zipUploadInput = document.getElementById("zip-upload");

    let isDraggingScrubber = false;
    let wasPlayingBeforeSeek = false;
    const library = new BachLibrary();

    renderer.drawPlaceholder("LOADING BACH.ZIP...");
    if(viewSelector) viewSelector.addEventListener("change", (e) => renderer.setView(e.target.value));

    const populateLibraryUI = () => {
        if(!trackSelector) return;
        trackSelector.innerHTML = '';
        if (Object.keys(library.tree).length === 0) {
            renderer.drawPlaceholder("ERROR: NO MIDI FILES IN ARCHIVE");
            return;
        }

        for (const [folder, files] of Object.entries(library.tree)) {
            const group = document.createElement("optgroup");
            group.label = folder.toUpperCase();
            files.forEach(path => {
                const option = document.createElement("option");
                option.value = path;
                option.textContent = path.split('/').pop().replace(/\.(mid|midi)$/i, '').replace(/_/g, ' ');
                group.appendChild(option);
            });
            trackSelector.appendChild(group);
        }
        trackSelector.disabled = false;
        if(btnPlay) btnPlay.disabled = false; 
        renderer.drawPlaceholder("READY. PRESS PLAY.");
    };

    try {
        await library.loadFromUrl("./bach.zip");
        populateLibraryUI();
    } catch (err) {
        console.warn("Fetch failed. Activating fallback UI.");
        renderer.drawPlaceholder("CORS ERROR: PLEASE UPLOAD BACH.ZIP MANUALLY");
        if(zipFallbackWrapper) zipFallbackWrapper.style.display = "flex";
        
        if(zipUploadInput) {
            zipUploadInput.addEventListener("change", async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                renderer.drawPlaceholder("PARSING ZIP...");
                try {
                    await library.loadFromFile(file);
                    zipFallbackWrapper.style.display = "none";
                    populateLibraryUI();
                } catch (parseErr) {
                    renderer.drawPlaceholder("ERROR PARSING ZIP FILE");
                }
            });
        }
    }

    if(btnPlay) {
        btnPlay.addEventListener("click", async () => {
            if (!trackSelector || !trackSelector.value) return;

            if (renderer.totalDuration === 0) {
                renderer.drawPlaceholder("PARSING MIDI...");
                const midiBuffer = library.getWork(trackSelector.value);
                if (midiBuffer) {
                    const { notes, totalDuration } = await audio.loadMidi(midiBuffer);
                    renderer.setMidiData(notes, totalDuration);
                    if(seekSlider) seekSlider.disabled = false;
                }
            }
            
            await audio.play(audio.pauseOffset);
            renderer.start(() => audio.getCurrentTime());

            btnPlay.disabled = true;
            if(btnPause) btnPause.disabled = false;
            if(btnStop) btnStop.disabled = false;
        });
    }

    if(btnPause) {
        btnPause.addEventListener("click", () => {
            audio.pause();
            renderer.stop();
            
            if(btnPlay) btnPlay.disabled = false;
            btnPause.disabled = true;
        });
    }

    if(btnStop) {
        btnStop.addEventListener("click", () => {
            audio.stop();
            renderer.stop();
            if(seekSlider) seekSlider.value = 0;
            if(progressFill) progressFill.style.width = "0%";
            renderer.drawFrame(0);
            
            if(btnPlay) btnPlay.disabled = false;
            if(btnPause) btnPause.disabled = true;
            btnStop.disabled = true;
        });
    }

    if(trackSelector) {
        trackSelector.addEventListener("change", () => {
            audio.stop();
            renderer.reset();
            if(seekSlider) {
                seekSlider.value = 0;
                seekSlider.disabled = true;
            }
            if(progressFill) progressFill.style.width = "0%";
            
            if(btnPlay) btnPlay.disabled = trackSelector.value === "";
            if(btnPause) btnPause.disabled = true;
            if(btnStop) btnStop.disabled = true;

            if(trackSelector.value !== "") {
                 renderer.drawPlaceholder("PRESS PLAY TO LOAD");
            }
        });
    }

    renderer.onProgress = (percent) => {
        if (!isDraggingScrubber && seekSlider && progressFill) {
            seekSlider.value = percent * 1000;
            progressFill.style.width = `${percent * 100}%`;
        }
    };

    if(seekSlider) {
        // שימוש ב-pointer events לזיהוי מושלם גם במובייל וגם בדסקטופ
        seekSlider.addEventListener("pointerdown", () => {
            isDraggingScrubber = true;
            wasPlayingBeforeSeek = audio.isPlaying;
            if (audio.isPlaying) audio.pause();
            renderer.stop();
        });

        seekSlider.addEventListener("input", (e) => {
            const percent = e.target.value / 1000;
            if(progressFill) progressFill.style.width = `${percent * 100}%`;
            const seekTime = percent * renderer.totalDuration;
            renderer.drawFrame(seekTime);
        });

        seekSlider.addEventListener("pointerup", async (e) => {
            isDraggingScrubber = false;
            const percent = e.target.value / 1000;
            const seekTime = percent * renderer.totalDuration;
            
            audio.pauseOffset = seekTime;
            
            if (wasPlayingBeforeSeek) {
                await audio.play(seekTime);
                renderer.start(() => audio.getCurrentTime());
                if(btnPlay) btnPlay.disabled = true;
                if(btnPause) btnPause.disabled = false;
                if(btnStop) btnStop.disabled = false;
            } else {
                renderer.drawFrame(seekTime);
            }
        });
    }
});