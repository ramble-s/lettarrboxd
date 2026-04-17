import { main, startScheduledMonitoring } from './index';
import * as scraperModule from './scraper';
import * as radarrModule from './api/radarr';
import * as sonarrModule from './api/sonarr';
import * as cleanupModule from './api/cleanup';

// Mock dependencies
jest.mock('./util/env', () => ({
  CHECK_INTERVAL_MINUTES: 10,
  LETTERBOXD_URL: 'https://letterboxd.com/user/watchlist',
  SONARR_ENABLED: false,
  LETTERBOXD_CLEANUP_ENABLED: false,
}));
jest.mock('./util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('./scraper');
jest.mock('./api/radarr');
jest.mock('./api/sonarr');
jest.mock('./api/cleanup');
jest.mock('fs', () => ({ writeFileSync: jest.fn() }));

describe('main application', () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setIntervalSpy = jest.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    setIntervalSpy.mockRestore();
  });

  describe('startScheduledMonitoring', () => {
    it('should run immediately and schedule interval', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for the immediate run to complete without advancing timers
      await Promise.resolve();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledTimes(1);
      expect(radarrModule.upsertMovies).toHaveBeenCalledTimes(1);

      // Verify setInterval was called with correct interval (10 minutes = 600000ms)
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 600000);
    });

    it('should fetch movies and upsert them during run', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Movie 1',
          slug: '/film/movie1/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
        {
          id: 2,
          name: 'Movie 2',
          slug: '/film/movie2/',
          tmdbId: '456',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for the immediate run to complete
      await Promise.resolve();

      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledWith(
        'https://letterboxd.com/user/watchlist'
      );
      expect(radarrModule.upsertMovies).toHaveBeenCalledWith(mockMovies);
    });

    it('should call fetchMoviesFromUrl and upsertMovies on interval', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();

      // Wait for immediate run
      await Promise.resolve();

      // Clear mocks to test interval callback
      jest.clearAllMocks();
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      // Fast-forward time by 10 minutes and run the interval callback
      jest.advanceTimersByTime(600000);
      await Promise.resolve();

      // Verify the interval callback also calls the functions
      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalledTimes(1);
      expect(radarrModule.upsertMovies).toHaveBeenCalledTimes(1);
    });
  });

  describe('main', () => {
    it('should call startScheduledMonitoring', async () => {
      const mockMovies = [
        {
          id: 1,
          name: 'Test Movie',
          slug: '/film/test-movie/',
          tmdbId: '123',
          imdbId: null,
          publishedYear: null,
        },
      ];

      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);

      await main();
      await Promise.resolve();

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(scraperModule.fetchMoviesFromUrl).toHaveBeenCalled();
      expect(radarrModule.upsertMovies).toHaveBeenCalled();
    });
  });

  describe('run with optional features enabled', () => {
    beforeEach(() => {
      const env = require('./util/env');
      env.SONARR_ENABLED = true;
      env.LETTERBOXD_CLEANUP_ENABLED = true;
    });

    afterEach(() => {
      const env = require('./util/env');
      env.SONARR_ENABLED = false;
      env.LETTERBOXD_CLEANUP_ENABLED = false;
    });

    it('should call upsertShows and runCleanup when enabled', async () => {
      const mockMovies = [{ id: 1, name: 'Show', slug: '/film/show/', tmdbId: null, tvTmdbId: '99' }];
      (scraperModule.fetchMoviesFromUrl as jest.Mock).mockResolvedValue(mockMovies);
      (radarrModule.upsertMovies as jest.Mock).mockResolvedValue(undefined);
      (sonarrModule.upsertShows as jest.Mock).mockResolvedValue(undefined);
      (cleanupModule.runCleanup as jest.Mock).mockResolvedValue(undefined);

      startScheduledMonitoring();
      // run() has 4 awaits deep (fetch → upsert → upsertShows → runCleanup)
      for (let i = 0; i < 6; i++) await Promise.resolve();

      expect(sonarrModule.upsertShows).toHaveBeenCalledWith(mockMovies);
      expect(cleanupModule.runCleanup).toHaveBeenCalled();
    });
  });
});
