const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockAxiosInstance),
}));

jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockEnv = {
  SONARR_API_URL: 'http://localhost:8989',
  SONARR_API_KEY: 'test-sonarr-key',
  SONARR_QUALITY_PROFILE: 'HD-1080p',
  TMDB_API_KEY: 'test-tmdb-key',
  DRY_RUN: false,
};

jest.mock('../util/env', () => mockEnv);

const mockFetch = jest.fn();
global.fetch = mockFetch;

import {
  getQualityProfileId,
  getRootFolder,
  getExistingTvdbIds,
  resolveTvdbId,
  addSeries,
  upsertShows,
} from './sonarr';
import logger from '../util/logger';

describe('sonarr API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getQualityProfileId', () => {
    it('returns profile ID when found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, name: 'SD' }, { id: 2, name: 'HD-1080p' }],
      });
      expect(await getQualityProfileId('HD-1080p')).toBe(2);
    });

    it('returns null when not found', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'SD' }] });
      expect(await getQualityProfileId('4K')).toBeNull();
    });

    it('returns null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));
      expect(await getQualityProfileId('HD-1080p')).toBeNull();
    });
  });

  describe('getRootFolder', () => {
    it('returns first root folder path', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, path: '/tv' }, { id: 2, path: '/tv2' }],
      });
      expect(await getRootFolder()).toBe('/tv');
    });

    it('returns null when empty', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      expect(await getRootFolder()).toBeNull();
    });

    it('returns null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));
      expect(await getRootFolder()).toBeNull();
    });
  });

  describe('getExistingTvdbIds', () => {
    it('returns a Set of tvdbIds', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ tvdbId: 100 }, { tvdbId: 200 }],
      });
      const result = await getExistingTvdbIds();
      expect(result).toBeInstanceOf(Set);
      expect(result.has(100)).toBe(true);
      expect(result.has(200)).toBe(true);
    });

    it('returns empty Set on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));
      const result = await getExistingTvdbIds();
      expect(result.size).toBe(0);
    });
  });

  describe('resolveTvdbId', () => {
    it('uses Bearer auth for JWT tokens', async () => {
      mockEnv.TMDB_API_KEY = 'eyJtest.token.here';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tvdb_id: 12345 }),
      });
      const result = await resolveTvdbId('999');
      expect(result).toBe(12345);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.themoviedb.org/3/tv/999/external_ids');
      expect(opts.headers['Authorization']).toMatch(/^Bearer eyJ/);
      expect(url).not.toContain('api_key');
    });

    it('uses query param for v3 keys', async () => {
      mockEnv.TMDB_API_KEY = 'abc123v3key';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tvdb_id: 99 }),
      });
      const result = await resolveTvdbId('42');
      expect(result).toBe(99);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('api_key=abc123v3key');
    });

    it('returns null on 404', async () => {
      mockEnv.TMDB_API_KEY = 'abc123';
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
      expect(await resolveTvdbId('1')).toBeNull();
    });

    it('returns null when tvdb_id missing', async () => {
      mockEnv.TMDB_API_KEY = 'abc123';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });
      expect(await resolveTvdbId('1')).toBeNull();
    });

    it('returns null on fetch error', async () => {
      mockEnv.TMDB_API_KEY = 'abc123';
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      expect(await resolveTvdbId('1')).toBeNull();
    });
  });

  describe('addSeries', () => {
    it('adds a series successfully', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Test Show', tvdbId: 300 }],
      });
      mockAxiosInstance.post.mockResolvedValueOnce({ data: {} });

      await addSeries(300, 2, '/tv');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v3/series',
        expect.objectContaining({
          qualityProfileId: 2,
          rootFolderPath: '/tv',
          monitored: true,
          seasonFolder: true,
          addOptions: { searchForMissingEpisodes: true, monitor: 'all' },
        })
      );
    });

    it('skips silently when lookup returns no results', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      await addSeries(300, 2, '/tv');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('skips silently on already-added 400', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Test Show', tvdbId: 300 }],
      });
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: { status: 400, data: 'This series has already been added' },
      });
      await expect(addSeries(300, 2, '/tv')).resolves.toBeUndefined();
    });

    it('respects DRY_RUN', async () => {
      mockEnv.DRY_RUN = true;
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Test Show', tvdbId: 300 }],
      });
      await addSeries(300, 2, '/tv');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN]'));
      mockEnv.DRY_RUN = false;
    });
  });

  describe('upsertShows', () => {
    it('returns early when no TV shows', async () => {
      await upsertShows([{ id: 1, name: 'Movie', slug: '/film/movie/' }]);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('skips shows already in Sonarr', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: [{ id: 1, name: 'HD-1080p' }] })
        .mockResolvedValueOnce({ data: [{ id: 1, path: '/tv' }] })
        .mockResolvedValueOnce({ data: [{ tvdbId: 500 }] });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tvdb_id: 500 }),
      });

      await upsertShows([{ id: 1, name: 'Show', slug: '/film/show/', tvTmdbId: '999' }]);

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('already in Sonarr'));
    });

    it('logs and returns (does not throw) when quality profile missing', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      await expect(
        upsertShows([{ id: 1, name: 'Show', slug: '/film/show/', tvTmdbId: '999' }])
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('quality profile'));
    });

    it('logs and returns (does not throw) when root folder missing', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: [{ id: 1, name: 'HD-1080p' }] })
        .mockResolvedValueOnce({ data: [] });
      await expect(
        upsertShows([{ id: 1, name: 'Show', slug: '/film/show/', tvTmdbId: '999' }])
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('root folder'));
    });
  });
});
