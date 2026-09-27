import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buluver-repo-test-'));
process.env.BULUVER_DATA_DIR = tmpDir;
process.env.BULUVER_DB_PATH = path.join(tmpDir, 'test.db');

// Import after env vars are set
const {
  DocumentRepository,
  FolderStore,
  SettingsStore,
  DatabaseService
} = await import('../src/services/database.js');

describe('SettingsStore', () => {
  test('sets, gets, and overrides configuration values', () => {
    SettingsStore.set('test_key', 'test_value');
    assert.equal(SettingsStore.get('test_key'), 'test_value');
    assert.equal(SettingsStore.get('non_existent', 'default_val'), 'default_val');

    SettingsStore.set('test_key', 'updated_value');
    assert.equal(SettingsStore.get('test_key'), 'updated_value');
  });

  test('lists all settings and deletes keys', () => {
    SettingsStore.set('k1', 'v1');
    SettingsStore.set('k2', 'v2');
    const all = SettingsStore.getAll();
    assert.equal(all['k1'], 'v1');
    assert.equal(all['k2'], 'v2');

    SettingsStore.delete('k1');
    assert.equal(SettingsStore.get('k1'), '');
  });
});

describe('FolderStore', () => {
  test('adds and lists monitored folders', () => {
    FolderStore.addFolder('/tmp/legal-docs');
    FolderStore.addFolder('/tmp/contracts');

    const folders = FolderStore.getFolders();
    assert.ok(folders.some((f) => f.path === '/tmp/legal-docs'));
    assert.ok(folders.some((f) => f.path === '/tmp/contracts'));
    assert.equal(FolderStore.count(), 2);
  });

  test('auto-collapses child folders when parent folder is added', () => {
    // Add child folders first
    FolderStore.addFolder('/tmp/archive/child1');
    FolderStore.addFolder('/tmp/archive/child2');
    assert.ok(FolderStore.getFolders().some((f) => f.path === '/tmp/archive/child1'));

    // Now add the parent folder
    const res = FolderStore.addFolder('/tmp/archive');
    assert.equal(res.added, true);
    assert.ok(res.prunedChildren?.includes('/tmp/archive/child1'));
    assert.ok(res.prunedChildren?.includes('/tmp/archive/child2'));

    // Children should no longer be in the folders table
    const folders = FolderStore.getFolders();
    assert.ok(folders.some((f) => f.path === '/tmp/archive'));
    assert.ok(!folders.some((f) => f.path === '/tmp/archive/child1'));
    assert.ok(!folders.some((f) => f.path === '/tmp/archive/child2'));
  });

  test('ignores adding child folder when parent is already monitored', () => {
    const res = FolderStore.addFolder('/tmp/archive/subfolder3');
    assert.equal(res.added, false);
    assert.equal(res.parentPath, '/tmp/archive');
  });

  test('safe deregister with keepFiles=true preserves files and chunks', () => {
    // Add a folder and document
    FolderStore.addFolder('/tmp/safetest');
    DocumentRepository.saveDocument({
      path: '/tmp/safetest/doc1.txt',
      filename: 'doc1.txt',
      extension: '.txt',
      mtime: Date.now(),
      size: 100,
      body: 'Güvenli kaldırma testi belgesi'
    });

    // Remove folder with keepFiles: true
    FolderStore.removeFolder('/tmp/safetest', { keepFiles: true });

    // Folder is removed from registry
    assert.ok(!FolderStore.getFolders().some((f) => f.path === '/tmp/safetest'));

    // Document and its FTS entry are still preserved!
    const doc = DocumentRepository.getDocument('/tmp/safetest/doc1.txt');
    assert.ok(doc);
    assert.equal(doc.filename, 'doc1.txt');
    const fts = DocumentRepository.queryFts('güvenli*');
    assert.ok(fts.length > 0);
  });
});

describe('DocumentRepository', () => {
  test('saves a complete document atomically across tables (files, FTS, trigram, metadata, chunks)', () => {
    const dummyEmbedding = new Float32Array(384).fill(0.1);

    DocumentRepository.saveDocument({
      path: '/tmp/legal-docs/dava_dilekcesi.udf',
      filename: 'dava_dilekcesi.udf',
      extension: '.udf',
      mtime: 1700000000000,
      size: 4096,
      body: 'Davacı müvekkil adına kira bedelinin tespiti talebidir.',
      metadata: {
        court_name: 'İstanbul 1. Sulh Hukuk Mahkemesi',
        case_number: '2024/100',
        plaintiff: 'Ahmet Yılmaz',
        defendant: 'Mehmet Demir',
        tags: ['kira', 'sulh']
      },
      chunks: [
        {
          chunkIndex: 0,
          text: 'Davacı müvekkil adına kira bedelinin tespiti talebidir.',
          embedding: dummyEmbedding
        }
      ]
    });

    const doc = DocumentRepository.getDocument('/tmp/legal-docs/dava_dilekcesi.udf');
    assert.ok(doc);
    assert.equal(doc.filename, 'dava_dilekcesi.udf');
    assert.equal(doc.metadata?.court_name, 'İstanbul 1. Sulh Hukuk Mahkemesi');
    assert.equal(doc.metadata?.case_number, '2024/100');
    assert.deepEqual(doc.metadata?.tags, ['kira', 'sulh']);
  });

  test('satisfies SearchRetriever seam for FTS and Trigram queries', () => {
    const ftsResults = DocumentRepository.queryFts('kira*');
    assert.ok(ftsResults.length > 0);
    assert.equal(ftsResults[0].filename, 'dava_dilekcesi.udf');

    const trigramResults = DocumentRepository.queryTrigram('bedel');
    assert.ok(trigramResults.length > 0);
    assert.equal(trigramResults[0].filename, 'dava_dilekcesi.udf');
  });

  test('batch saves multiple documents in one atomic transaction', () => {
    DocumentRepository.saveDocumentsBatch([
      {
        path: '/tmp/legal-docs/ihtarname.docx',
        filename: 'ihtarname.docx',
        extension: '.docx',
        mtime: 1700000001000,
        size: 2048,
        body: 'İşbu ihtarname ile kira akdi feshedilmiştir.'
      },
      {
        path: '/tmp/legal-docs/cevap_dilekcesi.udf',
        filename: 'cevap_dilekcesi.udf',
        extension: '.udf',
        mtime: 1700000002000,
        size: 3000,
        body: 'Cevap dilekçemiz ekte sunulmuştur.'
      }
    ]);

    const stats = DocumentRepository.getKnownFileStats('/tmp/legal-docs');
    assert.equal(stats.size, 3);
    assert.ok(stats.has('/tmp/legal-docs/ihtarname.docx'));
    assert.ok(stats.has('/tmp/legal-docs/cevap_dilekcesi.udf'));
  });

  test('prunes missing files under a monitored folder root', () => {
    const keepPaths = new Set([
      '/tmp/legal-docs/dava_dilekcesi.udf',
      '/tmp/legal-docs/ihtarname.docx'
    ]);

    const removed = DocumentRepository.pruneMissing('/tmp/legal-docs', keepPaths);
    assert.equal(removed, 1); // cevap_dilekcesi.udf removed

    const doc = DocumentRepository.getDocument('/tmp/legal-docs/cevap_dilekcesi.udf');
    assert.equal(doc, undefined);
  });

  test('updates document metadata by file path without exposing internal numeric IDs', () => {
    DocumentRepository.updateMetadata('/tmp/legal-docs/ihtarname.docx', {
      summary: 'Fesih ihtarnamesi özeti',
      tags: ['ihtar', 'fesih']
    });

    const doc = DocumentRepository.getDocument('/tmp/legal-docs/ihtarname.docx');
    assert.ok(doc);
    assert.equal(doc.metadata?.summary, 'Fesih ihtarnamesi özeti');
    assert.deepEqual(doc.metadata?.tags, ['ihtar', 'fesih']);
  });

  test('removes monitored folder with full cascade to files, FTS, and metadata', () => {
    FolderStore.removeFolder('/tmp/legal-docs');
    const remainingDocs = DocumentRepository.getKnownFileStats('/tmp/legal-docs');
    assert.equal(remainingDocs.size, 0);

    const ftsResults = DocumentRepository.queryFts('kira*');
    assert.equal(ftsResults.length, 0);
  });
});
