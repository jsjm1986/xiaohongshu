import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api } from '../src/lib/api';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('image list uses one paginated request and consumes the embedded latest analysis', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      items: [{
        id: 'asset-1',
        projectId: 'project/one',
        filename: 'source.png',
        mediaType: 'image/png',
        bytes: 12,
        sha256: 'abc',
        analysisStatus: 'approved',
        latestAnalysisId: 'analysis-1',
        latestAnalysis: {
          id: 'analysis-1',
          status: 'approved',
          approvalStatus: 'approved',
          observedFacts: ['可见事实'],
          roles: ['cover'],
          quality: { clarity: 0.8, relevance: null, textLegibility: 0.5 },
        },
      }],
      total: 73,
      limit: 25,
      offset: 50,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const result = await api.imageAssets.list('project/one', { limit: 25, offset: 50 });

  assert.deepEqual(calls, ['/api/projects/project%2Fone/image-assets?limit=25&offset=50']);
  assert.equal(result.total, 73);
  assert.equal(result.limit, 25);
  assert.equal(result.offset, 50);
  assert.equal(result.items[0]?.latestAnalysisId, 'analysis-1');
  assert.equal(result.items[0]?.approved, true);
  assert.deepEqual(result.items[0]?.analysis?.visibleFacts, ['可见事实']);
});

test('image list can request only assets with an approved observation', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ items: [], total: 0, limit: 12, offset: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await api.imageAssets.list('project', { limit: 12, observationStatus: 'approved' });
  assert.deepEqual(calls, ['/api/projects/project/image-assets?limit=12&offset=0&observationStatus=approved']);
});
