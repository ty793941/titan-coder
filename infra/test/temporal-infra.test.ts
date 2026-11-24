import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const infraRoot = resolve(import.meta.dirname, '..');
const temporalImage =
  'temporalio/temporal:1.5.1@sha256:33cafeff516ee864c73018f0ce6b2b61d2921fce45c1943b0b6619b27502b778';

function readInfraFile(name: string): string {
  return readFileSync(resolve(infraRoot, name), 'utf8');
}

function serviceBlock(compose: string, serviceName: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start === -1) {
    throw new Error(`service ${serviceName} is missing`);
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z0-9_-]+:$/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

function listValues(block: string, key: string): string[] {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line === `    ${key}:`);
  if (start === -1) {
    return [];
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^    [A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    const match = line.match(/^\s+-\s+(.+)$/);
    if (match) {
      values.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
  }
  return values;
}

describe('Temporal local infrastructure contract', () => {
  it('defines a disabled-by-default Temporal profile with a fixed official image', () => {
    const compose = readInfraFile('temporal.compose.yml');
    const temporal = serviceBlock(compose, 'temporal');
    const storageInit = serviceBlock(compose, 'temporal-storage-init');

    expect(listValues(temporal, 'profiles')).toEqual(['temporal']);
    expect(temporal).toContain(`image: ${temporalImage}`);
    expect(storageInit).toContain(`image: ${temporalImage}`);
    expect(temporal).not.toContain('latest');
    expect(storageInit).not.toContain('latest');
    expect(temporal).toContain('start-dev');
    expect(temporal).toContain('--ip=0.0.0.0');
    expect(temporal).toContain('--db-filename=/data/temporal.db');
    expect(temporal).toContain('--namespace=titan');
  });

  it('binds only loopback ports and persists SQLite in a private volume', () => {
    const compose = readInfraFile('temporal.compose.yml');
    const temporal = serviceBlock(compose, 'temporal');

    expect(listValues(temporal, 'ports')).toEqual([
      '127.0.0.1:7233:7233',
      '127.0.0.1:8233:8233',
    ]);
    expect(listValues(temporal, 'volumes')).toEqual(['titan-temporal-data:/data']);
    expect(compose).toMatch(/^volumes:\n\s+titan-temporal-data:/m);
  });

  it('initializes the private volume for the non-root Temporal user', () => {
    const compose = readInfraFile('temporal.compose.yml');
    const temporal = serviceBlock(compose, 'temporal');
    const storageInit = serviceBlock(compose, 'temporal-storage-init');

    expect(listValues(storageInit, 'profiles')).toEqual(['temporal']);
    expect(listValues(storageInit, 'volumes')).toEqual(['titan-temporal-data:/data']);
    expect(listValues(storageInit, 'ports')).toEqual([]);
    expect(storageInit).toContain('user: "0:0"');
    expect(storageInit).toContain('chown 1000:1000 /data');
    expect(temporal).toMatch(/depends_on:[\s\S]*?temporal-storage-init:/);
    expect(temporal).toContain('condition: service_completed_successfully');
    expect(temporal).not.toMatch(/^    user:/m);
  });

  it('publishes the worker connection example without secret values', () => {
    const worker = JSON.parse(readInfraFile('workflow-worker.example.json')) as Record<string, unknown>;

    expect(worker).toEqual({
      temporalAddress: '127.0.0.1:7233',
      namespace: 'titan',
      taskQueue: 'titan-orchestration-v1',
      controlPlaneUrl: 'http://127.0.0.1:3301',
      workerId: 'local',
      credentialRef: 'keychain://titan-workflow-service',
      pollIntervalMs: 1000,
      requestTimeoutMs: 5000,
    });
    expect(readInfraFile('workflow-worker.example.json')).not.toMatch(/secret|token|password|apiKey/i);
  });

  it('documents bounded local startup, health checks, and persistence expectations', () => {
    const docs = readInfraFile('../docs/temporal-infra.md');

    expect(docs).toContain('开发环境');
    expect(docs).toContain('--profile temporal');
    expect(docs).toContain('127.0.0.1:7233');
    expect(docs).toContain('namespace titan');
    expect(docs).toMatch(/health|健康/i);
    expect(docs).toContain('不生产');
    expect(docs).toMatch(/持久|重启/);
  });
});
