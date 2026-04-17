// Initialization and UI Binding
document.addEventListener("DOMContentLoaded", async () => {
    const canvas = document.getElementById("visualizer");
    const renderer = new CanvasRenderer(canvas);
    const audio = new AudioEngine();
    
    // UI Elements
    const btnPlay = document.getElementById("btn-play");
    const btnStop = document.getElementById("btn-stop");
    const viewSelector = document.getElementById("view-selector"); // <select> element

    // View Switching logic
    viewSelector.addEventListener("change", (e) => {
        renderer.setView(e.target.value);
    });

    // 1. Initialize Library and load file
    const library = new BachLibrary("./bach.zip");
    await library.loadLibrary();
    
    // Example: Fetch a specific Art of Fugue contrapunctus
    const midiBuffer = library.getWork("aof/contrapunctus_1.mid");
    if (midiBuffer) {
        const { notes, totalDuration } = await audio.loadMidi(midiBuffer);
        renderer.setMidiData(notes, totalDuration);
        
        btnPlay.addEventListener("click", () => {
            audio.play(notes);
            // Critical Sync Fix: We pass audio.getCurrentTime bounded to the Tone.js context
            renderer.start(() => audio.getCurrentTime()); 
        });

        btnStop.addEventListener("click", () => {
            audio.stop();
            renderer.stop();
            renderer.reset();
            renderer.drawPlaceholder("Playback Stopped");
        });
    }
});