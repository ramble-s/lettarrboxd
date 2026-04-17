import fs from 'fs';
import env from '../util/env';
import logger from '../util/logger';
import { getMovieByTmdbId, deleteMovie } from './radarr';

const DELETED_FILE = '/data/deleted.json';
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
