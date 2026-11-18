import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NumaPlanner } from '../src/numa-planner.js';

function makePlanner(overrides = {}) {
  return new NumaPlanner({
    hugePageSize: 1024,
    remotePenalty: 100,
    migrationCost: [
      [0, 5],
      [5, 0],
    ],
    nodes: [
      { id: 0, capacity: 8192, reservedBytes: 1024, hugePages: 2 },
      { id: 1, capacity: 8192, reservedBytes: 1024, hugePages: 2 },
    ],
    ...overrides,
  });
}

function assertContiguous(node) {
  const blocks = [...node.blocks].sort((a, b) => a.start - b.start);
  for (let i = 1; i < blocks.length; i += 1) {
    assert.equal(blocks[i].start, blocks[i - 1].start + blocks[i - 1].size, 'blocks must tile the address space without overlap');
  }
}

test('local allocation honours CPU affinity and logs the decision', async () => {
  const planner = makePlanner();
  planner.setAffinity('task-a', 1);
  const decision = await planner.allocate({ taskId: 'task-a', size: 512 });
  assert.equal(decision.action, 'local');
  assert.equal(decision.nodeId, 1);
  assert.equal(planner.stats().decisions.length, 1);
  assert.equal(planner.stats().decisions[0].taskId, 'task-a');
});

test('freeing pages merges adjacent free blocks and reduces fragmentation', async () => {
  const planner = makePlanner();
  planner.setAffinity('t', 0);
  const allocs = [];
  for (let i = 0; i < 5; i += 1) {
    allocs.push(await planner.allocate({ taskId: 't', size: 1024 }));
  }
  // general region is 6144 bytes; 5 x 1024 allocated, 1024 free tail
  await planner.free(allocs[1].blockId);
  await planner.free(allocs[3].blockId);
  let frag = planner.fragmentation().perNode[0].general;
  assert.equal(frag.freeBytes, 3072);
  assert.equal(frag.largestFreeBlock, 1024);
  assert.ok(Math.abs(frag.fragmentationRate - 2 / 3) < 1e-9);

  await planner.free(allocs[0].blockId);
  const node0 = planner.nodes.get(0);
  const merged = node0.blocks.find((b) => b.region === 'general' && b.free && b.size === 2048);
  assert.ok(merged, 'adjacent free blocks must be merged into one 2048-byte block');

  await planner.free(allocs[2].blockId);
  await planner.free(allocs[4].blockId);
  const generalBlocks = node0.blocks.filter((b) => b.region === 'general');
  assert.equal(generalBlocks.length, 1);
  assert.equal(generalBlocks[0].size, 6144);
  assert.equal(planner.fragmentation().perNode[0].general.fragmentationRate, 0);
  assertContiguous(node0);
});

test('referenced blocks are never migrated; unreferenced blocks migrate cross-node', async () => {
  const planner = makePlanner();
  planner.setAffinity('t', 0);
  const a = await planner.allocate({ taskId: 't', size: 2048 });
  const b = await planner.allocate({ taskId: 't', size: 2048 });
  planner.addRef(a.blockId);
  planner.addRef(b.blockId);

  // Both local blocks referenced: cannot migrate, must go remote.
  const remote = await planner.allocate({ taskId: 't', size: 2048 });
  assert.equal(remote.action, 'remote');
  assert.equal(remote.nodeId, 1);
  assert.equal(planner.migrations, 0);

  // Drop references on one block: now migration frees local space.
  planner.releaseRef(a.blockId);
  const migrated = await planner.allocate({ taskId: 't', size: 2048 });
  assert.equal(migrated.action, 'migrate');
  assert.equal(migrated.nodeId, 0);
  assert.ok(planner.migrations >= 1);
  // Block b is still referenced and must still live on node 0.
  const blockB = planner.nodes.get(0).blocks.find((blk) => blk.id === b.blockId);
  assert.ok(blockB, 'referenced block must not be moved off its node');
  assert.equal(blockB.free, false);
});

test('freeing a referenced block is rejected', async () => {
  const planner = makePlanner();
  planner.setAffinity('t', 0);
  const a = await planner.allocate({ taskId: 't', size: 256 });
  planner.addRef(a.blockId);
  await assert.rejects(() => planner.free(a.blockId), /still referenced/);
  planner.releaseRef(a.blockId);
  await planner.free(a.blockId);
});

test('huge page pool exhaustion triggers explicit degradation to small pages', async () => {
  const planner = makePlanner({
    nodes: [{ id: 0, capacity: 8192, reservedBytes: 0, hugePages: 2 }],
  });
  planner.setAffinity('t', 0);
  const h1 = await planner.allocate({ taskId: 't', size: 1024, preferHuge: true });
  const h2 = await planner.allocate({ taskId: 't', size: 1024, preferHuge: true });
  assert.equal(h1.action, 'local');
  assert.equal(h2.action, 'local');
  assert.equal(planner.nodes.get(0).hugePagesUsed, 2);

  const h3 = await planner.allocate({ taskId: 't', size: 1024, preferHuge: true });
  assert.equal(h3.action, 'degraded');
  assert.equal(h3.degraded, true);
  assert.equal(planner.degradations, 1);
  const block = planner.nodes.get(0).blocks.find((b) => b.id === h3.blockId);
  assert.equal(block.region, 'general', 'degraded allocation must come from the small-page region');
});

test('reserved pool is used only as a last resort', async () => {
  const planner = makePlanner({
    nodes: [{ id: 0, capacity: 4096, reservedBytes: 1024, hugePages: 0 }],
  });
  planner.setAffinity('t', 0);
  const big = await planner.allocate({ taskId: 't', size: 3072 });
  assert.equal(big.action, 'local');
  planner.addRef(big.blockId); // pin it so it cannot be migrated away
  const emergency = await planner.allocate({ taskId: 't', size: 512 });
  assert.equal(emergency.action, 'reserved');
  const fail = await planner.allocate({ taskId: 't', size: 1024 });
  assert.equal(fail.action, 'fail');
});

test('node offline migrates unreferenced blocks and reroutes new allocations', async () => {
  const planner = makePlanner();
  planner.setAffinity('t', 0);
  const pinned = await planner.allocate({ taskId: 't', size: 1024 });
  const movable = await planner.allocate({ taskId: 't', size: 1024 });
  planner.addRef(pinned.blockId);

  const { migrated } = await planner.setNodeOnline(0, false);
  assert.equal(migrated, 1);
  assert.equal(planner.migrations, 1);

  const node0 = planner.nodes.get(0);
  const pinnedBlock = node0.blocks.find((b) => b.id === pinned.blockId);
  assert.ok(pinnedBlock && !pinnedBlock.free, 'referenced block must stay on the offline node');
  const movedBlock = planner.nodes.get(1).blocks.find((b) => !b.free && b.owner === 't' && b.id !== pinned.blockId);
  assert.ok(movedBlock, 'unreferenced block must be migrated to node 1');

  const decision = await planner.allocate({ taskId: 't', size: 512 });
  assert.equal(decision.nodeId, 1);
  assert.equal(decision.reason, 'preferred node offline, fell back to nearest online node');

  await planner.setNodeOnline(0, true);
  assert.equal(planner.nodes.get(0).online, true);
});

test('concurrent allocations are serialised and never overlap', async () => {
  const planner = makePlanner({
    nodes: [{ id: 0, capacity: 65536, reservedBytes: 0, hugePages: 0 }],
  });
  const tasks = 256;
  const decisions = await Promise.all(
    Array.from({ length: tasks }, (_, i) =>
      planner.allocate({ taskId: `task-${i}`, size: 128 }),
    ),
  );
  assert.equal(decisions.length, tasks);
  assert.ok(decisions.every((d) => d.action === 'local'));
  const node = planner.nodes.get(0);
  assertContiguous(node);
  const allocated = node.blocks.filter((b) => !b.free).reduce((sum, b) => sum + b.size, 0);
  assert.equal(allocated, tasks * 128);
  const freeBytes = node.blocks.filter((b) => b.free).reduce((sum, b) => sum + b.size, 0);
  assert.equal(allocated + freeBytes, 65536);
  assert.equal(planner.stats().decisions.length, tasks);
});

test('stats expose decisions, migration count and fragmentation rate', async () => {
  const planner = makePlanner();
  planner.setAffinity('t', 0);
  await planner.allocate({ taskId: 't', size: 2048 });
  await planner.allocate({ taskId: 't', size: 2048 });
  await planner.allocate({ taskId: 't', size: 2048 }); // triggers migration of unreferenced blocks
  const stats = planner.stats();
  assert.equal(stats.decisions.length, 3);
  assert.equal(stats.decisions[2].action, 'migrate');
  assert.ok(stats.migrations >= 1);
  assert.ok(stats.fragmentation.overall.fragmentationRate >= 0);
  assert.ok(stats.fragmentation.perNode[0].general);
});
