# lettarrboxd (fork)

A fork of [ryanpage/lettarrboxd](https://github.com/ryanpag3/lettarrboxd) that adds **Sonarr TV sync** and **Letterboxd diary cleanup** on top of the original Radarr watchlist sync.

## What it does

- **Radarr sync** — scrapes a Letterboxd list and adds movies to Radarr automatically
- **Sonarr sync** *(optional)* — detects TV shows in the same list and adds them to Sonarr
- **Diary cleanup** *(optional)* — watches your Letterboxd diary for entries tagged with a chosen tag (e.g. `cleanup`) and deletes the corresponding movie from Radarr

All three run on the same interval from a single container.

## Quick start

```yaml
services:
  lettarrboxd:
    image: ghcr.io/ramble-s/lettarrboxd:latest   # or build from source (see below)
    container_name: lettarrboxd
    environment:
      - LETTERBOXD_URL=https://letterboxd.com/your_username/watchlist/
      - RADARR_API_URL=http://radarr:7878
      - RADARR_API_KEY=your_radarr_api_key
      - RADARR_QUALITY_PROFILE=HD-1080p
    volumes:
      - lettarrboxd-data:/data
    restart: unless-stopped

volumes:
  lettarrboxd-data:
```

## Building from source

```bash
git clone https://github.com/ramble-s/lettarrboxd.git
cd lettarrboxd
docker build -t lettarrboxd .
docker run -d --env-file .env -v lettarrboxd-data:/data lettarrboxd
```

## Configuration

### Radarr (required)

| Variable | Description |
|----------|-------------|
| `LETTERBOXD_URL` | Letterboxd list URL to sync |
| `RADARR_API_URL` | Radarr base URL |
| `RADARR_API_KEY` | Radarr API key |
| `RADARR_QUALITY_PROFILE` | Quality profile name (case-sensitive) |

### Radarr (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL_MINUTES` | `10` | How often to check (minimum 10) |
| `RADARR_MINIMUM_AVAILABILITY` | `released` | `announced`, `inCinemas`, or `released` |
| `RADARR_TAGS` | — | Comma-separated tags to apply in Radarr |
| `RADARR_ADD_UNMONITORED` | `false` | Add movies unmonitored |
| `RADARR_ROOT_FOLDER_ID` | — | Pin to a specific root folder |
| `LETTERBOXD_TAKE_AMOUNT` | — | Limit how many items to sync (requires `LETTERBOXD_TAKE_STRATEGY`) |
| `LETTERBOXD_TAKE_STRATEGY` | — | `newest` or `oldest` (requires `LETTERBOXD_TAKE_AMOUNT`) |
| `DRY_RUN` | `false` | Log what would happen without making any changes |

### Sonarr TV sync (optional)

Set `SONARR_ENABLED=true` to have TV shows in your Letterboxd list added to Sonarr instead of silently skipped. Requires a TMDB API key to resolve TMDB TV IDs to TVDB IDs.

| Variable | Description |
|----------|-------------|
| `SONARR_ENABLED` | Set to `true` to enable |
| `SONARR_API_URL` | Sonarr base URL |
| `SONARR_API_KEY` | Sonarr API key |
| `SONARR_QUALITY_PROFILE` | Quality profile name in Sonarr (case-sensitive) |
| `TMDB_API_KEY` | TMDB API key — v3 key or v4 JWT Bearer token both work |

### Diary cleanup (optional)

Set `LETTERBOXD_CLEANUP_ENABLED=true` to enable deletion of Radarr movies based on a tag in your Letterboxd diary. When you tag a diary entry with the cleanup tag, the movie is deleted from Radarr (including files).

> **Note:** Letterboxd's tag index pages are Cloudflare-protected. This feature works around that by checking your diary RSS feed and individual diary entry pages instead — both are publicly accessible.

| Variable | Default | Description |
|----------|---------|-------------|
| `LETTERBOXD_CLEANUP_ENABLED` | `false` | Set to `true` to enable |
| `LETTERBOXD_USERNAME` | — | Your Letterboxd username (required) |
| `LETTERBOXD_CLEANUP_TAG` | `cleanup` | Tag to watch for in diary entries |

Processed entries are tracked in `/data/deleted.json` so they're only handled once.

## Supported Letterboxd URLs

| Type | Example URL |
|------|-------------|
| Watchlist | `https://letterboxd.com/username/watchlist/` |
| Custom list | `https://letterboxd.com/username/list/list-name/` |
| Watched films | `https://letterboxd.com/username/films/` |
| Collection | `https://letterboxd.com/films/in/collection-name/` |
| Popular films | `https://letterboxd.com/films/popular/` |
| Director filmography | `https://letterboxd.com/director/director-name/` |
| Actor filmography | `https://letterboxd.com/actor/actor-name/` |

All lists must be public.

## Development

```bash
yarn install
cp .env.example .env   # fill in your values
yarn start:dev         # run with auto-reload
yarn tsc --noEmit      # type check
```

When `NODE_ENV=development` the app limits processing to the first 5 items for faster iteration.

## License

MIT — see [LICENSE](LICENSE). Fork of [ryanpage/lettarrboxd](https://github.com/ryanpag3/lettarrboxd).
