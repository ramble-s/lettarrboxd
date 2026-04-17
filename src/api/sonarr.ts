import Axios from 'axios';
import env from '../util/env';
import logger from '../util/logger';
import { LetterboxdMovie } from '../scraper';

interface SonarrSeries {
    title: string;
    qualityProfileId: number;
    rootFolderPath: string;
    tvdbId: number;
    monitored: boolean;
    seasonFolder: boolean;
    addOptions: {
        searchForMissingEpisodes: boolean;
        monitor: string;
    };
    [key: string]: unknown;
}

let _axios: ReturnType<typeof Axios.create> | null = null;

function getAxios(): ReturnType<typeof Axios.create> {
    if (!_axios) {
        _axios = Axios.create({
            baseURL: env.SONARR_API_URL,
            headers: { 'X-Api-Key': env.SONARR_API_KEY }
        });
    }
    return _axios;
}

export async function getQualityProfileId(profileName: string): Promise<number | null> {
    try {
        const response = await getAxios().get('/api/v3/qualityprofile');
        const profile = response.data.find((p: any) => p.name === profileName);
        if (profile) {
            logger.debug(`Found Sonarr quality profile: ${profileName} (ID: ${profile.id})`);
            return profile.id;
        }
        logger.error(`Sonarr quality profile not found: ${profileName}`);
        return null;
    } catch (error) {
        logger.error('Error getting Sonarr quality profiles:', error);
        return null;
    }
}

export async function getRootFolder(): Promise<string | null> {
    try {
        const response = await getAxios().get('/api/v3/rootfolder');
        const rootFolders = response.data;
        if (rootFolders.length > 0) {
            logger.debug(`Using Sonarr root folder: ${rootFolders[0].path}`);
            return rootFolders[0].path;
        }
        logger.error('No root folders found in Sonarr');
        return null;
    } catch (error) {
        logger.error('Error getting Sonarr root folders:', error);
        return null;
    }
}

async function getSeriesByTmdbIdFallback(tmdbId: number): Promise<{ id: number; title: string } | null> {
    try {
        const response = await getAxios().get('/api/v3/series');
        const match = (response.data as any[]).find((s: any) => s.tmdbId === tmdbId);
        if (!match) return null;
        return { id: match.id, title: match.title };
    } catch (error) {
        logger.error(`Error fetching Sonarr library for fallback tmdbId:${tmdbId}:`, error);
        return null;
    }
}

/**
 * Look up a series in Sonarr's library by its TMDB TV ID.
 * Uses Sonarr's native `tmdb:` lookup term — no external TMDB API call needed.
 * Falls back to scanning the full library if the lookup returns empty (Sonarr bug
 * where some series return no results from the lookup endpoint).
 * Returns the Sonarr series record (with internal id) if it is already in the library,
 * or null if it is not yet added.
 */
export async function findSeriesInSonarrByTmdbId(tmdbTvId: string): Promise<{ id: number; title: string } | null> {
    try {
        const response = await getAxios().get(`/api/v3/series/lookup?term=tmdb:${tmdbTvId}`);
        const results = response.data;
        if (!results?.length) {
            const fallback = await getSeriesByTmdbIdFallback(Number(tmdbTvId));
            if (fallback) {
                logger.debug(`Series tmdb:${tmdbTvId} found via library fallback: ${fallback.title}`);
                return fallback;
            }
            logger.warn(`Series tmdb:${tmdbTvId} not found after fallback check`);
            return null;
        }
        // Series already in library have a positive `id` at the series level.
        // Series not yet added have no series-level `id` in the response.
        const first = results[0];
        if (!first.id) return null;
        return { id: first.id, title: first.title };
    } catch (error) {
        logger.error(`Error looking up Sonarr series tmdb:${tmdbTvId}:`, error);
        return null;
    }
}

export async function addSeries(tmdbTvId: string, qualityProfileId: number, rootFolderPath: string): Promise<void> {
    try {
        const lookupResponse = await getAxios().get(`/api/v3/series/lookup?term=tmdb:${tmdbTvId}`);
        const results = lookupResponse.data;
        if (!results || results.length === 0) {
            logger.warn(`Series not found in Sonarr lookup for tmdb:${tmdbTvId}`);
            return;
        }

        const first = results[0];
        if (first.id) {
            logger.debug(`Series tmdb:${tmdbTvId} already in Sonarr (id:${first.id}), skipping`);
            return;
        }

        const series: SonarrSeries = {
            ...first,
            qualityProfileId,
            rootFolderPath,
            monitored: true,
            seasonFolder: true,
            addOptions: { searchForMissingEpisodes: true, monitor: 'all' }
        };

        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would add series to Sonarr: ${series.title} (tmdb:${tmdbTvId})`);
            return;
        }

        await getAxios().post('/api/v3/series', series);
        logger.info(`Added series to Sonarr: ${series.title} (tmdb:${tmdbTvId})`);
    } catch (e: any) {
        if (e.response?.status === 400 && JSON.stringify(e.response?.data).includes('already been added')) {
            logger.debug(`Series tmdb:${tmdbTvId} already exists in Sonarr, skipping`);
            return;
        }
        logger.error(`Error adding series tmdb:${tmdbTvId}:`, e);
    }
}

export async function deleteSeries(sonarrId: number, title: string): Promise<void> {
    try {
        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would delete from Sonarr: "${title}" (id:${sonarrId})`);
            return;
        }
        await getAxios().delete(`/api/v3/series/${sonarrId}?deleteFiles=true&addImportExclusion=false`);
        logger.info(`Deleted from Sonarr: "${title}"`);
    } catch (error) {
        logger.error(`Error deleting Sonarr series id:${sonarrId}:`, error);
    }
}

export async function upsertShows(movies: LetterboxdMovie[]): Promise<void> {
    const tvShows = movies.filter(m => m.tvTmdbId);
    if (tvShows.length === 0) return;

    logger.info(`[sonarr] Processing ${tvShows.length} TV show(s)`);

    const qualityProfileId = await getQualityProfileId(env.SONARR_QUALITY_PROFILE);
    if (!qualityProfileId) { logger.error('Could not get Sonarr quality profile ID'); return; }

    const rootFolderPath = await getRootFolder();
    if (!rootFolderPath) { logger.error('Could not get Sonarr root folder'); return; }

    let added = 0, skipped = 0, notFound = 0;

    for (const show of tvShows) {
        const lookupResponse = await getAxios().get(`/api/v3/series/lookup?term=tmdb:${show.tvTmdbId}`).catch(() => null);
        if (!lookupResponse?.data?.length) {
            logger.warn(`[sonarr] Series not found in Sonarr lookup for ${show.name} (tmdb:${show.tvTmdbId})`);
            notFound++;
            continue;
        }

        const first = lookupResponse.data[0];
        if (first.id) {
            logger.debug(`${show.name} already in Sonarr, skipping`);
            skipped++;
            continue;
        }

        logger.info(`Adding TV show to Sonarr: ${show.name} (tmdb:${show.tvTmdbId})`);
        await addSeries(show.tvTmdbId!, qualityProfileId, rootFolderPath);
        added++;
    }

    logger.info(`[sonarr] Done — added: ${added}, already present: ${skipped}, not found: ${notFound}`);
}
