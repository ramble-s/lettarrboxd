require('dotenv').config();

import fs from 'fs';
import env from './util/env';
import logger from './util/logger';
import { fetchMoviesFromUrl } from './scraper';
import { upsertMovies } from './api/radarr';
import { upsertShows } from './api/sonarr';
import { runCleanup, runSonarrCleanup } from './api/cleanup';

const DATA_DIR = process.env.DATA_DIR ?? '/data';

function startScheduledMonitoring(): void {
  const intervalMs = env.CHECK_INTERVAL_MINUTES * 60 * 1000;

  logger.info(`Starting scheduled monitoring. Will check every ${env.CHECK_INTERVAL_MINUTES} minutes.`);
  if (env.SONARR_ENABLED) logger.info('Sonarr TV sync enabled.');
  if (env.RADARR_CLEANUP_ENABLED) logger.info('Radarr cleanup enabled.');
  if (env.SONARR_CLEANUP_ENABLED) logger.info('Sonarr cleanup enabled.');

  run().catch(logger.error);

  setInterval(async () => {
    try {
      await run();
    } catch (e) {
      logger.error(e);
    }
  }, intervalMs);
}

async function run() {
  const movies = await fetchMoviesFromUrl(env.LETTERBOXD_URL);
  await upsertMovies(movies);
  if (env.SONARR_ENABLED) await upsertShows(movies);
  if (env.RADARR_CLEANUP_ENABLED) await runCleanup();
  if (env.SONARR_CLEANUP_ENABLED) await runSonarrCleanup();
  fs.writeFileSync(`${DATA_DIR}/.last-run`, new Date().toISOString());
}

export async function main() {
  startScheduledMonitoring();
}

export { startScheduledMonitoring };

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(logger.error);
}
