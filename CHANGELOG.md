# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-05-29

### Fixed

- Fixed native analysis being skipped for relative file paths in Tauri desktop app.
  - Enhanced `isTauriRuntime()` detection to check for both `__TAURI_INTERNALS__` and `__TAURI__`.
  - Updated `isBrowserRelativePath()` to allow valid relative paths in Tauri runtime while maintaining security restrictions.
  - This resolves the issue where music files with relative paths (e.g., from folder picker) were incorrectly classified as browser-relative, preventing native analysis.
