/**
 * ci-gate-yaml.test.ts — static YAML assertions for ci-gate.yml (M4, D11).
 *
 * Verifies that the detect job's outputs: are all wired to
 * ${{ steps.detect.outputs.* }} and not literal strings.
 * Also checks job names, trigger types, and CI Gate aggregation structure.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const CI_GATE_PATH = resolve(__dirname, '../../.github/workflows/ci-gate.yml');

function loadCiGate(): Record<string, unknown> {
  const content = readFileSync(CI_GATE_PATH, 'utf8');
  return parse(content) as Record<string, unknown>;
}

describe('ci-gate.yml structure (D11)', () => {
  it('detect job outputs all reference steps.detect.outputs.*', () => {
    const yaml = loadCiGate();
    const jobs = yaml.jobs as Record<string, Record<string, unknown>>;
    const detect = jobs.detect;
    expect(detect).toBeDefined();

    const outputs = detect.outputs as Record<string, string>;
    expect(outputs).toBeDefined();

    const expectedOutputs = [
      'backend',
      'web',
      'ios',
      'android',
      'contract_changed',
      'backend_paths',
      'web_paths',
      'ios_paths',
      'android_paths',
      'product_repo',
      'head_sha',
    ];

    for (const key of expectedOutputs) {
      const value = outputs[key];
      expect(value, `output '${key}' should be defined`).toBeDefined();
      expect(
        value,
        `output '${key}' should reference steps.detect.outputs.*, got '${value}'`,
      ).toMatch(/^\$\{\{\s*steps\.detect\.outputs\.\w+\s*\}\}$/);
    }
  });

  it('detect step has id: detect', () => {
    const yaml = loadCiGate();
    const jobs = yaml.jobs as Record<string, Record<string, unknown>>;
    const detect = jobs.detect;
    const steps = detect.steps as Array<Record<string, unknown>>;

    const detectStep = steps.find((s) => s.id === 'detect');
    expect(detectStep, 'detect step must have id: detect').toBeDefined();
  });

  it('has labeled/unlabeled trigger types (§2.8)', () => {
    const yaml = loadCiGate();
    const on = yaml.on as Record<string, unknown>;
    const pr = on.pull_request as Record<string, unknown>;
    const types = pr.types as string[];
    expect(types).toContain('labeled');
    expect(types).toContain('unlabeled');
  });

  it('CI Gate job has correct needs and if: always()', () => {
    const yaml = loadCiGate();
    const jobs = yaml.jobs as Record<string, Record<string, unknown>>;
    const ciGate = jobs['CI Gate'];
    expect(ciGate).toBeDefined();
    expect(ciGate.name).toBe('CI Gate');
    expect(ciGate.needs).toEqual(['detect', 'backend', 'web', 'ios', 'android']);
    expect(ciGate.if).toBe('always()');
  });

  it('four platform caller jobs exist with correct if conditions', () => {
    const yaml = loadCiGate();
    const jobs = yaml.jobs as Record<string, Record<string, unknown>>;

    for (const platform of ['backend', 'web', 'ios', 'android']) {
      const job = jobs[platform];
      expect(job, `${platform} job must exist`).toBeDefined();
      expect(job.needs).toEqual(['detect']);
      expect(job.if).toBe(`needs.detect.outputs.${platform} == 'true'`);
      expect(job.uses).toMatch(/^\.\/\.github\/workflows\/\w+\.yml$/);
    }
  });

  it('CI Gate aggregation checks detect.result first (D13)', () => {
    const yaml = loadCiGate();
    const jobs = yaml.jobs as Record<string, Record<string, unknown>>;
    const ciGate = jobs['CI Gate'];
    const steps = ciGate.steps as Array<Record<string, unknown>>;
    const aggregate = steps.find((s) => s.name === 'aggregate');
    expect(aggregate).toBeDefined();

    const run = aggregate.run as string;
    // The first check must be needs.detect.result != success.
    const firstCheck = run.indexOf('needs.detect.result');
    const firstPlatformCheck = run.indexOf('needs.backend.result');
    expect(firstCheck).toBeGreaterThan(-1);
    expect(firstPlatformCheck).toBeGreaterThan(-1);
    expect(firstCheck).toBeLessThan(firstPlatformCheck);
  });

  it('has exactly 11 detect outputs (D11)', () => {
    const yaml = loadCiGate();
    const jobs = yaml.jobs as Record<string, Record<string, unknown>>;
    const detect = jobs.detect;
    const outputs = detect.outputs as Record<string, string>;
    expect(Object.keys(outputs)).toHaveLength(11);
  });
});

describe('reusable workflows exist', () => {
  it('java.yml, web.yml, ios.yml, android.yml exist and have workflow_call trigger', () => {
    for (const name of ['java', 'web', 'ios', 'android']) {
      const path = resolve(__dirname, `../../.github/workflows/${name}.yml`);
      const content = readFileSync(path, 'utf8');
      const yaml = parse(content) as Record<string, unknown>;
      const on = yaml.on as Record<string, unknown>;
      expect(on.workflow_call, `${name}.yml must have workflow_call trigger`).toBeDefined();
    }
  });

  it('ios.yml uses macos runner (D14)', () => {
    const path = resolve(__dirname, '../../.github/workflows/ios.yml');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('macos-');
  });

  it('all reusable workflows accept product_repo, head_sha, paths inputs', () => {
    for (const name of ['java', 'web', 'ios', 'android']) {
      const path = resolve(__dirname, `../../.github/workflows/${name}.yml`);
      const content = readFileSync(path, 'utf8');
      const yaml = parse(content) as Record<string, unknown>;
      const on = yaml.on as { workflow_call: { inputs: Record<string, unknown> } };
      const inputs = on.workflow_call.inputs;
      expect(inputs.product_repo).toBeDefined();
      expect(inputs.head_sha).toBeDefined();
      expect(inputs.paths).toBeDefined();
    }
  });
});
