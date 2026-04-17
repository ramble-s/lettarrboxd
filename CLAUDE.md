# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Fork of ryanpage/lettarrboxd. Syncs a Letterboxd list to Radarr (movies) and, optionally, Sonarr (TV shows). Optionally deletes Radarr/Sonarr items when their Letterboxd diary entry is tagged with a cleanup tag. All enabled features run on the same interval from a single container.

Sonarr sync is off by default — users who only want Radarr can run the container with Radarr vars alone. Set `SONARR_ENABLED=true` (plus `SONARR_API_URL`, `SONARR_API_KEY`, `SONARR_QUALITY_PROFILE`) to turn on TV sync.

New modules added in this fork: `src/api/sonarr.ts` (TV sync), `src/api/cleanup.ts` (diary cleanup).

## Commands

### Development
- `yarn install` - Install dependencies
- `yarn start` - Run the compiled application (requires `yarn build` first)
- `yarn start:dev` - Run with auto-reload during development using nodemon
- `yarn build` - Compile TypeScript to JavaScript
- `yarn tsc --noEmit` - Type check without emitting files

### Docker
- `docker build -t lettarrboxd .` - Build Docker image
- `docker run -d --env-file .env -v ./data:/data lettarrboxd` - Run container

## Environment Configuration

The application uses Zod for strict environment variable validation in `src/util/env.ts`. All environment variables are validated at startup and the application will exit with detailed error messages if validation fails.

Required variables:
- `LETTERBOXD_URL` - Letterboxd list URL for scraping (supports watchlists, regular lists, watched movies, filmographies, collections, etc.)
- `RADARR_API_URL` - Base URL of Radarr instance  
- `RADARR_API_KEY` - Radarr API key
- `RADARR_QUALITY_PROFILE` - Quality profile name (case-sensitive)

Optional integrations (gated by feature flags):
- `SONARR_ENABLED=true` activates Sonarr TV sync. When true, `SONARR_API_URL`, `SONARR_API_KEY`, and `SONARR_QUALITY_PROFILE` are all required (enforced by a Zod `.refine()`).
- `RADARR_CLEANUP_ENABLED=true` activates Radarr diary cleanup. Requires `LETTERBOXD_USERNAME`.
- `SONARR_CLEANUP_ENABLED=true` activates Sonarr diary cleanup. Requires `LETTERBOXD_USERNAME` *and* `SONARR_ENABLED=true`.
- `LETTERBOXD_CLEANUP_TAG` (default `cleanup`) is the Letterboxd diary tag — shared by both Radarr and Sonarr cleanup, hence the `LETTERBOXD_` prefix (not `RADARR_`/`SONARR_`).

Key validation rules:
- `CHECK_INTERVAL_MINUTES` enforces minimum 10 minutes
- Environment variables are transformed and validated using Zod schemas
- The app exits early with clear error messages for invalid configuration
- Sonarr and cleanup features are gated by their respective `*_ENABLED` flags, so calls into `upsertShows()` / `runCleanup()` / `runSonarrCleanup()` are skipped when disabled

## Architecture Overview

### Core Application Flow
The application follows a scheduled monitoring pattern:
1. **Scheduler** (`startScheduledMonitoring`) runs `run()` immediately and then every `CHECK_INTERVAL_MINUTES`
2. **Per-tick pipeline** - `fetchMoviesFromUrl → upsertMovies → [upsertShows] → [runCleanup] → [runSonarrCleanup]`, with bracketed steps gated on their feature flags
3. **Rate Limiting** - Built-in delays between API calls to respect external services
4. **Health-check heartbeat** - Writes `DATA_DIR/.last-run` (ISO timestamp) after each successful tick; the container's health check fails if this file is older than 2 hours
5. **Cleanup persistence** - When cleanup is enabled, handled diary slugs are tracked in `DATA_DIR/deleted-radarr.json` and `DATA_DIR/deleted-sonarr.json` so each slug is only processed once

### Module Separation
- **`src/index.ts`** - Main orchestration, scheduling, and file I/O operations. Gates optional integrations on their `*_ENABLED` env flags before calling into the respective modules.
- **`src/scraper/`** - Web scraping and TMDB ID extraction logic
- **`src/api/radarr.ts`** - Radarr API integration and movie management
- **`src/api/sonarr.ts`** - Sonarr TV sync (fork addition). `upsertShows()` early-returns if `SONARR_ENABLED` is false; the axios client throws if Sonarr creds are missing at call time.
- **`src/api/cleanup.ts`** - Letterboxd diary cleanup (fork addition). Persists handled slugs to `/data/deleted-radarr.json` (movies) and `/data/deleted-sonarr.json` (TV shows) so they're only processed once.
- **`src/util/env.ts`** - Environment validation and configuration management. Uses Zod `.refine()` to enforce conditional requirements (e.g. Sonarr vars required iff `SONARR_ENABLED=true`).

### Key Architectural Patterns

**State Management**: The application is stateless for the sync side — it always re-reads the Letterboxd list and lets Radarr/Sonarr deduplicate (the "already added" responses are handled silently). Cleanup persists handled slugs to `deleted-radarr.json` / `deleted-sonarr.json` so tagged diary entries are only processed once. `.last-run` is written for the health check.

**Error Handling**: Each module handles errors gracefully without crashing the scheduler. Network failures and API errors are logged but don't stop the monitoring process.


**Radarr Integration**: Movies are added with:
- Specified quality profile from environment
- "letterboxd-watchlist" tag for organization
- Automatic monitoring and search enabled
- Configurable minimum availability settings

### Web Scraping Strategy
Letterboxd scraping is implemented with:
- **Multi-page support** - Automatically handles paginated watchlists
- **TMDB ID extraction** - Visits individual movie pages to extract TMDB identifiers
- **Rate limiting** - 1 second delays between page requests, 500ms between TMDB extractions
- **Graceful pagination** - Detects end of pages using CSS selectors

### Function Organization
The codebase is organized into small, focused functions:
- `startScheduledMonitoring()` / `run()` (`src/index.ts`) - Scheduler and per-tick orchestration; `run()` sequences `fetchMoviesFromUrl → upsertMovies → [upsertShows] → [runCleanup] → [runSonarrCleanup]`, with bracketed steps gated on their feature flags.
- `upsertMovies(movies)` (`src/api/radarr.ts`) - Radarr sync
- `upsertShows(movies)` (`src/api/sonarr.ts`) - Sonarr sync (no-op when `SONARR_ENABLED=false`)
- `runCleanup()` / `runSonarrCleanup()` (`src/api/cleanup.ts`) - Diary-tag-driven deletion
- `fetchMoviesFromUrl(url)` (`src/scraper/`) - Scraping entry point that dispatches to the right scraper by URL shape

## Development Notes

### TypeScript Configuration
- Strict mode enabled with comprehensive type checking
- Uses ts-node for direct TypeScript execution
- All environment variables are strictly typed through Zod inference

### Docker Multi-Stage Build
The Dockerfile uses a production-optimized approach:
- Alpine Linux base for minimal size
- Non-root user for security
- Health checks included
- Multi-architecture support (AMD64/ARM64)

### Rate Limiting Implementation
Built-in delays prevent overwhelming external services:
- 1000ms between Letterboxd page requests
- 1000ms between Radarr API calls  
- 500ms between TMDB ID extractions

### Error Recovery
The application is designed to handle transient failures:
- Individual movie processing failures don't stop the batch
- Network timeouts are caught and logged
- Scheduler continues running even if individual checks fail