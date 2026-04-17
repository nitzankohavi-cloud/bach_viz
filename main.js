// ═══ Audio Engine ══════════════════════════════════════════════════════════════
class AudioEngine {
    constructor() {
        this.sampler = new Tone.Sampler({
            urls: {
                A0:"A0.mp3", C1:"C1.mp3", "D#1":"Ds1.mp3", "F#1":"Fs1.mp3",
                A1:"A1.mp3", C2:"C2.mp3", "D#2":"Ds2.mp3", "F#2":"Fs2.mp3",
                A2:"A2.mp3", C3:"C3.mp3", "D#3":"Ds3.mp3", "F#3":"Fs3.mp3",
                A3:"A3.mp3", C4:"C4.mp3", "D#4":"Ds4.mp3", "F#4":"Fs4.mp3",
                A4:"A4.mp3", C5:"C5.mp3", "D#5":"Ds5.mp3", "F#5":"Fs5.mp3",
                A5:"A5.mp3", C6:"C6.mp3", "D#6":"Ds6.mp3", "F#6":"Fs6.mp3",
                A6:"A6.mp3", C7:"C7.mp3"
            },
            baseUrl: "https://tonejs.github.io/audio/salamander/",
            release: 0.6 // הוקטן מ-1.2 לטובת ארטיקולציה ברורה יותר
        }).toDestination();
        this.sampler.volume.value = -3;
        this.notes = []; this.isPlaying = false; this.pauseOffset = 0;
        this.scheduledIds = []; this.tempo = 80;
        this.introTimeoutId = null;
        
        // שליטה על דינמיקה (0 = פלאט/עוגב, 1 = אקספרסיביות מלאה מה-MIDI)
        this.dynamicsAmount = 0.4; 
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
                
                // נרמול עוצמה משולב עם שליטת דינמיקה
                const adjustedVelocity = 0.5 + (n.velocity - 0.5) * this.dynamicsAmount;
                
                const id = Tone.Transport.schedule(t => {
                    this.sampler.triggerAttackRelease(
                        Tone.Frequency(n.midi, "midi").toNote(),
                        Math.max(n.duration, 0.05), t, adjustedVelocity
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
