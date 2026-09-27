import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSearchEngine,
  parseSearchQuery,
  normalizeTurkishForSearch,
  generateCleanSnippet,
  type SearchRetriever,
  type RetrieverItem,
  type SearchResult
} from '../src/services/search.js';
import { shouldSkipFile, shouldSkipDir } from '../src/services/walker.js';
import { DocumentParser } from '../src/services/doc-parser.js';

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

  test('filters search results by documentType and caseKind facets', async () => {
    const retriever = createMockRetriever({
      queryFts: () => [
        { id: 1, path: '/doc1.udf', filename: 'doc1.udf', snippet: 'dava dilekcesi', score: -0.1 },
        { id: 2, path: '/doc2.udf', filename: 'doc2.udf', snippet: 'cevap dilekcesi', score: -0.2 },
        { id: 3, path: '/doc3.udf', filename: 'doc3.udf', snippet: 'sorusturma takipsizlik', score: -0.3 }
      ],
      attachMetadata: (results: SearchResult[]) => {
        const metas: Record<string, any> = {
          '/doc1.udf': { document_type: 'Dava Dilekçesi', case_kind: 'ESAS' },
          '/doc2.udf': { document_type: 'Cevap Dilekçesi', case_kind: 'ESAS' },
          '/doc3.udf': { document_type: 'Takipsizlik Kararı', case_kind: 'SORUSTURMA' }
        };
        for (const r of results) {
          r.metadata = metas[r.path];
        }
      }
    });

    const engine = createSearchEngine({ retriever });
    
    // Filter by documentType
    const typeRes = await engine.search('dilekçe', { documentType: 'Cevap Dilekçesi' });
    assert.equal(typeRes.count, 1);
    assert.equal(typeRes.results[0].filename, 'doc2.udf');

    // Filter by caseKind
    const kindRes = await engine.search('karar', { caseKind: 'SORUSTURMA' });
    assert.equal(kindRes.count, 1);
    assert.equal(kindRes.results[0].filename, 'doc3.udf');
  });
});

describe('Turkish Search Normalization (normalizeTurkishForSearch)', () => {
  test('correctly normalizes uppercase dotted and dotless I according to Turkish locale', () => {
    assert.equal(normalizeTurkishForSearch('YARGITAY'), 'yargıtay');
    assert.equal(normalizeTurkishForSearch('İSTANBUL'), 'istanbul');
    assert.equal(normalizeTurkishForSearch('AĞIR CEZA'), 'ağır ceza');
    assert.equal(normalizeTurkishForSearch('ÇEKİŞMELİ'), 'çekişmeli');
  });

  test('preserves already lowercase Turkish characters and handles empty strings', () => {
    assert.equal(normalizeTurkishForSearch(''), '');
    assert.equal(normalizeTurkishForSearch('yargıtay'), 'yargıtay');
    assert.equal(normalizeTurkishForSearch('dilekçe'), 'dilekçe');
  });
});

describe('Word-Boundary-Aware Clean Snippets (generateCleanSnippet)', () => {
  const document = 'T.C. İSTANBUL 14. ASLİYE HUKUK MAHKEMESİ SAYIN HAKİMLİĞİNE DOSYA NO: 2024/142 Esas. DAVACI: Ahmet Yılmaz. KONU: Müvekkilin haksız fesih nedeniyle kıdem ve ihbar tazminatı taleplerinden ibarettir.';

  test('centers snippet on match and preserves original document casing', () => {
    const snippet = generateCleanSnippet(document, 'ihbar', 80);
    assert.match(snippet, /<b>ihbar<\/b>/);
    assert.match(snippet, /tazminatı/);
  });

  test('matches case-insensitively with Turkish characters while highlighting original casing', () => {
    const snippet = generateCleanSnippet(document, 'istanbul', 80);
    assert.match(snippet, /<b>İSTANBUL<\/b>/);
  });

  test('does not cut words in half at boundaries', () => {
    const snippet = generateCleanSnippet(document, '2024/142', 70);
    assert.match(snippet, /<b>2024\/142<\/b>/);
    // Should not end with half a word
    const plain = snippet.replace(/<[^>]+>/g, '').replace(/…/g, '').trim();
    assert.ok(!plain.endsWith('Esa'), 'Should snap to whole word boundary');
  });

  test('returns ellipsis prefix and suffix when budget is exceeded', () => {
    const snippet = generateCleanSnippet(document, 'kıdem', 50);
    assert.ok(snippet.startsWith('…'));
    assert.ok(snippet.endsWith('…'));
  });
});

describe('File Filter & Skip Logic (shouldSkipFile & DocumentParser.isSupported)', () => {
  test('rejects temporary Office lock files', () => {
    assert.equal(shouldSkipFile('~$Dilekce.docx'), true);
    assert.equal(DocumentParser.isSupported('/archive/~$Dilekce.docx'), false);
  });

  test('rejects macOS AppleDouble metadata and temporary files', () => {
    assert.equal(shouldSkipFile('._Dilekce.pdf'), true);
    assert.equal(DocumentParser.isSupported('/archive/._Dilekce.pdf'), false);
    assert.equal(shouldSkipFile('draft.tmp'), true);
    assert.equal(shouldSkipFile('.DS_Store'), true);
    assert.equal(shouldSkipFile('Thumbs.db'), true);
  });

  test('accepts valid legal documents', () => {
    assert.equal(shouldSkipFile('Dava_Dilekcesi.docx'), false);
    assert.equal(DocumentParser.isSupported('/archive/Dava_Dilekcesi.docx'), true);
    assert.equal(DocumentParser.isSupported('/archive/karar.udf'), true);
    assert.equal(DocumentParser.isSupported('/archive/mutaala.pdf'), true);
  });
});

describe('Directory Exclusion Logic (shouldSkipDir)', () => {
  test('rejects Python virtual environments (.venv, venv, env)', () => {
    assert.equal(shouldSkipDir('.venv'), true);
    assert.equal(shouldSkipDir('venv'), true);
    assert.equal(shouldSkipDir('env'), true);
    assert.equal(shouldSkipDir('VENV'), true);
  });

  test('rejects developer package and build directories (.cargo, node_modules, caches, logs)', () => {
    assert.equal(shouldSkipDir('.cargo'), true);
    assert.equal(shouldSkipDir('.rustup'), true);
    assert.equal(shouldSkipDir('node_modules'), true);
    assert.equal(shouldSkipDir('.cache'), true);
    assert.equal(shouldSkipDir('caches'), true);
    assert.equal(shouldSkipDir('logs'), true);
  });

  test('rejects macOS system directories and app bundles', () => {
    assert.equal(shouldSkipDir('Application Support'), true);
    assert.equal(shouldSkipDir('application support'), true);
    assert.equal(shouldSkipDir('Containers'), true);
    assert.equal(shouldSkipDir('containers'), true);
    assert.equal(shouldSkipDir('Slack.app'), true);
  });

  test('accepts valid user and legal archive folders', () => {
    assert.equal(shouldSkipDir('Dilekceler'), false);
    assert.equal(shouldSkipDir('Muvekkil_Arsivi'), false);
    assert.equal(shouldSkipDir('2024_Davalar'), false);
  });
});


