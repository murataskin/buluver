import { type SearchResult, type FileMetadata } from './database.js';
import { generateEmbedding, isEmbeddingsEnabled } from './embeddings.js';

export type SearchMode = 'keyword' | 'semantic' | 'hybrid' | 'infix';

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  documentType?: string;
  caseKind?: string;
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  degraded?: boolean;
  degradedReason?: string;
  count: number;
  results: SearchResult[];
}

export interface RetrieverItem {
  id: number;
  path: string;
  filename: string;
  snippet: string;
  score: number;
}

export interface SearchRetriever {
  queryFts(ftsQuery: string, limit: number): Promise<RetrieverItem[]> | RetrieverItem[];
  queryTrigram(cleanQuery: string, limit: number): Promise<RetrieverItem[]> | RetrieverItem[];
  queryVector(embedding: Float32Array, limit: number): Promise<RetrieverItem[]> | RetrieverItem[];
  attachMetadata(results: SearchResult[]): Promise<void> | void;
}

export type Embedder = (text: string) => Promise<Float32Array>;

/**
 * Normalizes text for Turkish search: NFC normalization and locale-aware lowercase.
 * Guarantees correct upper/lower mapping for Turkish characters like I/ı and İ/i.
 */
export function normalizeTurkishForSearch(text: string): string {
  if (!text) return '';
  return text.normalize('NFC').toLocaleLowerCase('tr-TR');
}

/**
 * Generates a clean, word-boundary-aware snippet centered around the user query match.
 * Prevents truncating words in half and provides natural context window.
 */
export function generateCleanSnippet(
  content: string,
  userQuery: string,
  budget = 180,
  highlightOpen = '<b>',
  highlightClose = '</b>'
): string {
  if (!content || !content.trim()) {
    return '';
  }
  const cleanContent = content.normalize('NFC').replace(/[\r\n\t\s]+/g, ' ').trim();
  const cleanQuery = userQuery ? userQuery.normalize('NFC').trim() : '';
  if (!cleanQuery) {
    return cleanContent.length > budget ? cleanContent.substring(0, budget) + '…' : cleanContent;
  }

  const lowerContentTr = cleanContent.toLocaleLowerCase('tr-TR');
  const lowerQueryTr = cleanQuery.toLocaleLowerCase('tr-TR');
  let matchIndex = lowerContentTr.indexOf(lowerQueryTr);
  let matchLength = cleanQuery.length;

  if (matchIndex === -1) {
    const lowerContentStd = cleanContent.toLowerCase();
    const lowerQueryStd = cleanQuery.toLowerCase();
    matchIndex = lowerContentStd.indexOf(lowerQueryStd);
  }

  if (matchIndex === -1) {
    if (cleanContent.length <= budget) {
      return cleanContent;
    }
    const endSpace = cleanContent.lastIndexOf(' ', budget);
    const end = endSpace > 0 ? endSpace : budget;
    return cleanContent.substring(0, end) + '…';
  }

  const matchStart = matchIndex;
  const matchEnd = matchIndex + matchLength;
  const matchedText = cleanContent.substring(matchStart, matchEnd);

  const remainingBudget = Math.max(0, budget - matchLength);
  const leftBudget = Math.floor(remainingBudget * 0.45);
  const rightBudget = remainingBudget - leftBudget;

  let rawStart = Math.max(0, matchStart - leftBudget);
  let rawEnd = Math.min(cleanContent.length, matchEnd + rightBudget);

  if (matchStart - leftBudget < 0) {
    const extra = leftBudget - matchStart;
    rawEnd = Math.min(cleanContent.length, rawEnd + extra);
  } else if (matchEnd + rightBudget > cleanContent.length) {
    const extra = matchEnd + rightBudget - cleanContent.length;
    rawStart = Math.max(0, rawStart - extra);
  }

  let start = rawStart;
  if (start > 0) {
    const spaceAfter = cleanContent.indexOf(' ', start);
    if (spaceAfter !== -1 && spaceAfter < matchStart) {
      start = spaceAfter + 1;
    }
  }

  let end = rawEnd;
  if (end < cleanContent.length) {
    const spaceBefore = cleanContent.lastIndexOf(' ', end);
    if (spaceBefore !== -1 && spaceBefore > matchEnd) {
      end = spaceBefore;
    }
  }

  const leftPart = cleanContent.substring(start, matchStart);
  const rightPart = cleanContent.substring(matchEnd, end);
  const hasLeftEllipsis = start > 0;
  const hasRightEllipsis = end < cleanContent.length;

  return `${hasLeftEllipsis ? '…' : ''}${leftPart}${highlightOpen}${matchedText}${highlightClose}${rightPart}${hasRightEllipsis ? '…' : ''}`;
}

/**
 * Sanitizes and normalizes a user search query into valid SQLite FTS5 MATCH syntax.
 * Balances quotes, inserts AND operators between adjacent tokens, and supports negation.
 */
export function parseSearchQuery(query: string): string {
  let quoteCount = (query.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    query += '"';
  }

  const tokenRegex = /(-?"[^"]+")|(-?[^\s"()]+)|(OR|AND|NOT|\(|\))/gi;
  const tokens: string[] = [];
  let match;
  while ((match = tokenRegex.exec(query)) !== null) {
    tokens.push(match[0]);
  }

  if (tokens.length === 0) return '';

  const parsedTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const upperToken = token.toUpperCase();

    if (upperToken === 'OR' || upperToken === 'AND' || upperToken === 'NOT') {
      if (parsedTokens.length === 0) continue;
      const lastToken = parsedTokens[parsedTokens.length - 1].toUpperCase();
      if (lastToken === 'AND' || lastToken === 'OR' || lastToken === 'NOT') {
        continue;
      }
      parsedTokens.push(upperToken);
    } else if (token === '(' || token === ')') {
      parsedTokens.push(token);
    } else {
      if (token.startsWith('-')) {
        const actualTerm = token.slice(1);
        if (actualTerm.length > 0) {
          if (parsedTokens.length > 0) {
            const lastToken = parsedTokens[parsedTokens.length - 1].toUpperCase();
            if (lastToken !== 'NOT' && lastToken !== 'AND' && lastToken !== 'OR') {
              parsedTokens.push('NOT');
            }
          } else {
            parsedTokens.push('NOT');
          }

          if (actualTerm.startsWith('"')) {
            parsedTokens.push(actualTerm);
          } else {
            parsedTokens.push(actualTerm.endsWith('*') ? actualTerm : `${actualTerm}*`);
          }
        }
      } else {
        let formattedTerm = token;
        if (!token.startsWith('"')) {
          formattedTerm = token.endsWith('*') ? token : `${token}*`;
        }

        if (parsedTokens.length > 0) {
          const lastToken = parsedTokens[parsedTokens.length - 1];
          const lastUpper = lastToken.toUpperCase();
          if (
            lastToken !== '(' &&
            lastUpper !== 'AND' &&
            lastUpper !== 'OR' &&
            lastUpper !== 'NOT'
          ) {
            parsedTokens.push('AND');
          }
        }
        parsedTokens.push(formattedTerm);
      }
    }
  }

  while (parsedTokens.length > 0) {
    const last = parsedTokens[parsedTokens.length - 1].toUpperCase();
    if (last === 'AND' || last === 'OR' || last === 'NOT') {
      parsedTokens.pop();
    } else {
      break;
    }
  }

  let openCount = 0;
  const balancedTokens: string[] = [];
  for (const token of parsedTokens) {
    if (token === '(') {
      openCount++;
      balancedTokens.push(token);
    } else if (token === ')') {
      if (openCount > 0) {
        openCount--;
        balancedTokens.push(token);
      }
    } else {
      balancedTokens.push(token);
    }
  }
  while (openCount > 0) {
    balancedTokens.push(')');
    openCount--;
  }

  return balancedTokens.join(' ');
}

import { DocumentRepository } from './document-repository.js';

/**
 * Default SQLite retriever adapter connecting to DocumentRepository.
 */
export const defaultSqliteRetriever: SearchRetriever = {
  queryFts(ftsQuery: string, limit: number): RetrieverItem[] {
    return DocumentRepository.queryFts(ftsQuery, limit);
  },
  queryTrigram(cleanQuery: string, limit: number): RetrieverItem[] {
    return DocumentRepository.queryTrigram(cleanQuery, limit);
  },
  queryVector(embedding: Float32Array, limit: number): RetrieverItem[] {
    return DocumentRepository.queryVector(embedding, limit);
  },
  attachMetadata(results: SearchResult[]): void {
    DocumentRepository.attachMetadata(results);
  }
};

export interface SearchEngineDependencies {
  retriever?: SearchRetriever;
  embedder?: Embedder;
}

export interface SearchEngineContract {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  parseQuery(query: string): string;
}

/**
 * Creates a Search Engine instance with specified dependencies.
 */
export function createSearchEngine(deps: SearchEngineDependencies = {}): SearchEngineContract {
  const retriever = deps.retriever ?? defaultSqliteRetriever;
  const embedder = deps.embedder ?? generateEmbedding;

  return {
    parseQuery(query: string): string {
      return parseSearchQuery(query);
    },

    async search(rawQuery: string, options: SearchOptions = {}): Promise<SearchResponse> {
      const query = rawQuery.trim();
      const limit = options.limit && options.limit > 0 ? options.limit : 20;
      let requestedMode: SearchMode = options.mode || 'keyword';

      // 1. Infix / Trigram mode validation
      if (requestedMode === 'infix') {
        const clean = normalizeTurkishForSearch(query.replace(/["']/g, ' ')).replace(/\s+/g, ' ').trim();
        if (clean.length < 3) {
          return {
            query,
            mode: 'infix',
            count: 0,
            results: [],
            degraded: true,
            degradedReason: 'Trigram (infix) araması en az 3 karakter gerektirir.'
          };
        }

        const trigramItems = await retriever.queryTrigram(clean, limit);
        const results: SearchResult[] = trigramItems.map((item) => ({
          path: item.path,
          filename: item.filename,
          snippet: item.snippet,
          score: item.score,
          mode: 'infix'
        }));
        await retriever.attachMetadata(results);

        return {
          query,
          mode: 'infix',
          count: results.length,
          results
        };
      }

      // 2. Vector Embedding Generation with Graceful Fallback
      let queryEmbedding: Float32Array | undefined;
      let effectiveMode: SearchMode = requestedMode;
      let degraded = false;
      let degradedReason: string | undefined;

      if (requestedMode === 'semantic' || requestedMode === 'hybrid') {
        if (!deps.embedder && !isEmbeddingsEnabled()) {
          degraded = true;
          degradedReason = 'Vektör araması devre dışı bırakılmış. Arama anahtar kelime (FTS5) moduna yönlendirildi.';
          effectiveMode = 'keyword';
        } else {
          try {
            queryEmbedding = await embedder(query);
          } catch (err: any) {
            degraded = true;
            degradedReason = `Vektör embedding üretilemedi (${err?.message || err}). Keyword arama moduna düşüldü.`;
            effectiveMode = 'keyword';
          }
        }
      }

      // 3. Keyword Search (FTS5)
      const fetchLimit = (options.documentType || options.caseKind) ? Math.max(limit * 20, 200) : limit * 2;
      let ftsResults: RetrieverItem[] = [];
      const ftsQuery = parseSearchQuery(query);
      if (ftsQuery && (effectiveMode === 'keyword' || effectiveMode === 'hybrid')) {
        try {
          ftsResults = await retriever.queryFts(ftsQuery, fetchLimit);
        } catch (err) {
          console.error('[SearchEngine] FTS5 search query error:', err, 'Query was:', ftsQuery);
        }
      }

      // 4. Semantic Search
      let semanticResults: RetrieverItem[] = [];
      if (queryEmbedding && (effectiveMode === 'semantic' || effectiveMode === 'hybrid')) {
        try {
          semanticResults = await retriever.queryVector(queryEmbedding, fetchLimit);
        } catch (err) {
          console.error('[SearchEngine] Semantic vector search error:', err);
        }
      }

      // 5. Result Selection / RRF Fusion
      let merged: SearchResult[] = [];

      if (effectiveMode === 'keyword') {
        merged = ftsResults.map((r) => ({
          path: r.path,
          filename: r.filename,
          snippet: r.snippet,
          score: r.score,
          mode: 'keyword'
        }));
      } else if (effectiveMode === 'semantic') {
        merged = semanticResults.map((r) => ({
          path: r.path,
          filename: r.filename,
          snippet: r.snippet,
          score: r.score,
          mode: 'semantic'
        }));
      } else {
        // Hybrid: Reciprocal Rank Fusion (RRF)
        const ftsRankMap = new Map<number, number>();
        ftsResults.forEach((r, idx) => ftsRankMap.set(r.id, idx + 1));

        const semRankMap = new Map<number, number>();
        semanticResults.forEach((r, idx) => semRankMap.set(r.id, idx + 1));

        const allIds = new Set<number>([
          ...ftsResults.map((r) => r.id),
          ...semanticResults.map((r) => r.id)
        ]);

        const rrfResults: { id: number; path: string; filename: string; snippet: string; score: number }[] = [];

        for (const id of allIds) {
          const ftsRank = ftsRankMap.get(id);
          const semRank = semRankMap.get(id);

          const rrfFts = ftsRank ? 1 / (60 + ftsRank) : 0;
          const rrfSem = semRank ? 1 / (60 + semRank) : 0;
          const score = rrfFts + rrfSem;

          let snippet = '';
          const ftsItem = ftsResults.find((r) => r.id === id);
          const semItem = semanticResults.find((r) => r.id === id);

          if (ftsItem && ftsItem.snippet) {
            snippet = ftsItem.snippet;
          } else if (semItem && semItem.snippet) {
            snippet = semItem.snippet;
          }

          const item = ftsItem || semItem;
          if (item) {
            rrfResults.push({
              id,
              path: item.path,
              filename: item.filename,
              snippet,
              score
            });
          }
        }

        rrfResults.sort((a, b) => b.score - a.score);
        merged = rrfResults.map((r) => ({
          path: r.path,
          filename: r.filename,
          snippet: r.snippet,
          score: r.score,
          mode: 'hybrid'
        }));
      }

      let candidateResults = merged;
      if (options.documentType || options.caseKind) {
        const preSlice = candidateResults.slice(0, Math.max(limit * 20, 200));
        await retriever.attachMetadata(preSlice);

        candidateResults = preSlice.filter((r) => {
          if (options.documentType) {
            const docType = (r.metadata?.document_type || '').toLocaleLowerCase('tr-TR');
            const targetType = options.documentType.toLocaleLowerCase('tr-TR');
            if (!docType.includes(targetType)) return false;
          }
          if (options.caseKind) {
            const kind = (r.metadata?.case_kind || '').toUpperCase();
            const targetKind = options.caseKind.toUpperCase();
            if (kind !== targetKind) return false;
          }
          return true;
        });
      }

      const finalResults = candidateResults.slice(0, limit);
      if (!options.documentType && !options.caseKind) {
        await retriever.attachMetadata(finalResults);
      }

      return {
        query,
        mode: effectiveMode,
        degraded,
        degradedReason,
        count: finalResults.length,
        results: finalResults
      };
    }
  };
}

export const SearchEngine = createSearchEngine();
export type { SearchResult, FileMetadata };
