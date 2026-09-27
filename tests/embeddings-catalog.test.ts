import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDING_CATALOG,
  getCatalog,
  getModelById,
  getDefaultModel,
  getActiveCatalogModel,
  switchActiveModel,
  getProviderClient,
  OnnxProviderClient,
  OllamaProviderClient
} from '../src/services/embeddings.js';
import { SettingsStore } from '../src/services/settings-store.js';

describe('Embedding Model Catalog', () => {
  test('catalog contains curated models with required metadata', () => {
    const catalog = getCatalog();
    assert.ok(catalog.length >= 3 && catalog.length <= 5, 'Catalog should contain 3-5 entries');

    for (const entry of catalog) {
      assert.ok(entry.id, 'Entry must have an id');
      assert.ok(entry.label, 'Entry must have a label');
      assert.ok(entry.provider === 'onnx' || entry.provider === 'ollama', 'Provider must be onnx or ollama');
      assert.ok(entry.modelName, 'Entry must have a modelName');
      assert.ok(typeof entry.dimensions === 'number' && entry.dimensions > 0, 'Dimensions must be a positive number');
      assert.ok(entry.approxSize, 'Entry must specify approxSize');
      assert.ok(entry.description, 'Entry must have a description');
    }
  });

  test('default catalog model is minilm-l12 for backward compatibility', () => {
    const defaultModel = getDefaultModel();
    assert.equal(defaultModel.id, 'minilm-l12');
    assert.equal(defaultModel.provider, 'onnx');
    assert.equal(defaultModel.dimensions, 384);
    assert.equal(defaultModel.modelName, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  });

  test('getModelById finds models by id or modelName', () => {
    const minilm = getModelById('minilm-l12');
    assert.ok(minilm);
    assert.equal(minilm.id, 'minilm-l12');

    const bge = getModelById('bge-m3');
    assert.ok(bge);
    assert.equal(bge.dimensions, 1024);
    assert.equal(bge.provider, 'ollama');

    const nomic = getModelById('nomic-embed');
    assert.ok(nomic);
    assert.equal(nomic.dimensions, 768);

    assert.equal(getModelById('invalid-model-id'), undefined);
  });
});

describe('Embedding Provider Abstraction', () => {
  test('provides instances of OnnxProviderClient and OllamaProviderClient', () => {
    const onnx = getProviderClient('onnx');
    assert.ok(onnx instanceof OnnxProviderClient);
    assert.equal(onnx.provider, 'onnx');

    const ollama = getProviderClient('ollama');
    assert.ok(ollama instanceof OllamaProviderClient);
    assert.equal(ollama.provider, 'ollama');
  });

  test('ONNX health check succeeds without external dependencies', async () => {
    const onnx = getProviderClient('onnx');
    const health = await onnx.checkHealth('Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    assert.equal(health.ok, true);
  });

  test('Ollama health check fails with clear actionable error when model is missing', async () => {
    const ollama = getProviderClient('ollama');
    const health = await ollama.checkHealth('completely-nonexistent-model-xyz');
    assert.equal(health.ok, false);
    assert.ok(health.error);
    // Error must either mention connection error or ollama pull instructions
    assert.ok(
      health.error.includes('ollama pull') || health.error.includes('erişilemiyor') || health.error.includes('Ollama'),
      `Expected actionable error message, got: ${health.error}`
    );
  });
});

describe('Model Switching & Compatibility', () => {
  test('switches active model to a valid catalog entry', async () => {
    const result = await switchActiveModel('minilm-l12');
    assert.equal(result.success, true);
    assert.equal(result.model.id, 'minilm-l12');
    assert.equal(getActiveCatalogModel().id, 'minilm-l12');
    assert.equal(SettingsStore.get('active_model_id'), 'minilm-l12');
    assert.equal(SettingsStore.get('indexed_model_id'), 'minilm-l12');
    assert.equal(SettingsStore.get('indexed_model_dim'), '384');
  });

  test('rejects switching to an uncataloged model with list of supported options', async () => {
    await assert.rejects(
      async () => {
        await switchActiveModel('unsupported-random-model');
      },
      (err: any) => {
        assert.match(err.message, /Bilinmeyen model ID/);
        assert.match(err.message, /minilm-l12/);
        return true;
      }
    );
  });
});
