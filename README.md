# Pulsecrate

Pulsecrate is a modern desktop music library scanner and organizer for DJs, producers, and electronic music collectors. It is shaped for massive electronic music collections, fast metadata indexing, BPM/key analysis, harmonic browsing, duplicate detection, and professional DJ export workflows.

The current repository is a production-oriented scaffold: a working React app surface, Tauri desktop shell, Rust command boundary, and SQLite schema for the high-volume library engine. It starts with an empty first-run library so you can test against your own music collection without seeded demo tracks.

## Product Direction

Pulsecrate is designed as a hybrid of Mixed In Key, Rekordbox, Serato DJ, Traktor Pro, MusicBrainz Picard, and foobar2000:

- Fast recursive scanning for 100,000+ tracks.
- Incremental rescans and watch folders.
- Rich tag editing for ID3v2, Vorbis comments, APE, RIFF INFO, and MP4 atoms.
- BPM, key, loudness, replay gain, waveform, spectrogram, and duplicate audio analysis.
- DJ workflow tools for harmonic matching, set prep, crates, cue points, and exports.
- Cross-platform desktop packaging through Tauri.

## Technology

- Frontend: React, TypeScript, Vite.
- Desktop shell: Tauri.
- Backend: Rust command layer with planned worker pools for scanning and analysis.
- Database: SQLite with WAL mode, FTS5 search, indexed filters, waveform cache tables, and playlist/crate tables.
- Planned audio stack: FFmpeg for probing/decoding, Symphonia or lofty for Rust-native metadata paths, Essentia/aubio integration for BPM and key, Chromaprint-style fingerprints for duplicate detection.

## Repository Layout

```text
.
├── database/schema.sql       SQLite schema for tracks, tags, waveforms, crates, FTS search
├── src/                      React desktop UI
├── src-tauri/                Tauri shell and Rust command boundary
├── package.json              Frontend and desktop scripts
└── vite.config.ts            Vite dev/build config
```

## Run

Install dependencies first:

```bash
npm install
```

Run the web preview:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run desktop:dev
```

Build the frontend:

```bash
npm run build
```

Build the desktop executable/installer:

```bash
npm run desktop:build
```

The packaged output is written under `src-tauri/target/release/bundle/`. On Windows, the raw executable is also built under `src-tauri/target/release/`.

## Implemented Surface

- Dark desktop collection UI.
- Massive-library metrics.
- Working search, genre, key, and BPM filter controls.
- Track table with BPM, key, energy, codec, and state columns.
- Clickable row selection wired to the inspector.
- Empty first-run state for clean testing against a real collection.
- Background analysis queue.
- Right-side track inspector with waveform preview, editable tags, harmonic matches, import/export actions, and AI suggestion area.
- Playlist/crate, duplicate manager, watch folder, harmonic match, queue, and database tool views.
- Responsive layout for narrow screens.
- SQLite schema with high-volume indexes and FTS search.
- Tauri commands for recursive scan start, track analysis, and playlist export.
- Recursive Rust folder scanning for supported audio extensions.
- **Work in Progress**: Audio tag reading (ID3, Vorbis, etc.) via lofty crate - basic implementation present but not yet fully integrated into UI workflow.

## Backend Roadmap

1. Scanner engine
    - Recursive folder walk with ignore rules.
    - Incremental scanning from file size, mtime, and content hash.
    - Portable root mapping for external drives.
    - Watch-folder event ingestion.
    - Crash-resumable job state.

2. Metadata engine **[WORK IN PROGRESS]**
    - Read/write tags across MP3, FLAC, WAV, AIFF, OGG, M4A/AAC, OPUS, WMA, and ALAC.
    - Batch editor and filename parser/generator.
    - Artwork read/write with multiple embedded images.
    - Tag consistency validation.
    - **Current Status**: Basic tag reading via lofty crate implemented in Rust backend and frontend types, but not yet fully integrated into analysis pipeline and UI workflow.

3. Analysis engine
    - FFmpeg-backed decode pipeline.
    - BPM estimation with transient detection, spectral flux, autocorrelation, and genre-aware correction.
    - Musical key estimation with chroma/HPCP profiles, Camelot/Open Key/classical mappings, confidence scoring, and key-change hints.
    - Loudness, ReplayGain, peak/RMS, dynamic range, intro/outro, breakdown/drop markers, waveform and spectrogram caches.

4. DJ workflow
    - Harmonic compatibility scoring.
    - BPM compatibility matching.
    - Cue point editor.
    - Smart playlists and crates.
    - Rekordbox, Serato, Traktor, VirtualDJ, M3U, CSV, JSON, and XML imports/exports.

5. Advanced systems
    - Audio fingerprint duplicate detection despite renamed files.
    - Corrupt file detection.
    - REST API and scripting hooks.
    - Optional AI classifiers for genre, mood, vocal/instrumental, energy, and mix recommendations.

## Database Notes

The schema uses:

- `tracks` as the main library record.
- `track_search` as an FTS5 index for instant search.
- `waveform_cache` for overview, high-resolution waveform, and spectrogram blobs.
- `cue_points` for hot cues, memory cues, loops, drops, and custom markers.
- `playlists` and `playlist_tracks` for crates, saved filters, and set preparation.
- Hash and fingerprint indexes for exact and audio-level duplicate detection.

SQLite is the default because it is fast, local, portable, easy to back up, and suitable for very large personal libraries when indexed carefully. PostgreSQL can be added later for network sharing and multi-user deployments.
