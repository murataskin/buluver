import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SetupWizard } from '../src/services/setup-wizard.js';
import { isEmbeddingsEnabled, getEmbeddingProvider } from '../src/services/embeddings.js';
import { isLlmEnabled } from '../src/services/llm.js';

describe('Setup Wizard Modes', () => {
  test('mode "fts" configures Buluver without embeddings or LLM', async () => {
    const logs: string[] = [];
    const result = await SetupWizard.runAutoSetup({
      mode: 'fts',
      onLog: (m) => logs.push(m)
    });

    assert.equal(result.success, true);
    assert.equal(result.mode, 'fts');
    assert.equal(isEmbeddingsEnabled(), false);
    assert.equal(isLlmEnabled(), false);
    assert.match(result.message, /FTS-Only/);
  });

  test('mode "embeddings" enables vector embeddings but keeps LLM disabled', async () => {
    const result = await SetupWizard.runAutoSetup({
      mode: 'embeddings',
      provider: 'onnx',
      pullModelIfMissing: false
    });

    assert.equal(result.success, true);
    assert.equal(result.mode, 'embeddings');
    assert.equal(isEmbeddingsEnabled(), true);
    assert.equal(isLlmEnabled(), false);
    assert.equal(getEmbeddingProvider(), 'onnx');
  });

  test('mode "full" enables both embeddings and LLM', async () => {
    const result = await SetupWizard.runAutoSetup({
      mode: 'full',
      provider: 'onnx',
      pullModelIfMissing: false
    });

    assert.equal(result.success, true);
    assert.equal(result.mode, 'full');
    assert.equal(isEmbeddingsEnabled(), true);
    assert.equal(isLlmEnabled(), true);
  });
});
