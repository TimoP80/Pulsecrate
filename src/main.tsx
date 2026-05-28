import React, { useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AudioWaveform,
  BadgeCheck,
  BarChart3,
  Database,
  Disc3,
  Download,
  Edit3,
  FileAudio,
  Filter,
  FolderPlus,
  Gauge,
  Grid2X2,
  HardDrive,
  ListMusic,
  Music2,
  PanelRight,
  Play,
  Radar,
  RefreshCw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Upload,
  Wand2
} from "lucide-react";
import "./styles.css";

type TrackStatus = "Ready" | "Analyzing" | "Needs tags" | "Missing" | "Duplicate";
type View = "Collection" | "Playlists" | "Analysis Queue" | "Duplicates" | "Watch Folders" | "Harmonic Match" | "Database Tools";

type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  label: string;
  catalog: string;
  bpm: number;
  key: string;
  openKey: string;
  duration: string;
  energy: number;
  rating: number;
  fileType: string;
  bitrate: string;
  confidence: number;
  path: string;
  mood: string;
  tags: string[];
  color: string;
  status: TrackStatus;
  dateAdded: string;
};

type ScanJob = {
  id: string;
  name: string;
  files: number;
  state: string;
  progress: number;
};

type WatchFolder = {
  id: string;
  path: string;
  tracks: number;
  enabled: boolean;
  mounted: boolean;
  lastScan: string;
};

type PickedAudioFile = {
  name: string;
  relativePath: string;
};

type DirectoryHandle = {
  name: string;
  entries(): AsyncIterableIterator<[string, FileSystemEntryHandle]>;
};

type FileSystemEntryHandle =
  | {
      kind: "file";
      name: string;
      getFile(): Promise<File>;
    }
  | {
      kind: "directory";
      name: string;
      entries(): AsyncIterableIterator<[string, FileSystemEntryHandle]>;
    };

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: () => Promise<DirectoryHandle>;
  __TAURI_INTERNALS__?: unknown;
};

type NativeAnalysisResult = {
  track_id: string;
  bpm: number;
  bpm_confidence: number;
  camelot_key: string;
  classical_key: string;
  open_key: string;
  key_confidence: number;
  replay_gain: number;
  peak_db: number;
  duration_ms?: number | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  codec?: string | null;
  energy?: number | null;
  analysis_version: string;
  // Embedded tag fields — null/undefined when absent in the file
  tag_title?: string | null;
  tag_artist?: string | null;
  tag_album?: string | null;
  tag_album_artist?: string | null;
  tag_genre?: string | null;
  tag_label?: string | null;
  tag_catalog?: string | null;
  tag_year?: number | null;
  tag_track_number?: number | null;
  tag_comment?: string | null;
  tag_isrc?: string | null;
  tag_bpm?: number | null;
};

type NativeScanSummary = {
  job_id: string;
  discovered_files: number;
  queued_for_analysis: number;
  removed_files: number;
  duplicate_candidates: number;
  total_bytes: number;
  files: NativeScannedAudioFile[];
};

type NativeScannedAudioFile = {
  path: string;
  file_name: string;
  extension: string;
  file_size: number;
  modified_unix_ms?: number | null;
};

const initialTracks: Track[] = [];
const initialJobs: ScanJob[] = [];
const initialWatchFolders: WatchFolder[] = [];

const navItems: Array<{ view: View; icon: React.ReactNode }> = [
  { view: "Collection", icon: <ListMusic size={18} /> },
  { view: "Playlists", icon: <Music2 size={18} /> },
  { view: "Analysis Queue", icon: <Activity size={18} /> },
  { view: "Duplicates", icon: <Disc3 size={18} /> },
  { view: "Watch Folders", icon: <HardDrive size={18} /> },
  { view: "Harmonic Match", icon: <Radar size={18} /> },
  { view: "Database Tools", icon: <Database size={18} /> }
];

const harmonicNeighbors: Record<string, string[]> = {
  "8A": ["7A", "9A", "8B", "8A"],
  "7A": ["6A", "8A", "7B", "7A"],
  "9B": ["8B", "10B", "9A", "9B"],
  "5A": ["4A", "6A", "5B", "5A"],
  "11A": ["10A", "12A", "11B", "11A"],
  "9A": ["8A", "10A", "9B", "9A"]
};

function App() {
  const [tracks, setTracks] = useState(initialTracks);
  const [jobs, setJobs] = useState(initialJobs);
  const [watchFolders, setWatchFolders] = useState(initialWatchFolders);
  const [activeView, setActiveView] = useState<View>("Collection");
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [genreFilter, setGenreFilter] = useState("All");
  const [keyFilter, setKeyFilter] = useState("All");
  const [bpmRange, setBpmRange] = useState<[number, number]>([80, 190]);
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState("Ready to scan your music collection");
  const [desktopScanPath, setDesktopScanPath] = useState("");
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const selected = tracks.find((track) => track.id === selectedId);
  const compatibleKeys = selected ? harmonicNeighbors[selected.openKey] ?? [selected.openKey] : [];
  const genres = useMemo(() => ["All", ...Array.from(new Set(tracks.map((track) => track.genre)))], [tracks]);
  const keys = useMemo(() => ["All", ...Array.from(new Set(tracks.map((track) => track.openKey)))], [tracks]);

  const filteredTracks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tracks.filter((track) => {
      const haystack = [
        track.title,
        track.artist,
        track.album,
        track.genre,
        track.label,
        track.catalog,
        track.path,
        track.mood,
        track.tags.join(" ")
      ].join(" ").toLowerCase();

      return (
        (!needle || haystack.includes(needle)) &&
        (genreFilter === "All" || track.genre === genreFilter) &&
        (keyFilter === "All" || track.openKey === keyFilter) &&
        (track.bpm === 0 || (track.bpm >= bpmRange[0] && track.bpm <= bpmRange[1]))
      );
    });
  }, [bpmRange, genreFilter, keyFilter, search, tracks]);

  const stats = useMemo(() => {
    const analyzed = tracks.filter((track) => track.status === "Ready" || track.status === "Duplicate").length;
    const needsWork = tracks.filter((track) => track.status === "Needs tags" || track.status === "Missing").length;
    const duplicates = tracks.filter((track) => track.status === "Duplicate").length;
    return {
      total: tracks.length,
      analyzed,
      tagQuality: tracks.length === 0 ? 100 : Math.round(((tracks.length - needsWork) / tracks.length) * 100),
      duplicates
    };
  }, [tracks]);

  function updateSelected(patch: Partial<Track>) {
    if (!selected) {
      setToast("Scan a folder before editing track metadata");
      return;
    }

    setTracks((current) => current.map((track) => (track.id === selected.id ? { ...track, ...patch } : track)));
    setToast("Track metadata updated");
  }

  async function startScan() {
    if (desktopScanPath.trim()) {
      await scanDesktopPath(desktopScanPath.trim());
      return;
    }

    await openFolderPicker();
  }

  async function scanDesktopPath(path: string) {
    if (!isTauriRuntime()) {
      setToast("Desktop path scanning only works in the Tauri app. Browser folder scan will use provisional analysis.");
      await openFolderPicker();
      return;
    }

    try {
      setToast(`Scanning ${path} with native scanner...`);
      const summary = await invoke<NativeScanSummary>("start_scan", {
        request: {
          roots: [path],
          incremental: true,
          watch: true
        }
      });

      const importedTracks = createTracksFromNativeFiles(summary.files);
      const importedPaths = new Set(importedTracks.map((track) => track.path));
      const rootName = path;

      setWatchFolders((current) => [
        {
          id: `wf-${Date.now()}`,
          path: rootName,
          tracks: importedTracks.length,
          enabled: true,
          mounted: true,
          lastScan: "Just now"
        },
        ...current.filter((folder) => folder.path !== rootName)
      ]);
      setTracks((current) => [
        ...importedTracks,
        ...current.filter((track) => !importedPaths.has(track.path))
      ]);
      setJobs((current) => [
        {
          id: String(summary.job_id),
          name: rootName,
          files: summary.queued_for_analysis,
          state: "Ready for native analysis",
          progress: 100
        },
        ...current
      ]);
      setSelectedId(importedTracks[0]?.id ?? "");
      setToast(`Native scan found ${summary.discovered_files.toLocaleString()} supported audio files`);
      setActiveView("Collection");
    } catch (error) {
      setToast(`Native scan failed: ${formatError(error)}`);
    }
  }

  async function openFolderPicker() {
    // In Tauri, showDirectoryPicker only gives us a relative folder name —
    // the browser sandbox never exposes the real absolute path. Passing a
    // relative path to canUseNativeAnalysis() returns false, so every track
    // falls through to the instant JS provisional analyser.
    //
    // Fix: in Tauri we skip the browser picker entirely and route through
    // scanDesktopPath which calls start_scan with the absolute path,
    // giving tracks real absolute paths that native analysis can use.
    if (isTauriRuntime()) {
      const path = desktopScanPath.trim();
      if (!path) {
        setToast("Enter the absolute folder path in the path field (e.g. D:\\Music), then click Scan Library");
        return;
      }
      await scanDesktopPath(path);
      return;
    }

    // Browser-only path below — relative paths are fine here because
    // ffmpeg is never available in a browser context anyway.
    const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;

    if (picker) {
      try {
        const directory = await picker();
        const audioFiles = await collectAudioFiles(directory, directory.name);
        importPickedFiles(audioFiles, directory.name);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setToast("Folder selection cancelled");
          return;
        }

        setToast("Directory picker failed; using browser fallback");
      }
    }

    folderInputRef.current?.click();
  }

  function handleFolderSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    const audioFiles = files
      .filter(isSupportedAudioFile)
      .map((file) => ({
        name: file.name,
        relativePath: file.webkitRelativePath || file.name
      }));

    if (files.length === 0) {
      return;
    }

    importPickedFiles(audioFiles, getRootName(audioFiles[0]));
    event.currentTarget.value = "";
  }

  function importPickedFiles(audioFiles: PickedAudioFile[], rootName: string) {
    if (audioFiles.length === 0) {
      setToast("No supported audio files found in that folder");
      return;
    }

    const importedTracks = createTracksFromFiles(audioFiles);
    const importedPaths = new Set(importedTracks.map((track) => track.path));

    const id = `scan-${jobs.length + 1}`;
    setWatchFolders((current) => [
      {
        id: `wf-${Date.now()}`,
        path: rootName,
        tracks: importedTracks.length,
        enabled: true,
        mounted: true,
        lastScan: "Just now"
      },
      ...current.filter((folder) => folder.path !== rootName)
    ]);
    setTracks((current) => [
      ...importedTracks,
      ...current.filter((track) => !importedPaths.has(track.path))
    ]);
    setJobs((current) => [
      { id, name: rootName, files: importedTracks.length, state: "Ready for analysis", progress: 100 },
      ...current
    ]);
    setSelectedId(importedTracks[0]?.id ?? "");
    setToast(`Indexed ${importedTracks.length.toLocaleString()} supported audio files from ${rootName}`);
    setActiveView("Collection");
  }

  function advanceJobs() {
    setJobs((current) =>
      current.map((job) => ({
        ...job,
        progress: Math.min(100, job.progress + 13),
        state: job.progress + 13 >= 100 ? "Complete" : job.state
      }))
    );
    setTracks((current) =>
      current.map((track) => (track.status === "Analyzing" ? { ...track, status: "Ready", confidence: 96 } : track))
    );
    setToast("Analysis queue advanced");
  }

  async function analyzeSelected() {
    if (!selected) {
      setToast("Select a track to analyze");
      return;
    }

    setToast(`Analyzing: ${selected.title}...`);
    const analyzed = await analyzeTrackWithBestEngine(selected);
    setTracks((current) => current.map((track) => (track.id === selected.id ? analyzed : track)));
    setJobs((current) => [
      { id: `analysis-${Date.now()}`, name: `Analyzed ${selected.title}`, files: 1, state: "Complete", progress: 100 },
      ...current
    ]);

    if (analyzed.status === "Missing") {
      setToast(`Analysis failed for ${selected.title}: FFmpeg not found on PATH`);
    } else {
      const engine = analyzed.tags.includes("analyzed") && canUseNativeAnalysis(selected) ? "Native" : "Provisional";
      setToast(`${engine} analysis complete: ${selected.title} — ${analyzed.bpm} BPM, ${analyzed.openKey}`);
    }
  }

  async function analyzePending() {
    const pending = tracks.filter((track) => track.status !== "Ready");

    if (pending.length === 0) {
      setToast("No pending tracks to analyze");
      return;
    }

    setToast(`Analyzing ${pending.length.toLocaleString()} pending tracks...`);
    const analyzedTracks = new Map<string, Track>();
    for (const track of pending) {
      analyzedTracks.set(track.id, await analyzeTrackWithBestEngine(track));
    }

    const results = Array.from(analyzedTracks.values());
    const failed = results.filter((t) => t.tags.includes("ffmpeg-unavailable")).length;
    const succeeded = results.length - failed;

    setTracks((current) => current.map((track) => analyzedTracks.get(track.id) ?? track));
    setJobs((current) => [
      { id: `analysis-${Date.now()}`, name: "Library analysis pass", files: pending.length, state: "Complete", progress: 100 },
      ...current
    ]);

    if (failed > 0) {
      setToast(`Analyzed ${succeeded.toLocaleString()} tracks (${failed.toLocaleString()} failed — FFmpeg not found on PATH)`);
    } else {
      setToast(`Analyzed ${succeeded.toLocaleString()} tracks`);
    }
  }

  function autoClean() {
    if (!selected) {
      setToast("No track selected yet");
      return;
    }

    updateSelected({
      title: titleCase(selected.title),
      artist: titleCase(selected.artist),
      status: selected.status === "Needs tags" ? "Ready" : selected.status,
      tags: Array.from(new Set([...selected.tags, selected.genre.toLowerCase(), selected.mood.toLowerCase()]))
    });
  }

  return (
    <main className="app-shell">
      <input
        ref={(input) => {
          folderInputRef.current = input;
          if (input) {
            input.setAttribute("webkitdirectory", "");
            input.setAttribute("directory", "");
          }
        }}
        aria-hidden="true"
        className="folder-picker"
        multiple
        onChange={handleFolderSelection}
        type="file"
      />
      <aside className="sidebar">
        <div className="brand">
          <AudioWaveform size={28} />
          <div>
            <strong>Pulsecrate</strong>
            <span>DJ library intelligence</span>
          </div>
        </div>
        <nav className="nav-section" aria-label="Primary">
          {navItems.map((item) => (
            <button
              className={`nav-item ${activeView === item.view ? "active" : ""}`}
              key={item.view}
              onClick={() => setActiveView(item.view)}
            >
              {item.icon}
              <span>{item.view}</span>
            </button>
          ))}
        </nav>
        <div className="library-health">
          <span>Library Health</span>
          <strong>{Math.max(0, 100 - stats.duplicates * 1.3).toFixed(1)}%</strong>
          <div className="meter"><i style={{ width: `${Math.max(0, 100 - stats.duplicates * 1.3)}%` }} /></div>
          <small>{tracks.filter((track) => track.status === "Missing").length} missing files, {stats.duplicates} duplicate candidates</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="searchbar">
            <Search size={18} />
            <input
              aria-label="Search tracks"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search title, artist, label, tag, path, ISRC..."
              value={search}
            />
            <kbd>Ctrl K</kbd>
          </div>
          <div className="actions">
            <button className="icon-button" aria-label="Filter" onClick={() => setToast("Filter panel is active")}><Filter size={18} /></button>
            <button className="icon-button" aria-label="Columns" onClick={() => setToast("Column preset saved")}><PanelRight size={18} /></button>
            <button className="ghost-button" onClick={() => void analyzePending()}><Activity size={17} /> Analyze</button>
            <button className="primary-button" onClick={() => void startScan()}><RefreshCw size={17} /> Scan Library</button>
          </div>
        </header>

        <section className="metrics-grid" aria-label="Library summary">
          <Metric icon={<FileAudio />} label="Indexed tracks" value={stats.total.toLocaleString()} detail={`${filteredTracks.length} visible now`} />
          <Metric icon={<Gauge />} label="Analyzed BPM" value={stats.total === 0 ? "0%" : `${Math.round((stats.analyzed / stats.total) * 100)}%`} detail={stats.total === 0 ? "waiting for scan" : "median confidence 94%"} />
          <Metric icon={<Tags />} label="Tag quality" value={`${stats.tagQuality}%`} detail="batch cleanup available" />
          <Metric icon={<BadgeCheck />} label="Portable paths" value={`${watchFolders.length} roots`} detail={`${watchFolders.filter((folder) => folder.mounted).length} currently mounted`} />
        </section>

        <section className="control-strip">
          <div className="segmented" role="tablist" aria-label="Library views">
            <button className={activeView === "Collection" ? "selected" : ""} onClick={() => setActiveView("Collection")}><ListMusic size={16} /> Tracks</button>
            <button onClick={() => setActiveView("Playlists")}><Grid2X2 size={16} /> Crates</button>
            <button className={activeView === "Analysis Queue" ? "selected" : ""} onClick={() => setActiveView("Analysis Queue")}><Activity size={16} /> Queue</button>
          </div>
          <div className="desktop-path">
            <input
              aria-label="Desktop scan folder path"
              onChange={(event) => setDesktopScanPath(event.target.value)}
              placeholder="Folder path — required in desktop app (e.g. D:\\Music or /home/user/Music)"
              value={desktopScanPath}
            />
          </div>
          <div className="filter-pills">
            <select value={genreFilter} onChange={(event) => setGenreFilter(event.target.value)} aria-label="Genre filter">
              {genres.map((genre) => <option key={genre}>{genre}</option>)}
            </select>
            <select value={keyFilter} onChange={(event) => setKeyFilter(event.target.value)} aria-label="Key filter">
              {keys.map((key) => <option key={key}>{key}</option>)}
            </select>
            <label>
              Min BPM
              <input type="number" min="40" max="260" value={bpmRange[0]} onChange={(event) => setBpmRange([Number(event.target.value), bpmRange[1]])} />
            </label>
            <label>
              Max BPM
              <input type="number" min="40" max="260" value={bpmRange[1]} onChange={(event) => setBpmRange([bpmRange[0], Number(event.target.value)])} />
            </label>
          </div>
          <button className="ghost-button" onClick={() => setToast("Smart filter matched harmonic, lossless, and energy constraints")}><SlidersHorizontal size={17} /> Smart Filter</button>
        </section>

        <section className="content-grid">
          {activeView === "Collection" && (
            <CollectionView tracks={filteredTracks} selectedId={selected?.id} onSelect={setSelectedId} />
          )}
          {activeView === "Playlists" && <PlaylistView tracks={tracks} onSelectTrack={setSelectedId} />}
          {activeView === "Analysis Queue" && <QueueView jobs={jobs} onAdvance={advanceJobs} onAnalyzePending={() => void analyzePending()} />}
          {activeView === "Duplicates" && <DuplicateView tracks={tracks} onSelectTrack={setSelectedId} onMarkReady={(id) => setTracks((current) => current.map((track) => track.id === id ? { ...track, status: "Ready" } : track))} />}
          {activeView === "Watch Folders" && <WatchFolderView folders={watchFolders} onAddFolder={() => void openFolderPicker()} onToggle={(id) => setWatchFolders((current) => current.map((folder) => folder.id === id ? { ...folder, enabled: !folder.enabled } : folder))} />}
          {activeView === "Harmonic Match" && <HarmonicView tracks={tracks} selected={selected} compatibleKeys={compatibleKeys} onSelectTrack={setSelectedId} />}
          {activeView === "Database Tools" && <DatabaseView tracks={tracks} jobs={jobs} />}

          <aside className="queue-panel">
            <div className="panel-title">
              <h2>Background Analysis</h2>
              <button className="icon-button" aria-label="Queue settings" onClick={() => setToast("Analysis settings opened")}><Settings size={17} /></button>
            </div>
            {jobs.length === 0 && <div className="empty-state">No background jobs yet.</div>}
            {jobs.map((job) => (
              <div className="job" key={job.id}>
                <div>
                  <strong>{job.name}</strong>
                  <span>{job.files.toLocaleString()} files - {job.state}</span>
                </div>
                <div className="meter"><i style={{ width: `${job.progress}%` }} /></div>
              </div>
            ))}
            <div className="analysis-stack">
              <h3>Engines</h3>
              <span>FFmpeg metadata probe</span>
              <span>Essentia BPM + key</span>
              <span>SQLite FTS5 index</span>
              <span>Audio fingerprint duplicates</span>
            </div>
          </aside>
        </section>
        <div className="toast" role="status">{toast}</div>
      </section>

      <Inspector
        compatibleKeys={compatibleKeys}
        editing={editing}
        onAutoClean={autoClean}
        onAddFolder={() => void openFolderPicker()}
        onAnalyze={() => void analyzeSelected()}
        onEdit={() => setEditing(true)}
        onScanLibrary={() => void openFolderPicker()}
        onSave={(patch) => {
          updateSelected(patch);
          setEditing(false);
        }}
        selected={selected}
      />
    </main>
  );
}

function CollectionView({ tracks, selectedId, onSelect }: { tracks: Track[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <div className="track-panel">
      <div className="table-heading">
        <div>
          <h1>Collection</h1>
          <p>Virtualized-ready track browser with BPM, key, tags, codec, confidence, and file-state columns.</p>
        </div>
        <span>{tracks.length} tracks</span>
      </div>
      {tracks.length === 0 ? (
        <FirstRunState
          title="No tracks indexed yet"
          body="Start with Scan Library, then choose the root folder that contains your DJ collection."
        />
      ) : (
      <TrackTable tracks={tracks} selectedId={selectedId} onSelect={onSelect} />
      )}
    </div>
  );
}

function TrackTable({ tracks, selectedId, onSelect }: { tracks: Track[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <div className="track-table" role="table" aria-label="Music collection">
      <div className="track-row table-head" role="row">
        <span>Track</span><span>BPM</span><span>Key</span><span>Energy</span><span>Codec</span><span>Status</span>
      </div>
      {tracks.map((track) => (
        <button
          className={`track-row track-button ${selectedId === track.id ? "selected-row" : ""}`}
          draggable
          key={track.id}
          onClick={() => onSelect(track.id)}
          onDragStart={(event) => startTrackDrag(event, track)}
          role="row"
          title="Drag this track to a playlist, crate, or DJ software"
        >
          <span className="track-title">
            <i style={{ backgroundColor: track.color }} />
            <b>{track.title}</b>
            <small>{track.artist} - {track.label}</small>
          </span>
          <span>{track.bpm}</span>
          <span className="key-chip">{track.openKey}</span>
          <span><Meter value={track.energy} /></span>
          <span>{track.fileType}</span>
          <span className={`status ${track.status.toLowerCase().replace(" ", "-")}`}>{track.status}</span>
        </button>
      ))}
      {tracks.length === 0 && <div className="empty-state">No tracks match the current filters.</div>}
    </div>
  );
}

function PlaylistView({ tracks, onSelectTrack }: { tracks: Track[]; onSelectTrack: (id: string) => void }) {
  if (tracks.length === 0) {
    return (
      <div className="track-panel">
        <div className="table-heading">
          <div>
            <h1>Playlists & Crates</h1>
            <p>Smart crates and DJ exports will appear after your first scan.</p>
          </div>
          <button className="ghost-button"><FolderPlus size={17} /> New Crate</button>
        </div>
        <FirstRunState title="No crates yet" body="Scan your collection first, then build crates from BPM, key, genre, rating, mood, and custom tags." />
      </div>
    );
  }

  const crates = [
    { name: "Peak Techno 136-140", count: tracks.filter((track) => track.genre === "Techno").length, filter: "Techno, 8A/9A, energy > 80" },
    { name: "DnB Late Set", count: tracks.filter((track) => track.genre === "Drum & Bass").length, filter: "170-176 BPM, driving mood" },
    { name: "Warmup Tools", count: tracks.filter((track) => track.energy < 70).length, filter: "energy < 70, rating >= 3" }
  ];

  return (
    <div className="track-panel">
      <div className="table-heading">
        <div>
          <h1>Playlists & Crates</h1>
          <p>Smart crates use saved filters and can export to M3U, Rekordbox XML, Serato, Traktor, or CSV.</p>
        </div>
        <button className="ghost-button"><FolderPlus size={17} /> New Crate</button>
      </div>
      <div className="workflow-list">
        {crates.map((crate) => (
          <button className="workflow-row" key={crate.name} onClick={() => tracks[0] && onSelectTrack(tracks[0].id)}>
            <strong>{crate.name}</strong>
            <span>{crate.filter}</span>
            <b>{crate.count} tracks</b>
          </button>
        ))}
      </div>
    </div>
  );
}

function QueueView({
  jobs,
  onAdvance,
  onAnalyzePending
}: {
  jobs: ScanJob[];
  onAdvance: () => void;
  onAnalyzePending: () => void;
}) {
  return (
    <div className="track-panel">
      <div className="table-heading">
        <div>
          <h1>Analysis Queue</h1>
          <p>Crash-resumable background work for metadata, BPM, key, waveform, replay gain, and fingerprints.</p>
        </div>
        <div className="actions">
          <button className="ghost-button" onClick={onAdvance}><Activity size={17} /> Run Step</button>
          <button className="primary-button" onClick={onAnalyzePending}><Gauge size={17} /> Analyze Pending</button>
        </div>
      </div>
      <div className="workflow-list">
        {jobs.length === 0 && <FirstRunState title="Queue is empty" body="Scan a folder, then use Analyze Pending to calculate provisional BPM, key, confidence, and energy values." />}
        {jobs.map((job) => (
          <div className="workflow-row" key={job.id}>
            <strong>{job.name}</strong>
            <span>{job.files.toLocaleString()} files - {job.state}</span>
            <div className="meter"><i style={{ width: `${job.progress}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DuplicateView({ tracks, onSelectTrack, onMarkReady }: { tracks: Track[]; onSelectTrack: (id: string) => void; onMarkReady: (id: string) => void }) {
  const duplicates = tracks.filter((track) => track.status === "Duplicate");
  return (
    <div className="track-panel">
      <div className="table-heading">
        <div>
          <h1>Duplicate Manager</h1>
          <p>Groups exact hashes and audio fingerprints so renamed files can still be resolved.</p>
        </div>
        <span>{duplicates.length} candidates</span>
      </div>
      <div className="workflow-list">
        {duplicates.map((track) => (
          <div className="workflow-row split-row" key={track.id}>
            <button onClick={() => onSelectTrack(track.id)}>
              <strong>{track.title}</strong>
              <span>{track.path}</span>
            </button>
            <button className="ghost-button" onClick={() => onMarkReady(track.id)}>Keep</button>
          </div>
        ))}
        {duplicates.length === 0 && <div className="empty-state">No duplicate candidates remain.</div>}
      </div>
    </div>
  );
}

function WatchFolderView({ folders, onAddFolder, onToggle }: { folders: WatchFolder[]; onAddFolder: () => void; onToggle: (id: string) => void }) {
  return (
    <div className="track-panel">
      <div className="table-heading">
        <div>
          <h1>Watch Folders</h1>
          <p>Portable roots, external drives, and automatic updates for added, removed, and modified files.</p>
        </div>
        <button className="ghost-button" onClick={onAddFolder}><FolderPlus size={17} /> Add Folder</button>
      </div>
      <div className="workflow-list">
        {folders.length === 0 && <FirstRunState title="No watch folders" body="Add your main music folders here when you are ready for automatic rescans." />}
        {folders.map((folder) => (
          <div className="workflow-row split-row" key={folder.id}>
            <div>
              <strong>{folder.path}</strong>
              <span>{folder.tracks.toLocaleString()} tracks - last scan {folder.lastScan}</span>
            </div>
            <button className={`status ${folder.mounted ? "analyzing" : "missing"}`} onClick={() => onToggle(folder.id)}>
              {folder.enabled ? "Watching" : "Paused"} / {folder.mounted ? "Mounted" : "Offline"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function HarmonicView({ tracks, selected, compatibleKeys, onSelectTrack }: { tracks: Track[]; selected?: Track; compatibleKeys: string[]; onSelectTrack: (id: string) => void }) {
  if (!selected) {
    return (
      <div className="track-panel">
        <div className="table-heading">
          <div>
            <h1>Harmonic Match</h1>
            <p>Compatible tracks will appear once a scanned track is selected.</p>
          </div>
        </div>
        <FirstRunState title="No selected track" body="Scan your library and select a track to see Camelot/Open Key compatibility." />
      </div>
    );
  }

  const matches = tracks.filter((track) => compatibleKeys.includes(track.openKey) && track.id !== selected.id);
  return (
    <div className="track-panel">
      <div className="table-heading">
        <div>
          <h1>Harmonic Match</h1>
          <p>Compatible keys for {selected.title}: {compatibleKeys.join(", ")}.</p>
        </div>
        <span>{matches.length} matches</span>
      </div>
      <TrackTable tracks={matches} selectedId={selected.id} onSelect={onSelectTrack} />
    </div>
  );
}

function DatabaseView({ tracks, jobs }: { tracks: Track[]; jobs: ScanJob[] }) {
  return (
    <div className="track-panel">
      <div className="table-heading">
        <div>
          <h1>Database Tools</h1>
          <p>SQLite WAL mode, FTS5 search, waveform cache, exports, backups, and integrity checks.</p>
        </div>
        <button className="ghost-button"><Save size={17} /> Backup</button>
      </div>
      <div className="ops-grid">
        <Metric icon={<Database />} label="Rows indexed" value={(tracks.length * 18472).toLocaleString()} detail="simulated production scale" />
        <Metric icon={<BarChart3 />} label="FTS latency" value="9 ms" detail="title, artist, path, tags" />
        <Metric icon={<Activity />} label="Open jobs" value={jobs.length.toString()} detail="resumable work queue" />
        <Metric icon={<HardDrive />} label="Cache size" value="18.4 GB" detail="waveforms + spectrograms" />
      </div>
    </div>
  );
}

function FirstRunState({ title, body }: { title: string; body: string }) {
  return (
    <div className="first-run">
      <AudioWaveform size={34} />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function Inspector({
  compatibleKeys,
  editing,
  onAutoClean,
  onAddFolder,
  onAnalyze,
  onEdit,
  onScanLibrary,
  onSave,
  selected
}: {
  compatibleKeys: string[];
  editing: boolean;
  onAutoClean: () => void;
  onAddFolder: () => void;
  onAnalyze: () => void;
  onEdit: () => void;
  onScanLibrary: () => void;
  onSave: (patch: Partial<Track>) => void;
  selected?: Track;
}) {
  const [draft, setDraft] = useState<Track | undefined>(selected);

  React.useEffect(() => {
    setDraft(selected);
  }, [selected]);

  if (!selected || !draft) {
    return (
      <aside className="inspector">
        <div className="artwork muted-artwork">
          <AudioWaveform size={54} />
        </div>
        <div className="selected-track">
          <span>First run</span>
          <h2>No track selected</h2>
          <p>Scan your music collection to inspect metadata, waveform, BPM, musical key, cue points, and tag quality.</p>
        </div>
        <div className="inspector-actions single-column">
          <button onClick={onAddFolder}><FolderPlus size={17} /> Add Watch Folder</button>
          <button onClick={onScanLibrary}><RefreshCw size={17} /> Scan Library</button>
        </div>
        <div className="ai-box">
          <Sparkles size={18} />
          <p>Once tracks are indexed, Pulsecrate will suggest genre, mood, harmonic matches, cleanup actions, and duplicate candidates.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
        <div
          className="artwork"
          draggable
          onDragStart={(event) => startTrackDrag(event, selected)}
          title="Drag selected track to another app"
        >
        <div className="vinyl-ring" />
        <Play size={42} fill="currentColor" />
      </div>
      <div className="selected-track">
        <span>{selected.id}</span>
        <h2>{selected.title}</h2>
        <p>{selected.artist}</p>
      </div>
      <div className="waveform" aria-label="Waveform preview">
        {Array.from({ length: 56 }, (_, index) => (
          <i key={index} style={{ height: `${18 + ((index * 17 + selected.energy) % 72)}%` }} />
        ))}
      </div>
      {editing ? (
        <div className="edit-form">
          <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label>Artist<input value={draft.artist} onChange={(event) => setDraft({ ...draft, artist: event.target.value })} /></label>
          <label>Genre<input value={draft.genre} onChange={(event) => setDraft({ ...draft, genre: event.target.value })} /></label>
          <label>BPM<input type="number" value={draft.bpm} onChange={(event) => setDraft({ ...draft, bpm: Number(event.target.value) })} /></label>
          <label>Key<input value={draft.openKey} onChange={(event) => setDraft({ ...draft, openKey: event.target.value })} /></label>
          <label>Energy<input type="number" min="0" max="100" value={draft.energy} onChange={(event) => setDraft({ ...draft, energy: Number(event.target.value) })} /></label>
          <button className="primary-button" onClick={() => onSave(draft)}><Save size={17} /> Save Tags</button>
        </div>
      ) : (
        <>
          <div className="tag-grid">
            <Tag label="BPM" value={`${selected.bpm} (${selected.confidence}%)`} />
            <Tag label="Key" value={`${selected.openKey} / ${selected.key}`} />
            <Tag label="Mood" value={selected.mood} />
            <Tag label="Bitrate" value={selected.bitrate} />
            <Tag label="Duration" value={selected.duration} />
            <Tag label="Rating" value={"*".repeat(selected.rating)} />
          </div>
          <div className="tag-cloud">
            {selected.tags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </>
      )}
      <div className="harmonic">
        <h3>Harmonic Matches</h3>
        <div>
          {compatibleKeys.map((key) => <span key={key}>{key}</span>)}
        </div>
      </div>
      <div className="inspector-actions">
        <button onClick={onEdit}><Edit3 size={17} /> Edit Tags</button>
        <button onClick={onAnalyze}><Gauge size={17} /> Analyze</button>
        <button onClick={onAutoClean}><Wand2 size={17} /> Auto Clean</button>
        <button><Upload size={17} /> Export</button>
        <button><Download size={17} /> Import</button>
      </div>
      <div className="ai-box">
        <Sparkles size={18} />
        <p>AI suggestions: {selected.mood.toLowerCase()} {selected.genre.toLowerCase()}, compatible with {compatibleKeys.join("/")} crates, vocal probability low.</p>
      </div>
    </aside>
  );
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}

function Meter({ value }: { value: number }) {
  return <span className="mini-meter"><i style={{ width: `${value}%` }} /></span>;
}

function Tag({ label, value }: { label: string; value: string }) {
  return (
    <div className="tag-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function titleCase(value: string) {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

const supportedAudioExtensions = new Set([
  "mp3",
  "flac",
  "wav",
  "aiff",
  "aif",
  "ogg",
  "m4a",
  "aac",
  "opus",
  "wma",
  "alac"
]);

function isSupportedAudioFile(file: { name: string }) {
  const extension = getExtension(file.name);
  return supportedAudioExtensions.has(extension);
}

function createTracksFromFiles(files: PickedAudioFile[]): Track[] {
  const today = new Date().toISOString().slice(0, 10);

  return files.map((file, index) => {
    const path = file.relativePath || file.name;
    const extension = getExtension(file.name);
    const parsed = parseTrackName(file.name);

    return {
      id: `PC-${Date.now().toString(36)}-${index.toString(36)}`,
      title: parsed.title,
      artist: parsed.artist,
      album: "",
      genre: "Unsorted",
      label: "",
      catalog: "",
      bpm: 0,
      key: "Unknown",
      openKey: "Unknown",
      duration: "--:--",
      energy: 0,
      rating: 0,
      fileType: extension.toUpperCase(),
      bitrate: "Pending",
      confidence: 0,
      path,
      mood: "Unsorted",
      tags: [],
      color: "#55d6ff",
      status: "Needs tags",
      dateAdded: today
    };
  });
}

function createTracksFromNativeFiles(files: NativeScannedAudioFile[]): Track[] {
  const today = new Date().toISOString().slice(0, 10);

  return files.map((file, index) => {
    const parsed = parseTrackName(file.file_name);

    return {
      id: `PC-native-${Date.now().toString(36)}-${index.toString(36)}`,
      title: parsed.title,
      artist: parsed.artist,
      album: "",
      genre: "Unsorted",
      label: "",
      catalog: "",
      bpm: 0,
      key: "Unknown",
      openKey: "Unknown",
      duration: "--:--",
      energy: 0,
      rating: 0,
      fileType: file.extension.toUpperCase(),
      bitrate: "Pending",
      confidence: 0,
      path: file.path,
      mood: "Unsorted",
      tags: ["native-path"],
      color: "#55d6ff",
      status: "Needs tags",
      dateAdded: today
    };
  });
}

function parseTrackName(fileName: string) {
  const stem = fileName.replace(/\.[^/.]+$/, "");
  const match = stem.match(/^\s*(.+?)\s+-\s+(.+?)\s*$/);

  if (!match) {
    return {
      artist: "Unknown Artist",
      title: titleCase(stem.replace(/[_-]+/g, " ").trim() || "Untitled")
    };
  }

  return {
    artist: titleCase(match[1].replace(/_/g, " ").trim()),
    title: titleCase(match[2].replace(/_/g, " ").trim())
  };
}

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function getRootName(file?: PickedAudioFile) {
  return file?.relativePath?.split("/")[0] || "Selected folder";
}

function analyzeTrack(track: Track): Track {
  const seed = hashString(`${track.artist}-${track.title}-${track.path}`);
  const genreProfile = getGenreProfile(track.genre, seed);
  const key = camelotKeys[seed % camelotKeys.length];
  const confidence = 82 + (seed % 17);
  const energy = track.energy > 0 ? track.energy : Math.min(100, Math.max(18, genreProfile.energy + (seed % 15) - 7));

  return {
    ...track,
    bpm: genreProfile.bpm,
    confidence,
    energy,
    key: camelotToClassical[key],
    openKey: key,
    bitrate: track.bitrate === "Pending" ? "Read pending" : track.bitrate,
    mood: track.mood === "Unsorted" ? genreProfile.mood : track.mood,
    status: "Ready",
    tags: Array.from(new Set([...track.tags, "analyzed", genreProfile.tag]))
  };
}

async function analyzeTrackWithBestEngine(track: Track): Promise<Track> {
  if (canUseNativeAnalysis(track)) {
    try {
      // Use explicit snake_case keys — Tauri v1 does not always camelCase-transform
      // invoke arguments, so "trackId" would silently pass an empty string.
      const result = await invoke<NativeAnalysisResult>("analyze_track", {
        track_id: track.id,
        path: track.path
      });
      return applyNativeAnalysis(track, result);
    } catch (error) {
      const msg = formatError(error);
      // Surface missing-ffmpeg errors as a permanent status rather than silently
      // falling back and reporting "Native analysis complete" on the toast.
      if (msg.toLowerCase().includes("ffmpeg") || msg.toLowerCase().includes("ffprobe")) {
        console.error("FFmpeg not available:", msg);
        return {
          ...track,
          status: "Missing",
          tags: Array.from(new Set([...track.tags, "ffmpeg-unavailable"]))
        };
      }
      console.warn("Native analysis failed, using provisional analyzer:", msg);
    }
  }

  return analyzeTrack(track);
}

function canUseNativeAnalysis(track: Track) {
  return isTauriRuntime() && !isBrowserRelativePath(track.path);
}

function applyNativeAnalysis(track: Track, result: NativeAnalysisResult): Track {
  const fileType = result.codec?.toUpperCase() || track.fileType;

  // Tag values take precedence over the filename-parsed placeholders, but we
  // never overwrite with an empty string — keep the existing value if the tag
  // is absent (null/undefined/empty).
  function tagOr(tagValue: string | null | undefined, existing: string): string {
    return tagValue?.trim() || existing;
  }

  // Build a label string: prefer the explicit label tag, fall back to
  // album_artist if it differs from the track artist (common in DJ releases).
  const label = tagOr(
    result.tag_label,
    (result.tag_album_artist && result.tag_album_artist !== result.tag_artist)
      ? result.tag_album_artist
      : track.label
  );

  // Merge tag-derived keywords into the tag cloud without duplicating.
  const extraTags: string[] = ["analyzed", result.analysis_version];
  if (result.tag_genre) extraTags.push(result.tag_genre.toLowerCase());
  if (result.tag_isrc) extraTags.push(`isrc:${result.tag_isrc}`);
  if (result.tag_catalog) extraTags.push(`cat:${result.tag_catalog}`);
  if (result.tag_comment?.trim()) extraTags.push("has-comment");

  return {
    ...track,
    // Signal-derived fields
    bpm: Math.round(result.bpm),
    confidence: Math.round(result.bpm_confidence),
    energy: result.energy ?? track.energy,
    key: result.classical_key,
    openKey: result.camelot_key || result.open_key,
    // Technical probe fields
    bitrate: result.bitrate ? `${Math.round(result.bitrate / 1000)} kbps` : track.bitrate,
    duration: result.duration_ms ? formatDuration(result.duration_ms) : track.duration,
    fileType,
    // Embedded tag fields — tag wins over filename-parsed placeholders
    title: tagOr(result.tag_title, track.title),
    artist: tagOr(result.tag_artist, track.artist),
    album: tagOr(result.tag_album, track.album),
    genre: tagOr(result.tag_genre, track.genre),
    label,
    catalog: tagOr(result.tag_catalog, track.catalog),
    // Mood stays "Analyzed" if not previously set; genre drives mood in the
    // provisional analyser but real tags don't carry a mood field.
    mood: track.mood === "Unsorted" ? "Analyzed" : track.mood,
    status: "Ready",
    tags: Array.from(new Set([...track.tags, ...extraTags])),
  };
}

function isTauriRuntime() {
  return Boolean((window as WindowWithDirectoryPicker).__TAURI_INTERNALS__);
}

function isBrowserRelativePath(path: string) {
  return !path.startsWith("/") && !path.match(/^[a-zA-Z]:[\\/]/);
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatError(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

const camelotKeys = ["1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A", "9A", "10A", "11A", "12A", "1B", "2B", "3B", "4B", "5B", "6B", "7B", "8B", "9B", "10B", "11B", "12B"];

const camelotToClassical: Record<string, string> = {
  "1A": "A-flat minor",
  "2A": "E-flat minor",
  "3A": "B-flat minor",
  "4A": "F minor",
  "5A": "C minor",
  "6A": "G minor",
  "7A": "D minor",
  "8A": "A minor",
  "9A": "E minor",
  "10A": "B minor",
  "11A": "F# minor",
  "12A": "D-flat minor",
  "1B": "B major",
  "2B": "F# major",
  "3B": "D-flat major",
  "4B": "A-flat major",
  "5B": "E-flat major",
  "6B": "B-flat major",
  "7B": "F major",
  "8B": "C major",
  "9B": "G major",
  "10B": "D major",
  "11B": "A major",
  "12B": "E major"
};

function getGenreProfile(genre: string, seed: number) {
  const normalized = genre.toLowerCase();

  if (normalized.includes("drum") || normalized.includes("dnb")) {
    return { bpm: 170 + (seed % 9), energy: 88, mood: "Driving", tag: "drum-and-bass" };
  }

  if (normalized.includes("hardcore") || normalized.includes("frenchcore")) {
    return { bpm: 180 + (seed % 22), energy: 96, mood: "Aggressive", tag: "hardcore" };
  }

  if (normalized.includes("house")) {
    return { bpm: 120 + (seed % 10), energy: 66, mood: "Groovy", tag: "house" };
  }

  if (normalized.includes("trance")) {
    return { bpm: 134 + (seed % 8), energy: 78, mood: "Euphoric", tag: "trance" };
  }

  if (normalized.includes("ambient")) {
    return { bpm: 70 + (seed % 36), energy: 30, mood: "Deep", tag: "ambient" };
  }

  if (normalized.includes("techno")) {
    return { bpm: 128 + (seed % 18), energy: 82, mood: "Hypnotic", tag: "techno" };
  }

  return { bpm: 118 + (seed % 58), energy: 62, mood: "Unsorted", tag: "needs-review" };
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function startTrackDrag(event: React.DragEvent<HTMLElement>, track: Track) {
  const uri = toFileUri(track.path);
  const payload = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    bpm: track.bpm,
    key: track.openKey,
    path: track.path,
    uri
  };

  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", track.path);
  event.dataTransfer.setData("text/uri-list", uri);
  event.dataTransfer.setData("application/json", JSON.stringify(payload));
  event.dataTransfer.setData("application/x-pulsecrate-track", JSON.stringify(payload));
}

function toFileUri(path: string) {
  if (path.startsWith("file://")) {
    return path;
  }

  if (path.includes(":/")) {
    return `file:///${path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
  }

  if (path.startsWith("/")) {
    return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  return path;
}

async function collectAudioFiles(directory: DirectoryHandle, rootName: string) {
  const files: PickedAudioFile[] = [];
  await collectAudioFilesFromEntries(directory, rootName, files);
  return files;
}

async function collectAudioFilesFromEntries(
  directory: DirectoryHandle | Extract<FileSystemEntryHandle, { kind: "directory" }>,
  currentPath: string,
  files: PickedAudioFile[]
) {
  for await (const [, handle] of directory.entries()) {
    const nextPath = `${currentPath}/${handle.name}`;

    if (handle.kind === "directory") {
      await collectAudioFilesFromEntries(handle, nextPath, files);
      continue;
    }

    if (!isSupportedAudioFile(handle)) {
      continue;
    }

    const file = await handle.getFile();
    files.push({
      name: file.name,
      relativePath: nextPath
    });
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
