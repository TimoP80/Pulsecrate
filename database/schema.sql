PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  portable_root_id TEXT,
  content_hash TEXT,
  audio_fingerprint TEXT,
  file_size INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  duration_ms INTEGER,
  codec TEXT,
  bitrate INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  title TEXT,
  artist TEXT,
  album TEXT,
  genre TEXT,
  year INTEGER,
  label TEXT,
  catalog_number TEXT,
  isrc TEXT,
  composer TEXT,
  remix_artist TEXT,
  track_number INTEGER,
  disc_number INTEGER,
  comments TEXT,
  lyrics TEXT,
  bpm REAL,
  bpm_confidence REAL,
  musical_key TEXT,
  camelot_key TEXT,
  open_key TEXT,
  key_confidence REAL,
  replay_gain REAL,
  peak_db REAL,
  dynamic_range REAL,
  rating INTEGER DEFAULT 0,
  color_tag TEXT,
  mood TEXT,
  energy INTEGER,
  analysis_version TEXT,
  analyzed_at INTEGER,
  added_at INTEGER NOT NULL,
  missing_at INTEGER,
  user_metadata_json TEXT NOT NULL DEFAULT '{}',
  analysis_metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS watch_folders (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  portable_root_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER,
  scan_policy_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS artwork (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL,
  image_kind TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS waveform_cache (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  overview BLOB NOT NULL,
  high_resolution BLOB,
  spectrogram BLOB,
  energy_curve BLOB,
  generated_at INTEGER NOT NULL,
  renderer_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cue_points (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  label TEXT,
  color TEXT,
  kind TEXT NOT NULL DEFAULT 'cue'
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'crate',
  filter_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS track_search USING fts5(
  title,
  artist,
  album,
  genre,
  label,
  catalog_number,
  isrc,
  comments,
  file_path,
  content='tracks',
  content_rowid='rowid'
);

CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);
CREATE INDEX IF NOT EXISTS idx_tracks_key ON tracks(camelot_key);
CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
CREATE INDEX IF NOT EXISTS idx_tracks_rating ON tracks(rating);
CREATE INDEX IF NOT EXISTS idx_tracks_energy ON tracks(energy);
CREATE INDEX IF NOT EXISTS idx_tracks_hash ON tracks(content_hash);
CREATE INDEX IF NOT EXISTS idx_tracks_fingerprint ON tracks(audio_fingerprint);
CREATE INDEX IF NOT EXISTS idx_tracks_added ON tracks(added_at);
CREATE INDEX IF NOT EXISTS idx_tracks_missing ON tracks(missing_at);
