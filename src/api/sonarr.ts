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

export async function getExistingTvdbIds(): Promise<Set<number>> {
    try {
        const response = await getAxios().get('/api/v3/series');
        return new Set(response.data.map((s: any) => s.tvdbId));
    } catch (error) {
        logger.error('Error getting existing Sonarr series:', error);
        return new Set();
    }
}

export async function resolveTvdbId(tmdbTvId: string): Promise<number | null> {
    try {
        const isBearer = env.TMDB_API_KEY.startsWith('eyJ');
        const url = `https://api.themoviedb.org/3/tv/${tmdbTvId}/external_ids`;
        const headers: Record<string, string> = { Accept: 'application/json' };

        let fetchUrl = url;
        if (isBearer) {
            headers['Authorization'] = `Bearer ${env.TMDB_API_KEY}`;
        } else {
            fetchUrl = `${url}?api_key=${env.TMDB_API_KEY}`;
        }

        const response = await fetch(fetchUrl, { headers });
        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`TMDB API returned ${response.status}`);
        }
        const data = await response.json() as { tvdb_id?: number };
        return data.tvdb_id ?? null;
    } catch (error) {
        logger.error(`Error resolving TVDB ID for TMDB TV ${tmdbTvId}:`, error);
        return null;
    }
}

export async function addSeries(tvdbId: number, qualityProfileId: number, rootFolderPath: string): Promise<void> {
    try {
        const lookupResponse = await getAxios().get(`/api/v3/series/lookup?term=tvdb:${tvdbId}`);
        const results = lookupResponse.data;
        if (!results || results.length === 0) {
            logger.warn(`Series not found in Sonarr lookup for tvdb:${tvdbId}`);
            return;
        }

        const series: SonarrSeries = {
            ...results[0],
            qualityProfileId,
            rootFolderPath,
            monitored: true,
            seasonFolder: true,
            addOptions: { searchForMissingEpisodes: true, monitor: 'all' }
        };

        if (env.DRY_RUN) {
            logger.info(`[DRY RUN] Would add series to Sonarr: ${series.title} (tvdb:${tvdbId})`);
            return;
        }

        await getAxios().post('/api/v3/series', series);
    } catch (e: any) {
        if (e.response?.status === 400 && JSON.stringify(e.response?.data).includes('already been added')) {
            logger.debug(`Series tvdb:${tvdbId} already exists in Sonarr, skipping`);
            return;
        }
        logger.error(`Error adding series tvdb:${tvdbId}:`, e);
    }
}

export async function getSeriesByTvdbId(tvdbId: number): Promise<{ id: number; title: string } | null> {
    try {
        const response = await getAxios().get(`/api/v3/series?tvdbId=${tvdbId}`);
        return response.data?.[0] ?? null;
    } catch (error) {
        logger.error(`Error looking up Sonarr series tvdb:${tvdbId}:`, error);
        return null;
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

    const existing = await getExistingTvdbIds();

    let added = 0, skipped = 0, noTvdb = 0;

    for (const show of tvShows) {
        const tvdbId = await resolveTvdbId(show.tvTmdbId!);
        if (!tvdbId) {
            logger.warn(`[sonarr] No TVDB ID for TMDB TV ${show.tvTmdbId} (${show.name})`);
            noTvdb++;
            continue;
        }

        if (existing.has(tvdbId)) {
            logger.debug(`${show.name} already in Sonarr, skipping`);
            skipped++;
            continue;
        }

        logger.info(`Adding TV show to Sonarr: ${show.name} (tvdb:${tvdbId})`);
        await addSeries(tvdbId, qualityProfileId, rootFolderPath);
        existing.add(tvdbId);
        added++;
    }

    logger.info(`[sonarr] Done — added: ${added}, already present: ${skipped}, no TVDB ID: ${noTvdb}`);
}
