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

const mockFetch = jest.fn();
global.fetch = mockFetch;

import fs from 'fs';
import { runCleanup } from './cleanup';
import { getMovieByTmdbId, deleteMovie } from './radarr';
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
