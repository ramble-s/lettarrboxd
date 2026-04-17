require('dotenv').config();


import env from './util/env';
import logger from './util/logger';
import { fetchMoviesFromUrl } from './scraper';
import { upsertMovies } from './api/radarr';
import { upsertShows } from './api/sonarr';
import { runCleanup } from './api/cleanup';

function startScheduledMonitoring(): void {
  const intervalMs = env.CHECK_INTERVAL_MINUTES * 60 * 1000;

  logger.info(`Starting scheduled monitoring. Will check every ${env.CHECK_INTERVAL_MINUTES} minutes.`);
  if (env.SONARR_ENABLED) logger.info('Sonarr TV sync enabled.');
  if (env.LETTERBOXD_CLEANUP_ENABLED) logger.info('Letterboxd cleanup enabled.');

  run();

  setInterval(async () => {
    await run();
  }, intervalMs);
}

async function run() {
  const movies = await fetchMoviesFromUrl(env.LETTERBOXD_URL);
  await upsertMovies(movies);
  if (env.SONARR_ENABLED) await upsertShows(movies);
  if (env.LETTERBOXD_CLEANUP_ENABLED) await runCleanup();
}

export async function main() {
  startScheduledMonitoring();
}

export { startScheduledMonitoring };

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(logger.error);
}