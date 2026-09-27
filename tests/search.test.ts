import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSearchEngine,
  parseSearchQuery,
  type SearchRetriever,
  type RetrieverItem,
  type SearchResult
} from '../src/services/search.js';

describe('Search Query Normalizer (parseSearchQuery)', () => {
  test('balances trailing unclosed quotes', () => {
    const parsed = parseSearchQuery('"kira tespit davasi');
    assert.match(parsed, /^"kira tespit davasi"/);
  });

  test('inserts AND between adjacent unquoted search terms', () => {
    const parsed = parseSearchQuery('tahliye ihtarname');
    assert.equal(parsed, 'tahliye* AND ihtarname*');
  });

  test('formats negation into FTS5 NOT operator', () => {
    const parsed = parseSearchQuery('tahliye -ticari');
    assert.equal(parsed, 'tahliye* NOT ticari*');
  });

  test('preserves explicit Boolean operators and group parentheses', () => {
    const parsed = parseSearchQuery('(kira OR tahliye) AND fesih');
    assert.equal(parsed, '( kira* OR tahliye* ) AND fesih*');
  });
});

describe('Search Engine Seam (createSearchEngine)', () => {
  function createMockRetriever(overrides: Partial<SearchRetriever> = {}): SearchRetriever {
    return {
      queryFts: () => [
        { id: 1, path: '/docs/doc1.udf', filename: 'doc1.udf', snippet: 'tahliye talebi', score: -0.5 }
      ],
      queryTrigram: () => [
        { id: 2, path: '/docs/doc2.docx', filename: 'doc2.docx', snippet: 'ihtarnamedir', score: -0.8 }
      ],
      queryVector: () => [
        { id: 3, path: '/docs/doc3.pdf', filename: 'doc3.pdf', snippet: 'kira artisi', score: 0.85 }
      ],
      attachMetadata: (results: SearchResult[]) => {
        for (const r of results) {
          r.metadata = { court_name: 'Istanbul 2. Sulh Hukuk' };
        }
      },
      ...overrides
    };
  }

  test('executes keyword search through FTS retriever', async () => {
    let ftsQueriedWith = '';
    const retriever = createMockRetriever({
      queryFts: (ftsQuery) => {
        ftsQueriedWith = ftsQuery;
        return [{ id: 10, path: '/test.udf', filename: 'test.udf', snippet: 'match', score: -1.2 }];
      }
    });

    const engine = createSearchEngine({ retriever });
    const response = await engine.search('tahliye davasi', { mode: 'keyword', limit: 5 });

    assert.equal(response.mode, 'keyword');
    assert.equal(response.degraded, false);
    assert.equal(response.count, 1);
    assert.equal(response.results[0].filename, 'test.udf');
    assert.equal(response.results[0].metadata?.court_name, 'Istanbul 2. Sulh Hukuk');
    assert.equal(ftsQueriedWith, 'tahliye* AND davasi*');
  });

  test('validates minimum character length for infix/trigram search', async () => {
    let trigramCalled = false;
    const retriever = createMockRetriever({
      queryTrigram: () => {
        trigramCalled = true;
        return [];
      }
    });

    const engine = createSearchEngine({ retriever });
    const response = await engine.search('ab', { mode: 'infix' });

    assert.equal(response.mode, 'infix');
    assert.equal(response.count, 0);
    assert.equal(response.degraded, true);
    assert.match(response.degradedReason!, /en az 3 karakter/);
    assert.equal(trigramCalled, false, 'Should not query trigram table for queries under 3 chars');
  });

  test('executes valid infix/trigram search', async () => {
    let queriedClean = '';
    const retriever = createMockRetriever({
      queryTrigram: (clean) => {
        queriedClean = clean;
        return [{ id: 5, path: '/t.udf', filename: 't.udf', snippet: 'tahliye', score: -1 }];
      }
    });

    const engine = createSearchEngine({ retriever });
    const response = await engine.search('"hukuk"', { mode: 'infix' });

    assert.equal(response.mode, 'infix');
    assert.equal(response.count, 1);
    assert.equal(queriedClean, 'hukuk');
    assert.equal(response.results[0].filename, 't.udf');
  });

  test('executes semantic vector search using provided embedder', async () => {
    let embeddedText = '';
    const mockEmbedder = async (text: string) => {
      embeddedText = text;
      return new Float32Array([0.1, 0.2, 0.3]);
    };

    let vectorQueried = false;
    const retriever = createMockRetriever({
      queryVector: (emb) => {
        vectorQueried = true;
        assert.equal(emb.length, 3);
        return [{ id: 7, path: '/sem.udf', filename: 'sem.udf', snippet: 'sem match', score: 0.92 }];
      }
    });

    const engine = createSearchEngine({ retriever, embedder: mockEmbedder });
    const response = await engine.search('kira uyusmazligi', { mode: 'semantic' });

    assert.equal(embeddedText, 'kira uyusmazligi');
    assert.equal(vectorQueried, true);
    assert.equal(response.mode, 'semantic');
    assert.equal(response.results[0].score, 0.92);
  });

  test('combines FTS and vector results in hybrid mode using RRF ranking', async () => {
    const mockEmbedder = async () => new Float32Array([0.5, 0.5]);
    const retriever = createMockRetriever({
      queryFts: () => [
        { id: 100, path: '/doc100.udf', filename: 'doc100.udf', snippet: 'fts snippet', score: -1.0 },
        { id: 200, path: '/doc200.udf', filename: 'doc200.udf', snippet: 'fts only', score: -2.0 }
      ],
      queryVector: () => [
        { id: 100, path: '/doc100.udf', filename: 'doc100.udf', snippet: 'vec snippet', score: 0.9 },
        { id: 300, path: '/doc300.udf', filename: 'doc300.udf', snippet: 'vec only', score: 0.8 }
      ]
    });

    const engine = createSearchEngine({ retriever, embedder: mockEmbedder });
    const response = await engine.search('tahliye davasi', { mode: 'hybrid' });

    assert.equal(response.mode, 'hybrid');
    assert.equal(response.results.length, 3);
    // doc100 matched in both FTS (rank 1) and Vector (rank 1), so RRF score is highest: (1/61) + (1/61)
    assert.equal(response.results[0].filename, 'doc100.udf');
    assert.ok(response.results[0].score! > response.results[1].score!);
  });

  test('gracefully degrades to keyword search when embedder throws', async () => {
    const failingEmbedder = async () => {
      throw new Error('CUDA out of memory / model missing');
    };

    const retriever = createMockRetriever({
      queryFts: () => [
        { id: 1, path: '/fallback.udf', filename: 'fallback.udf', snippet: 'fallback snippet', score: -0.1 }
      ]
    });

    const engine = createSearchEngine({ retriever, embedder: failingEmbedder });
    const response = await engine.search('tahliye', { mode: 'hybrid' });

    assert.equal(response.mode, 'keyword', 'Effective mode should degrade to keyword');
    assert.equal(response.degraded, true);
    assert.match(response.degradedReason!, /CUDA out of memory/);
    assert.equal(response.count, 1);
    assert.equal(response.results[0].filename, 'fallback.udf');
  });

  test('gracefully degrades when embeddings are globally disabled in settings', async () => {
    const { setEmbeddingsEnabled } = await import('../src/services/embeddings.js');
    setEmbeddingsEnabled(false);

    const retriever = createMockRetriever({
      queryFts: () => [
        { id: 1, path: '/fallback.udf', filename: 'fallback.udf', snippet: 'fts match', score: -0.1 }
      ]
    });

    // No custom embedder passed -> uses default which checks isEmbeddingsEnabled()
    const engine = createSearchEngine({ retriever });
    const response = await engine.search('tahliye', { mode: 'semantic' });

    assert.equal(response.mode, 'keyword');
    assert.equal(response.degraded, true);
    assert.match(response.degradedReason!, /Vektör araması devre dışı/);
    assert.equal(response.count, 1);
  });
});
