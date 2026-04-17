jest.mock('fs');
jest.mock('../util/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockEnv = {
  LETTERBOXD_USERNAME: 'testuser',
  LETTERBOXD_CLEANUP_TAG: 'cleanup',
  DRY_RUN: false,
};
jest.mock('../util/env', () => mockEnv);

jest.mock('./radarr', () => ({
  getMovieByTmdbId: jest.fn(),
  deleteMovie: jest.fn(),
}));

jest.mock('./sonarr', () => ({
  findSeriesInSonarrByTmdbId: jest.fn(),
  deleteSeries: jest.fn(),
}));

jest.mock('../scraper/movie', () => ({
  getMovie: jest.fn(),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import fs from 'fs';
import { runCleanup, runSonarrCleanup } from './cleanup';
import { getMovieByTmdbId, deleteMovie } from './radarr';
import { findSeriesInSonarrByTmdbId, deleteSeries } from './sonarr';
import { getMovie } from '../scraper/movie';
import logger from '../util/logger';

const mockFs = fs as jest.Mocked<typeof fs>;

function makeRssXml(items: { slug: string; tmdbId: number }[]): string {
  const itemsXml = items.map(({ slug, tmdbId }) => `
    <item>
      <link>https://letterboxd.com/testuser/film/${slug}/diary/</link>
      <tmdb:movieId>${tmdbId}</tmdb:movieId>
    </item>
  `).join('');
  return `<rss>${itemsXml}</rss>`;
}

describe('cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.DRY_RUN = false;
    mockFs.readFileSync.mockImplementation((path) => {
      if (String(path).endsWith('deleted.json')) return '[]';
      throw new Error('unexpected readFileSync');
    });
    mockFs.writeFileSync.mockImplementation(() => {});
  });

  it('returns early when RSS has no entries', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<rss></rss>',
    });
    await runCleanup();
    expect(getMovieByTmdbId).not.toHaveBeenCalled();
  });

  it('skips already-processed slugs', async () => {
    mockFs.readFileSync.mockReturnValueOnce(JSON.stringify(['already-seen']));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeRssXml([{ slug: 'already-seen', tmdbId: 1 }]),
    });
    await runCleanup();
    expect(getMovieByTmdbId).not.toHaveBeenCalled();
  });

  it('skips entries without the cleanup tag', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'the-film', tmdbId: 42 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html>no tag here</html>' });
    await runCleanup();
    expect(getMovieByTmdbId).not.toHaveBeenCalled();
  });

  it('deletes tagged movie from Radarr and persists slug', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'the-film', tmdbId: 42 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovieByTmdbId as jest.Mock).mockResolvedValueOnce({ id: 10, title: 'The Film' });
    (deleteMovie as jest.Mock).mockResolvedValueOnce(undefined);

    await runCleanup();

    expect(deleteMovie).toHaveBeenCalledWith(10, 'The Film');
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('deleted.json'),
      expect.stringContaining('the-film')
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('deleted: 1'));
  });

  it('persists slug when tagged but not in Radarr', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'missing-film', tmdbId: 99 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovieByTmdbId as jest.Mock).mockResolvedValueOnce(null);

    await runCleanup();

    expect(deleteMovie).not.toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not in Radarr'));
  });

  it('skips entry without tmdbId', async () => {
    const xml = `<rss><item><link>https://letterboxd.com/testuser/film/no-tmdb/</link></item></rss>`;
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => xml });
    await runCleanup();
    expect(getMovieByTmdbId).not.toHaveBeenCalled();
  });

  it('increments errors on diary page fetch failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'bad-film', tmdbId: 7 }]) })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await runCleanup();

    expect(getMovieByTmdbId).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('errors: 1'));
  });

  it('dry run skips delete and write', async () => {
    mockEnv.DRY_RUN = true;
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'dry-film', tmdbId: 5 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovieByTmdbId as jest.Mock).mockResolvedValueOnce({ id: 1, title: 'Dry Film' });

    await runCleanup();

    expect(deleteMovie).toHaveBeenCalled(); // deleteMovie handles DRY_RUN internally
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('sonarr cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.DRY_RUN = false;
    mockFs.readFileSync.mockImplementation((path) => {
      if (String(path).endsWith('deleted-sonarr.json')) return '[]';
      throw new Error('unexpected readFileSync');
    });
    mockFs.writeFileSync.mockImplementation(() => {});
  });

  it('returns early when RSS has no entries', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '<rss></rss>' });
    await runSonarrCleanup();
    expect(findSeriesInSonarrByTmdbId).not.toHaveBeenCalled();
  });

  it('skips already-processed slugs', async () => {
    mockFs.readFileSync.mockReturnValueOnce(JSON.stringify(['already-seen']));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeRssXml([{ slug: 'already-seen', tmdbId: 1 }]),
    });
    await runSonarrCleanup();
    expect(findSeriesInSonarrByTmdbId).not.toHaveBeenCalled();
  });

  it('skips entries without the cleanup tag', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'the-show', tmdbId: 42 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html>no tag here</html>' });
    await runSonarrCleanup();
    expect(getMovie).not.toHaveBeenCalled();
    expect(findSeriesInSonarrByTmdbId).not.toHaveBeenCalled();
  });

  it('skips tagged entries that are movies (no tvTmdbId)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'a-movie', tmdbId: 10 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovie as jest.Mock).mockResolvedValueOnce({ id: 1, name: 'A Movie', slug: '/film/a-movie/', tvTmdbId: null });
    await runSonarrCleanup();
    expect(findSeriesInSonarrByTmdbId).not.toHaveBeenCalled();
  });

  it('deletes tagged TV show and persists slug', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'the-show', tmdbId: 99 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovie as jest.Mock).mockResolvedValueOnce({ id: 1, name: 'The Show', slug: '/film/the-show/', tvTmdbId: '500' });
    (findSeriesInSonarrByTmdbId as jest.Mock).mockResolvedValueOnce({ id: 7, title: 'The Show' });
    (deleteSeries as jest.Mock).mockResolvedValueOnce(undefined);

    await runSonarrCleanup();

    expect(findSeriesInSonarrByTmdbId).toHaveBeenCalledWith('500');
    expect(deleteSeries).toHaveBeenCalledWith(7, 'The Show');
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('deleted-sonarr.json'),
      expect.stringContaining('the-show')
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('deleted: 1'));
  });

  it('persists slug when tagged but not in Sonarr', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'missing-show', tmdbId: 99 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovie as jest.Mock).mockResolvedValueOnce({ id: 1, name: 'Missing Show', slug: '/film/missing-show/', tvTmdbId: '500' });
    (findSeriesInSonarrByTmdbId as jest.Mock).mockResolvedValueOnce(null);

    await runSonarrCleanup();

    expect(deleteSeries).not.toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not in Sonarr'));
  });

  it('increments errors on diary page fetch failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'bad-show', tmdbId: 7 }]) })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await runSonarrCleanup();

    expect(getMovie).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('errors: 1'));
  });

  it('increments errors on film page fetch failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'bad-show', tmdbId: 7 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovie as jest.Mock).mockRejectedValueOnce(new Error('fetch failed'));

    await runSonarrCleanup();

    expect(findSeriesInSonarrByTmdbId).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('errors: 1'));
  });

  it('dry run skips delete and write', async () => {
    mockEnv.DRY_RUN = true;
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => makeRssXml([{ slug: 'dry-show', tmdbId: 5 }]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><a href="/tag/cleanup/">cleanup</a></html>' });
    (getMovie as jest.Mock).mockResolvedValueOnce({ id: 1, name: 'Dry Show', slug: '/film/dry-show/', tvTmdbId: '500' });
    (findSeriesInSonarrByTmdbId as jest.Mock).mockResolvedValueOnce({ id: 3, title: 'Dry Show' });

    await runSonarrCleanup();

    expect(deleteSeries).toHaveBeenCalled(); // deleteSeries handles DRY_RUN internally
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });
});
