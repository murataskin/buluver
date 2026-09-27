import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DocumentIngestor } from '../src/services/document-ingestor.js';

describe('DocumentIngestor', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buluver-ingest-test-'));

  test('ingests plain text document with legal heuristics extraction', async () => {
    const filePath = path.join(tmpDir, 'dava.txt');
    const content = `
      T.C. İSTANBUL 4. İŞ MAHKEMESİNE
      ESAS NO : 2024/1234 E.
      DAVACI  : Ahmet Yılmaz
      DAVALI  : ABC Lojistik A.Ş.
      KONU    : Kıdem ve ihbar tazminatı talebidir.
      
      Davamızın kabulüne karar verilmesini talep ederiz.
    `;
    fs.writeFileSync(filePath, content, 'utf-8');

    const doc = await DocumentIngestor.ingest({
      path: filePath,
      mtimeMs: 1700000000000,
      size: content.length
    });

    assert.equal(doc.filename, 'dava.txt');
    assert.equal(doc.extension, '.txt');
    assert.equal(doc.status, 'indexed');
    assert.ok(doc.body.includes('T.C. İSTANBUL 4. İŞ MAHKEMESİNE'));

    // Heuristics parsed directly in memory
    assert.ok(doc.metadata?.court_name?.includes('İŞ MAHKEMESİ'));
    assert.equal(doc.metadata?.case_number, '2024/1234 E.');
    assert.equal(doc.metadata?.plaintiff, 'Ahmet Yılmaz');
    assert.equal(doc.metadata?.defendant, 'ABC Lojistik A.Ş.');
    assert.ok(doc.metadata?.document_type?.includes('Kıdem'));
  });

  test('generates chunk embeddings using mock embedder seam', async () => {
    const dummyText = 'Madde 1: İşbu sözleşme taraflar arasındaki hizmet ilişkisini düzenler. '.repeat(10);
    const filePath = path.join(tmpDir, 'sozlesme.txt');
    fs.writeFileSync(filePath, dummyText, 'utf-8');

    let embedCallCount = 0;
    const mockEmbedder = async (text: string) => {
      embedCallCount++;
      return new Float32Array([0.1, 0.2, 0.3]);
    };

    const doc = await DocumentIngestor.ingest(
      {
        path: filePath,
        mtimeMs: 1700000000000,
        size: dummyText.length
      },
      {
        withEmbeddings: true,
        customEmbedder: mockEmbedder
      }
    );

    assert.ok(embedCallCount > 0, 'Embedder should have been invoked');
    assert.ok(doc.chunks && doc.chunks.length > 0);
    assert.equal(doc.chunks[0].chunkIndex, 0);
    assert.deepEqual(Array.from(doc.chunks[0].embedding), [0.10000000149011612, 0.20000000298023224, 0.30000001192092896]);
  });

  test('synthesizes AI summary using mock generator seam', async () => {
    const text = 'Bu bir ihtarnamedir. İş akdi haklı nedenle feshedilmiştir.';
    const filePath = path.join(tmpDir, 'ihtar.txt');
    fs.writeFileSync(filePath, text, 'utf-8');

    const mockAi = async () => {
      return {
        summary: 'İş akdi fesih ihtarnamesi',
        tags: ['fesih', 'ihtarname']
      };
    };

    const doc = await DocumentIngestor.ingest(
      {
        path: filePath,
        mtimeMs: 1700000000000,
        size: text.length
      },
      {
        withAiMetadata: true,
        customAiGenerator: mockAi
      }
    );

    assert.equal(doc.metadata?.summary, 'İş akdi fesih ihtarnamesi');
    assert.deepEqual(doc.metadata?.tags, ['fesih', 'ihtarname']);
  });

  test('resiliently handles unreadable or missing files', async () => {
    const nonExistentPath = path.join(tmpDir, 'missing_file.pdf');

    const doc = await DocumentIngestor.ingest({
      path: nonExistentPath,
      mtimeMs: 1700000000000,
      size: 0
    });

    assert.equal(doc.status, 'failed');
    assert.equal(doc.body, '');
    assert.ok(doc.errorMsg?.includes('File does not exist') || doc.errorMsg?.length);
  });
});
