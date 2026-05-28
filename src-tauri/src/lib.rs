use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanRequest {
    pub roots: Vec<String>,
    pub incremental: bool,
    pub watch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub job_id: Uuid,
    pub discovered_files: u64,
    pub queued_for_analysis: u64,
    pub removed_files: u64,
    pub duplicate_candidates: u64,
    pub total_bytes: u64,
    pub files: Vec<ScannedAudioFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedAudioFile {
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub file_size: u64,
    pub modified_unix_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub track_id: String,
    pub bpm: f32,
    pub bpm_confidence: f32,
    pub camelot_key: String,
    pub classical_key: String,
    pub open_key: String,
    pub key_confidence: f32,
    pub replay_gain: f32,
    pub peak_db: f32,
    pub duration_ms: Option<u64>,
    pub bitrate: Option<u64>,
    pub sample_rate: Option<u32>,
    pub codec: Option<String>,
    pub energy: Option<u8>,
    pub analysis_version: String,
    // Embedded tag fields — None when the tag is absent or the file has no tags
    pub tag_title: Option<String>,
    pub tag_artist: Option<String>,
    pub tag_album: Option<String>,
    pub tag_album_artist: Option<String>,
    pub tag_genre: Option<String>,
    pub tag_label: Option<String>,
    pub tag_catalog: Option<String>,
    pub tag_year: Option<u32>,
    pub tag_track_number: Option<u32>,
    pub tag_comment: Option<String>,
    pub tag_isrc: Option<String>,
    pub tag_bpm: Option<u32>,
}

#[tauri::command]
fn start_scan(request: ScanRequest) -> Result<ScanSummary, String> {
    scanner::validate_roots(&request.roots)?;
    let files = scanner::scan_roots(&request.roots)?;
    let total_bytes = files.iter().map(|file| file.file_size).sum();
    let duplicate_candidates = scanner::count_duplicate_candidates(&files);
    let discovered_files = files.len() as u64;

    Ok(ScanSummary {
        job_id: Uuid::new_v4(),
        discovered_files,
        queued_for_analysis: discovered_files,
        removed_files: 0,
        duplicate_candidates,
        total_bytes,
        files,
    })
}

#[tauri::command]
fn analyze_track(track_id: String, path: String) -> Result<AnalysisResult, String> {
    audio::validate_supported_format(&path)?;
    audio::analyze_with_ffmpeg(track_id, &path)
}

#[tauri::command]
fn export_playlist(format: String, playlist_id: Uuid) -> Result<String, String> {
    export::validate_format(&format)?;
    Ok(format!("queued export {playlist_id} as {format}"))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_scan,
            analyze_track,
            export_playlist
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Pulsecrate");
}

mod scanner {
    use super::{audio, PathBuf, ScannedAudioFile};
    use std::collections::HashMap;
    use std::fs;
    use std::time::UNIX_EPOCH;

    pub fn validate_roots(roots: &[String]) -> Result<(), String> {
        if roots.is_empty() {
            return Err("At least one scan root is required".to_string());
        }

        for root in roots {
            let path = PathBuf::from(root);
            if !path.exists() {
                return Err(format!("Scan root does not exist: {root}"));
            }
            if !path.is_dir() {
                return Err(format!("Scan root is not a folder: {root}"));
            }
        }

        Ok(())
    }

    pub fn scan_roots(roots: &[String]) -> Result<Vec<ScannedAudioFile>, String> {
        let mut files = Vec::new();

        for root in roots {
            scan_folder(PathBuf::from(root), &mut files)?;
        }

        Ok(files)
    }

    pub fn count_duplicate_candidates(files: &[ScannedAudioFile]) -> u64 {
        let mut names: HashMap<String, u64> = HashMap::new();
        for file in files {
            let normalized = file.file_name.to_ascii_lowercase();
            *names.entry(normalized).or_default() += 1;
        }

        names.values().filter(|count| **count > 1).sum()
    }

    fn scan_folder(folder: PathBuf, files: &mut Vec<ScannedAudioFile>) -> Result<(), String> {
        let entries = fs::read_dir(&folder)
            .map_err(|error| format!("Unable to read {}: {error}", folder.display()))?;

        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|error| error.to_string())?;

            if metadata.is_dir() {
                scan_folder(path, files)?;
                continue;
            }

            if !metadata.is_file() || !audio::is_supported_path(&path) {
                continue;
            }

            let modified_unix_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis());

            files.push(ScannedAudioFile {
                file_name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                extension: path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase(),
                file_size: metadata.len(),
                modified_unix_ms,
                path: path.display().to_string(),
            });
        }

        Ok(())
    }
}

mod audio {
    use super::AnalysisResult;
    use serde::Deserialize;
    use std::f32::consts::PI;
    use std::path::Path;
    use std::process::Command;

    // lofty covers every format in SUPPORTED_EXTENSIONS.
    // Add to Cargo.toml: lofty = { version = "0.21", features = ["aiff", "flac", "id3v2", "mp4_atoms", "ogg_opus", "ogg_vorbis", "wav"] }
    use lofty::prelude::*;
    use lofty::probe::Probe;
    use lofty::tag::ItemKey;

    pub const ANALYSIS_VERSION: &str = "pulsecrate-analysis-0.2";

    pub const SUPPORTED_EXTENSIONS: &[&str] = &[
        "mp3", "flac", "wav", "aiff", "aif", "ogg", "m4a", "aac", "opus", "wma", "alac",
    ];

    pub fn validate_supported_format(path: &str) -> Result<(), String> {
        let extension = path
            .rsplit('.')
            .next()
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| "Audio file has no extension".to_string())?;

        if SUPPORTED_EXTENSIONS.iter().any(|item| *item == extension) {
            Ok(())
        } else {
            Err(format!("Unsupported audio format: {extension}"))
        }
    }

    pub fn is_supported_path(path: &Path) -> bool {
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                let normalized = extension.to_ascii_lowercase();
                SUPPORTED_EXTENSIONS.iter().any(|item| *item == normalized)
            })
            .unwrap_or(false)
    }

    pub fn analyze_with_ffmpeg(track_id: String, path: &str) -> Result<AnalysisResult, String> {
        // Read embedded tags first — non-fatal, defaults to all-None.
        let tags = read_tags(path);

        let probe = probe_audio(path)?;
        let samples = decode_mono_samples(path)?;
        let bpm = estimate_bpm(&samples, 22_050);
        let key = estimate_key(&samples, 22_050);
        let peak_db = estimate_peak_db(&samples);
        let energy = estimate_energy(&samples);

        // If the tag carries a BPM and our signal estimate has low confidence,
        // prefer the tagged value but keep our own confidence score.
        let final_bpm = if bpm.confidence < 60.0 {
            tags.bpm.map(|b| b as f32).unwrap_or(bpm.value)
        } else {
            bpm.value
        };

        Ok(AnalysisResult {
            track_id,
            bpm: final_bpm,
            bpm_confidence: bpm.confidence,
            camelot_key: key.camelot.to_string(),
            classical_key: key.classical.to_string(),
            open_key: key.open.to_string(),
            key_confidence: key.confidence,
            replay_gain: 0.0,
            peak_db,
            duration_ms: probe.duration_ms,
            bitrate: probe.bitrate,
            sample_rate: probe.sample_rate,
            codec: probe.codec,
            energy: Some(energy),
            analysis_version: ANALYSIS_VERSION.to_string(),
            tag_title: tags.title,
            tag_artist: tags.artist,
            tag_album: tags.album,
            tag_album_artist: tags.album_artist,
            tag_genre: tags.genre,
            tag_label: tags.label,
            tag_catalog: tags.catalog,
            tag_year: tags.year,
            tag_track_number: tags.track_number,
            tag_comment: tags.comment,
            tag_isrc: tags.isrc,
            tag_bpm: tags.bpm,
        })
    }

    /// All tag fields are `Option` — a missing or unreadable tag is not an error.
    #[derive(Debug, Default)]
    struct TagMetadata {
        title: Option<String>,
        artist: Option<String>,
        album: Option<String>,
        album_artist: Option<String>,
        genre: Option<String>,
        label: Option<String>,
        catalog: Option<String>,
        year: Option<u32>,
        track_number: Option<u32>,
        comment: Option<String>,
        isrc: Option<String>,
        bpm: Option<u32>,
    }

    /// Read embedded tags from `path` using lofty.
    /// Returns `TagMetadata::default()` (all None) on any error so the caller
    /// can always proceed with signal-derived results.
    fn read_tags(path: &str) -> TagMetadata {
        let tagged_file = match Probe::open(path)
            .and_then(|p| p.guess_file_type())
            .and_then(|p| p.read())
        {
            Ok(f) => f,
            Err(_) => return TagMetadata::default(),
        };

        // lofty may expose multiple tag types (e.g. both ID3v1 and ID3v2 on
        // the same MP3). Prefer the primary tag, fall back to the first.
        let tag = match tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
            Some(t) => t,
            None => return TagMetadata::default(),
        };

        /// Grab the first non-empty string value for an ItemKey.
        fn get(tag: &lofty::tag::Tag, key: ItemKey) -> Option<String> {
            tag.get_string(&key)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
        }

        /// Parse a tag string to u32, ignoring anything after a '/' (e.g. "3/12").
        fn parse_u32(tag: &lofty::tag::Tag, key: ItemKey) -> Option<u32> {
            tag.get_string(&key)
                .and_then(|s| s.split('/').next())
                .and_then(|s| s.trim().parse::<u32>().ok())
        }

        // PUBLISHER / LABEL — stored differently per format:
        //   ID3v2: TPUB frame  → lofty ItemKey::Publisher
        //   Vorbis / FLAC: ORGANIZATION or LABEL comment → check both
        //   MP4: ©pub atom     → lofty ItemKey::Publisher
        let label = get(tag, ItemKey::Publisher)
            .or_else(|| get(tag, ItemKey::Unknown("ORGANIZATION".to_string())))
            .or_else(|| get(tag, ItemKey::Unknown("LABEL".to_string())));

        // CATALOG NUMBER — stored as TXXX:CATALOGNUMBER in ID3v2,
        // CATALOGNUMBER Vorbis comment, or a custom MP4 atom.
        // lofty exposes it via CatalogNumber.
        let catalog = get(tag, ItemKey::CatalogNumber);

        // ISRC — ID3v2 TSRC, Vorbis ISRC, MP4 isrc.
        let isrc = get(tag, ItemKey::Isrc);

        // Embedded BPM tag — ID3v2 TBPM, Vorbis BPM, MP4 tmpo.
        let bpm = parse_u32(tag, ItemKey::Bpm);

        TagMetadata {
            title: get(tag, ItemKey::TrackTitle),
            artist: get(tag, ItemKey::TrackArtist),
            album: get(tag, ItemKey::AlbumTitle),
            album_artist: get(tag, ItemKey::AlbumArtist),
            genre: get(tag, ItemKey::Genre),
            label,
            catalog,
            year: parse_u32(tag, ItemKey::Year)
                .or_else(|| parse_u32(tag, ItemKey::RecordingDate))
                .or_else(|| {
                    // Vorbis DATE comment and ID3v2 TDRC contain full dates like "2023-04-15"
                    tag.get_string(&ItemKey::RecordingDate)
                        .or_else(|| tag.get_string(&ItemKey::OriginalReleaseDate))
                        .and_then(|s| s.split('-').next())
                        .and_then(|y| y.trim().parse::<u32>().ok())
                }),
            track_number: parse_u32(tag, ItemKey::TrackNumber),
            comment: get(tag, ItemKey::Comment),
            isrc,
            bpm,
        }
    }

    #[derive(Debug, Default)]
    struct ProbeSummary {
        duration_ms: Option<u64>,
        bitrate: Option<u64>,
        sample_rate: Option<u32>,
        codec: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct FfprobeOutput {
        streams: Option<Vec<FfprobeStream>>,
        format: Option<FfprobeFormat>,
    }

    #[derive(Debug, Deserialize)]
    struct FfprobeStream {
        codec_type: Option<String>,
        codec_name: Option<String>,
        sample_rate: Option<String>,
        bit_rate: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct FfprobeFormat {
        duration: Option<String>,
        bit_rate: Option<String>,
    }

    #[derive(Debug)]
    struct BpmEstimate {
        value: f32,
        confidence: f32,
    }

    #[derive(Debug)]
    struct KeyEstimate {
        camelot: &'static str,
        classical: &'static str,
        open: &'static str,
        confidence: f32,
    }

    fn probe_audio(path: &str) -> Result<ProbeSummary, String> {
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                path,
            ])
            .output()
            .map_err(|error| format!("Unable to run ffprobe. Install FFmpeg and make sure ffprobe is on PATH. {error}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let parsed: FfprobeOutput =
            serde_json::from_slice(&output.stdout).map_err(|error| format!("Invalid ffprobe JSON: {error}"))?;
        let audio_stream = parsed
            .streams
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("audio"));

        let duration_ms = parsed
            .format
            .as_ref()
            .and_then(|format| format.duration.as_deref())
            .and_then(|duration| duration.parse::<f64>().ok())
            .map(|seconds| (seconds * 1000.0).round() as u64);

        let bitrate = audio_stream
            .and_then(|stream| stream.bit_rate.as_deref())
            .or_else(|| parsed.format.as_ref().and_then(|format| format.bit_rate.as_deref()))
            .and_then(|bitrate| bitrate.parse::<u64>().ok());

        let sample_rate = audio_stream
            .and_then(|stream| stream.sample_rate.as_deref())
            .and_then(|rate| rate.parse::<u32>().ok());

        Ok(ProbeSummary {
            duration_ms,
            bitrate,
            sample_rate,
            codec: audio_stream.and_then(|stream| stream.codec_name.clone()),
        })
    }

    fn decode_mono_samples(path: &str) -> Result<Vec<f32>, String> {
        let output = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-i",
                path,
                "-t",
                "240",   // 240 s gives ~2.65 M samples at 22 050 Hz — enough for
                         // ~645 key-estimation frames of 4096 without hitting the
                         // 1800-frame .take() limit on most tracks.
                "-ac",
                "1",
                "-ar",
                "22050",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .map_err(|error| format!("Unable to run ffmpeg. Install FFmpeg and make sure ffmpeg is on PATH. {error}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let samples = output
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .filter(|sample| sample.is_finite())
            .collect::<Vec<_>>();

        // Require at least ~2 seconds of audio for a meaningful analysis.
        let min_samples = 22_050 * 2;
        if samples.len() < min_samples {
            return Err(format!(
                "Only {} samples decoded (need ≥ {}); file may be corrupt, too short, or in an unsupported codec variant.",
                samples.len(),
                min_samples
            ));
        }

        Ok(samples)
    }

    fn estimate_bpm(samples: &[f32], sample_rate: usize) -> BpmEstimate {
        let hop = 512usize;
        let frame = 1024usize;
        let mut envelope = Vec::new();
        let mut previous_energy = 0.0_f32;

        for chunk_start in (0..samples.len().saturating_sub(frame)).step_by(hop) {
            // Use RMS energy instead of mean absolute value for better onset detection
            let energy = samples[chunk_start..chunk_start + frame]
                .iter()
                .map(|s| s * s)
                .sum::<f32>()
                / frame as f32;
            let flux = (energy - previous_energy).max(0.0);
            envelope.push(flux);
            previous_energy = energy;
        }

        normalize(&mut envelope);

        let frames_per_second = sample_rate as f32 / hop as f32;
        let mut best_bpm = 120.0_f32;
        let mut best_score = 0.0_f32;
        let mut second_score = 0.0_f32;

        // Score directly in the target range (90–190 BPM) to avoid the
        // normalization-after-selection bug where scores were compared on
        // un-normalized BPM values then doubled/halved post-hoc.
        for bpm in 90u32..=190 {
            let lag = ((60.0 / bpm as f32) * frames_per_second).round() as usize;
            if lag < 2 || lag >= envelope.len() {
                continue;
            }

            // Sum autocorrelation at the fundamental lag and its first two
            // harmonics (double and quadruple time) to handle half-time grooves.
            let score: f32 = [1usize, 2, 4]
                .iter()
                .filter_map(|&mult| {
                    let l = lag * mult;
                    if l < envelope.len() {
                        let n = (envelope.len() - l) as f32;
                        Some(
                            envelope[l..]
                                .iter()
                                .zip(envelope.iter())
                                .map(|(a, b)| a * b)
                                .sum::<f32>()
                                / n,
                        )
                    } else {
                        None
                    }
                })
                .sum();

            if score > best_score {
                second_score = best_score;
                best_score = score;
                best_bpm = bpm as f32;
            } else if score > second_score {
                second_score = score;
            }
        }

        let confidence = if best_score <= 0.0 {
            50.0
        } else {
            ((best_score - second_score) / best_score * 100.0).clamp(35.0, 98.0)
        };

        BpmEstimate {
            value: best_bpm,
            confidence,
        }
    }

    fn estimate_key(samples: &[f32], sample_rate: usize) -> KeyEstimate {
        let frame = 4096;
        let hop = 4096;
        let mut chroma = [0.0_f32; 12];

        for start in (0..samples.len().saturating_sub(frame)).step_by(hop).take(1800) {
            let slice = &samples[start..start + frame];
            for midi in 36..=84 {
                let frequency = 440.0 * 2_f32.powf((midi as f32 - 69.0) / 12.0);
                let magnitude = goertzel(slice, sample_rate as f32, frequency);
                chroma[(midi % 12) as usize] += magnitude;
            }
        }

        normalize_array(&mut chroma);

        let major_profile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
        let minor_profile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
        let mut best = (0, false, f32::MIN);
        let mut second = f32::MIN;

        for root in 0..12 {
            let major_score = correlation(&chroma, &rotate_profile(&major_profile, root));
            let minor_score = correlation(&chroma, &rotate_profile(&minor_profile, root));

            for (is_minor, score) in [(false, major_score), (true, minor_score)] {
                if score > best.2 {
                    second = best.2;
                    best = (root, is_minor, score);
                } else if score > second {
                    second = score;
                }
            }
        }

        let mapping = key_mapping(best.0, best.1);
        let confidence = ((best.2 - second).max(0.0) * 60.0 + 45.0).clamp(45.0, 96.0);

        KeyEstimate {
            camelot: mapping.0,
            classical: mapping.1,
            open: mapping.2,
            confidence,
        }
    }

    fn estimate_peak_db(samples: &[f32]) -> f32 {
        let peak = samples.iter().map(|sample| sample.abs()).fold(0.0_f32, f32::max);
        if peak <= 0.0 {
            -90.0
        } else {
            (20.0 * peak.log10()).clamp(-90.0, 6.0)
        }
    }

    fn estimate_energy(samples: &[f32]) -> u8 {
        // Compute RMS over the full decoded clip.
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        // Typical normalised dance-music RMS is roughly 0.05–0.25 (-26 to -12 dBFS).
        // Map that range linearly to 10–95 so quiet/loud tracks spread across the scale.
        // rms 0.0 → 1, rms 0.03 → ~10, rms 0.25 → ~95, rms ≥ 0.35 → 100.
        let scaled = (rms / 0.35 * 100.0).round().clamp(1.0, 100.0) as u8;
        scaled
    }

    fn normalize_array<const N: usize>(values: &mut [f32; N]) {
        let max = values.iter().copied().fold(0.0_f32, f32::max);
        if max > 0.0 {
            values.iter_mut().for_each(|value| *value /= max);
        }
    }

    fn normalize(values: &mut [f32]) {
        let max = values.iter().copied().fold(0.0_f32, f32::max);
        if max > 0.0 {
            values.iter_mut().for_each(|value| *value /= max);
        }
    }

    fn goertzel(samples: &[f32], sample_rate: f32, frequency: f32) -> f32 {
        let omega = 2.0 * PI * frequency / sample_rate;
        let coefficient = 2.0 * omega.cos();
        let mut q0;
        let mut q1 = 0.0;
        let mut q2 = 0.0;

        for sample in samples {
            q0 = coefficient * q1 - q2 + sample;
            q2 = q1;
            q1 = q0;
        }

        (q1 * q1 + q2 * q2 - coefficient * q1 * q2).sqrt()
    }

    fn rotate_profile(profile: &[f32; 12], root: usize) -> [f32; 12] {
        let mut rotated = [0.0; 12];
        for index in 0..12 {
            rotated[(index + root) % 12] = profile[index];
        }
        rotated
    }

    fn correlation(a: &[f32; 12], b: &[f32; 12]) -> f32 {
        a.iter().zip(b.iter()).map(|(left, right)| left * right).sum()
    }

    fn key_mapping(root: usize, minor: bool) -> (&'static str, &'static str, &'static str) {
        const MAJOR: [(&str, &str, &str); 12] = [
            ("8B", "C major", "1d"),
            ("3B", "D-flat major", "8d"),
            ("10B", "D major", "3d"),
            ("5B", "E-flat major", "10d"),
            ("12B", "E major", "5d"),
            ("7B", "F major", "12d"),
            ("2B", "F# major", "7d"),
            ("9B", "G major", "2d"),
            ("4B", "A-flat major", "9d"),
            ("11B", "A major", "4d"),
            ("6B", "B-flat major", "11d"),
            ("1B", "B major", "6d"),
        ];
        const MINOR: [(&str, &str, &str); 12] = [
            ("5A", "C minor", "10m"),
            ("12A", "D-flat minor", "5m"),
            ("7A", "D minor", "12m"),
            ("2A", "E-flat minor", "7m"),
            ("9A", "E minor", "2m"),
            ("4A", "F minor", "9m"),
            ("11A", "F# minor", "4m"),
            ("6A", "G minor", "11m"),
            ("1A", "A-flat minor", "6m"),
            ("8A", "A minor", "1m"),
            ("3A", "B-flat minor", "8m"),
            ("10A", "B minor", "3m"),
        ];

        if minor {
            MINOR[root]
        } else {
            MAJOR[root]
        }
    }
}

mod export {
    const SUPPORTED_EXPORTS: &[&str] = &[
        "m3u",
        "m3u8",
        "csv",
        "json",
        "xml",
        "rekordbox",
        "serato",
        "traktor",
        "virtualdj",
    ];

    pub fn validate_format(format: &str) -> Result<(), String> {
        if SUPPORTED_EXPORTS
            .iter()
            .any(|item| item.eq_ignore_ascii_case(format))
        {
            Ok(())
        } else {
            Err(format!("Unsupported export format: {format}"))
        }
    }
}
