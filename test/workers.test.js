import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NumaPlanner } from '../src/numa-planner.js';

const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'alloc-worker.js');

test('multi-threaded workers allocate concurrently through a single planner', async () => {
  const planner = new NumaPlanner({
    nodes: [{ id: 0, capacity: 65536, reservedBytes: 0, hugePages: 0 }],
  });

  const workerCount = 4;
  const requestsPerWorker = 25;
  const size = 64;

  const runWorker = (workerId) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerFile, {
        workerData: { workerId, requests: Array(requestsPerWorker).fill(size) },
      });
      worker.on('message', async (msg) => {
        if (msg.done) {
          resolve(msg.results);
          return;
        }
        const decision = await planner.allocate({ taskId: msg.taskId, size: msg.size });
        worker.postMessage({ id: msg.id, action: decision.action, blockId: decision.blockId });
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`worker ${workerId} exited with code ${code}`));
      });
    });

  const results = await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(i)));
  const flat = results.flat();
  assert.equal(flat.length, workerCount * requestsPerWorker);
  assert.ok(flat.every((r) => r.action === 'local'));

  const node = planner.nodes.get(0);
  const blocks = [...node.blocks].sort((a, b) => a.start - b.start);
  for (let i = 1; i < blocks.length; i += 1) {
    assert.equal(blocks[i].start, blocks[i - 1].start + blocks[i - 1].size, 'no overlapping blocks after concurrent load');
  }
  const allocated = blocks.filter((b) => !b.free).reduce((sum, b) => sum + b.size, 0);
  assert.equal(allocated, workerCount * requestsPerWorker * size);
  assert.equal(planner.stats().decisions.length, workerCount * requestsPerWorker);
});
