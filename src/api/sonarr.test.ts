const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
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
  DRY_RUN: false,
};

jest.mock('../util/env', () => mockEnv);

import {
  getQualityProfileId,
  getRootFolder,
  findSeriesInSonarrByTmdbId,
  addSeries,
  upsertShows,
  deleteSeries,
} from './sonarr';
import logger from '../util/logger';

describe('sonarr API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.DRY_RUN = false;
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

  describe('findSeriesInSonarrByTmdbId', () => {
    it('returns id+title when series is in Sonarr library (has id)', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 10, title: 'Cowboy Bebop', tvdbId: 76885 }],
      });
      const result = await findSeriesInSonarrByTmdbId('30991');
      expect(result).toEqual({ id: 10, title: 'Cowboy Bebop' });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/series/lookup?term=tmdb:30991');
    });

    it('returns null when series is not in library (no id in response)', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Breaking Bad', tvdbId: 81189 }], // no `id` field
      });
      expect(await findSeriesInSonarrByTmdbId('1396')).toBeNull();
    });

    it('returns null when lookup returns no results', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      expect(await findSeriesInSonarrByTmdbId('99999')).toBeNull();
    });

    it('returns null on error', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Network error'));
      expect(await findSeriesInSonarrByTmdbId('1396')).toBeNull();
    });
  });

  describe('addSeries', () => {
    it('adds a series when not in library', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Test Show', tvdbId: 300 }], // no `id` → not in library
      });
      mockAxiosInstance.post.mockResolvedValueOnce({ data: {} });

      await addSeries('999', 2, '/tv');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/api/v3/series/lookup?term=tmdb:999');
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

    it('skips silently when series already in library', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 10, title: 'Already Added', tvdbId: 300 }], // has `id`
      });
      await addSeries('999', 2, '/tv');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('already in Sonarr'));
    });

    it('skips silently when lookup returns no results', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      await addSeries('999', 2, '/tv');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('skips silently on already-added 400', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Test Show', tvdbId: 300 }],
      });
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: { status: 400, data: 'This series has already been added' },
      });
      await expect(addSeries('999', 2, '/tv')).resolves.toBeUndefined();
    });

    it('respects DRY_RUN', async () => {
      mockEnv.DRY_RUN = true;
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ title: 'Test Show', tvdbId: 300 }],
      });
      await addSeries('999', 2, '/tv');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN]'));
    });
  });

  describe('deleteSeries', () => {
    it('calls DELETE with deleteFiles=true', async () => {
      mockAxiosInstance.delete = jest.fn().mockResolvedValueOnce({});
      await deleteSeries(7, 'Test Show');
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
        '/api/v3/series/7?deleteFiles=true&addImportExclusion=false'
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Deleted from Sonarr'));
    });

    it('respects DRY_RUN', async () => {
      mockEnv.DRY_RUN = true;
      mockAxiosInstance.delete = jest.fn();
      await deleteSeries(7, 'Test Show');
      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN]'));
    });

    it('handles errors gracefully', async () => {
      mockAxiosInstance.delete = jest.fn().mockRejectedValueOnce(new Error('Network error'));
      await expect(deleteSeries(7, 'Test Show')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('upsertShows', () => {
    it('returns early when no TV shows', async () => {
      await upsertShows([{ id: 1, name: 'Movie', slug: '/film/movie/' }]);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('skips shows already in Sonarr (lookup returns id)', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: [{ id: 1, name: 'HD-1080p' }] })   // qualityprofile
        .mockResolvedValueOnce({ data: [{ id: 1, path: '/tv' }] })         // rootfolder
        .mockResolvedValueOnce({ data: [{ id: 10, title: 'Show', tvdbId: 500 }] }); // lookup: in library

      await upsertShows([{ id: 1, name: 'Show', slug: '/film/show/', tvTmdbId: '999' }]);

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('already in Sonarr'));
    });

    it('adds shows not yet in Sonarr (lookup returns no id)', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: [{ id: 1, name: 'HD-1080p' }] })
        .mockResolvedValueOnce({ data: [{ id: 1, path: '/tv' }] })
        .mockResolvedValueOnce({ data: [{ title: 'New Show', tvdbId: 500 }] }) // lookup: not in library
        .mockResolvedValueOnce({ data: [{ title: 'New Show', tvdbId: 500 }] }); // addSeries lookup
      mockAxiosInstance.post.mockResolvedValueOnce({ data: {} });

      await upsertShows([{ id: 1, name: 'New Show', slug: '/film/show/', tvTmdbId: '999' }]);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/api/v3/series', expect.any(Object));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('added: 1'));
    });

    it('counts not-found when lookup returns empty', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: [{ id: 1, name: 'HD-1080p' }] })
        .mockResolvedValueOnce({ data: [{ id: 1, path: '/tv' }] })
        .mockResolvedValueOnce({ data: [] }); // lookup: not found

      await upsertShows([{ id: 1, name: 'Ghost Show', slug: '/film/ghost/', tvTmdbId: '999' }]);

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not found: 1'));
    });

    it('logs and returns when quality profile missing', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      await expect(
        upsertShows([{ id: 1, name: 'Show', slug: '/film/show/', tvTmdbId: '999' }])
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('quality profile'));
    });

    it('logs and returns when root folder missing', async () => {
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
