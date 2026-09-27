import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectHardwareProfile,
  isOllamaBinaryPresent,
  checkOllamaServer,
  scanSystem
} from '../src/services/system-detector.js';

describe('System & Spec Detector', () => {
  test('detects CPU, RAM and categorizes hardware tier', () => {
    const hw = detectHardwareProfile();
    assert.ok(hw.cpuModel.length > 0);
    assert.ok(hw.cores > 0);
    assert.ok(hw.ramGB > 0);
    assert.ok(['light', 'balanced', 'pro'].includes(hw.tier));
  });

  test('checks Ollama presence and server status', async () => {
    const isPresent = isOllamaBinaryPresent();
    assert.equal(typeof isPresent, 'boolean');

    const status = await checkOllamaServer();
    assert.equal(typeof status.running, 'boolean');
  });

  test('scanSystem returns complete report with recommendation', async () => {
    const report = await scanSystem();
    assert.ok(report.hardware);
    assert.ok(Array.isArray(report.detectedModels));
    assert.ok(report.recommendation);
    assert.ok(['onnx', 'ollama'].includes(report.recommendation.provider));
    assert.ok(report.recommendation.modelName.length > 0);
    assert.ok(report.recommendation.reason.length > 0);
  });
});
