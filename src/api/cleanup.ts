import fs from 'fs';
import env from '../util/env';
import logger from '../util/logger';
import { getMovieByTmdbId, deleteMovie } from './radarr';
import { getMovie } from '../scraper/movie';
import { getSeriesByTvdbId, deleteSeries, resolveTvdbId } from './sonarr';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const DELETED_FILE = `${DATA_DIR}/deleted.json`;
const DELETED_SONARR_FILE = `${DATA_DIR}/deleted-sonarr.json`;
const LB_BASE = 'https://letterboxd.com';
const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0' };

function readDeleted(): Set<string> {
    try {
        return new Set(JSON.parse(fs.readFileSync(DELETED_FILE, 'utf8')));
    } catch {
        return new Set();
    }
}

function writeDeleted(set: Set<string>): void {
    fs.writeFileSync(DELETED_FILE, JSON.stringify([...set]));
}

function readDeletedSonarr(): Set<string> {
    try {
        return new Set(JSON.parse(fs.readFileSync(DELETED_SONARR_FILE, 'utf8')));
    } catch {
        return new Set();
    }
}

function writeDeletedSonarr(set: Set<string>): void {
    fs.writeFileSync(DELETED_SONARR_FILE, JSON.stringify([...set]));
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { headers: FETCH_HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.text();
}

interface RssEntry {
    slug: string;
    tmdbId: number;
}

async function scrapeRssEntries(): Promise<RssEntry[]> {
    const xml = await fetchText(`${LB_BASE}/${env.LETTERBOXD_USERNAME}/rss/`);
    const entries: RssEntry[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null) {
        const item = m[1];
        const linkM = item.match(/<link>([^<]+)<\/link>/);
        const tmdbM = item.match(/<tmdb:movieId>(\d+)<\/tmdb:movieId>/);
        if (!linkM || !tmdbM) continue;
        const slugM = linkM[1].match(/\/film\/([^/]+)\//);
        if (slugM) entries.push({ slug: slugM[1], tmdbId: parseInt(tmdbM[1]) });
    }
    return entries;
}

async function diaryPageHasTag(slug: string): Promise<boolean> {
    const html = await fetchText(`${LB_BASE}/${env.LETTERBOXD_USERNAME}/film/${slug}/`);
    return html.includes(`tag/${env.LETTERBOXD_CLEANUP_TAG}/`);
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

export async function runCleanup(): Promise<void> {
    logger.info(`[cleanup] Scanning RSS for '${env.LETTERBOXD_CLEANUP_TAG}' tag${env.DRY_RUN ? ' (DRY_RUN)' : ''}`);

    const entries = await scrapeRssEntries();
    logger.info(`[cleanup] ${entries.length} diary entries in RSS`);
    if (entries.length === 0) return;

    const deleted = readDeleted();
    const toCheck = entries.filter(e => !deleted.has(e.slug));
    logger.info(`[cleanup] Checking ${toCheck.length} entries (${entries.length - toCheck.length} already handled)`);

    let removed = 0, notFound = 0, errors = 0;

    for (const { slug, tmdbId } of toCheck) {
        let tagged: boolean;
        try {
            tagged = await diaryPageHasTag(slug);
        } catch (e: any) {
            logger.error(`[cleanup] Error checking diary page for ${slug}: ${e.message}`);
            errors++;
            continue;
        }

        if (!tagged) { await sleep(200); continue; }

        try {
            const movie = await getMovieByTmdbId(tmdbId);
            if (!movie) {
                logger.info(`[cleanup] Tagged but not in Radarr: ${slug} (tmdb:${tmdbId})`);
                notFound++;
            } else {
                await deleteMovie(movie.id, movie.title);
                if (!env.DRY_RUN) removed++;
            }
            // Mark handled whether deleted or not-found (but not on dry run)
            if (!env.DRY_RUN) {
                deleted.add(slug);
                writeDeleted(deleted);
            }
        } catch (e: any) {
            logger.error(`[cleanup] Error processing tmdb:${tmdbId}: ${e.message}`);
            errors++;
        }

        await sleep(500);
    }

    logger.info(`[cleanup] Done — deleted: ${removed}, not in Radarr: ${notFound}, errors: ${errors}`);
}

export async function runSonarrCleanup(): Promise<void> {
    logger.info(`[sonarr-cleanup] Scanning RSS for '${env.LETTERBOXD_CLEANUP_TAG}' tag${env.DRY_RUN ? ' (DRY_RUN)' : ''}`);

    const entries = await scrapeRssEntries();
    logger.info(`[sonarr-cleanup] ${entries.length} diary entries in RSS`);
    if (entries.length === 0) return;

    const deleted = readDeletedSonarr();
    const toCheck = entries.filter(e => !deleted.has(e.slug));
    logger.info(`[sonarr-cleanup] Checking ${toCheck.length} entries (${entries.length - toCheck.length} already handled)`);

    let removed = 0, notFound = 0, errors = 0;

    for (const { slug } of toCheck) {
        let tagged: boolean;
        try {
            tagged = await diaryPageHasTag(slug);
        } catch (e: any) {
            logger.error(`[sonarr-cleanup] Error checking diary page for ${slug}: ${e.message}`);
            errors++;
            continue;
        }

        if (!tagged) { await sleep(200); continue; }

        // Visit the main film page to determine if this is a TV show
        let tvTmdbId: string | null | undefined;
        try {
            const film = await getMovie(`/film/${slug}/`);
            tvTmdbId = film.tvTmdbId;
        } catch (e: any) {
            logger.error(`[sonarr-cleanup] Error fetching film page for ${slug}: ${e.message}`);
            errors++;
            continue;
        }

        if (!tvTmdbId) {
            // It's a movie — Radarr cleanup handles it
            await sleep(200);
            continue;
        }

        try {
            const tvdbId = await resolveTvdbId(tvTmdbId);
            if (!tvdbId) {
                logger.warn(`[sonarr-cleanup] No TVDB ID for TMDB TV ${tvTmdbId} (${slug})`);
                notFound++;
            } else {
                const series = await getSeriesByTvdbId(tvdbId);
                if (!series) {
                    logger.info(`[sonarr-cleanup] Tagged but not in Sonarr: ${slug} (tvdb:${tvdbId})`);
                    notFound++;
                } else {
                    await deleteSeries(series.id, series.title);
                    if (!env.DRY_RUN) removed++;
                }
            }
            if (!env.DRY_RUN) {
                deleted.add(slug);
                writeDeletedSonarr(deleted);
            }
        } catch (e: any) {
            logger.error(`[sonarr-cleanup] Error processing ${slug}: ${e.message}`);
            errors++;
        }

        await sleep(500);
    }

    logger.info(`[sonarr-cleanup] Done — deleted: ${removed}, not in Sonarr: ${notFound}, errors: ${errors}`);
}
