import { NumaPlanner } from './numa-planner.js';

const planner = new NumaPlanner({
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
});

planner.setAffinity('compute-1', 0);
planner.setAffinity('compute-2', 0);

await planner.allocate({ taskId: 'compute-1', size: 1024, preferHuge: true });
await planner.allocate({ taskId: 'compute-1', size: 1024, preferHuge: true });
await planner.allocate({ taskId: 'compute-1', size: 512, preferHuge: true }); // remote huge
await planner.allocate({ taskId: 'compute-1', size: 512, preferHuge: true }); // remote huge
await planner.allocate({ taskId: 'compute-1', size: 512, preferHuge: true }); // pools exhausted -> degrades
await planner.allocate({ taskId: 'compute-2', size: 2048 });
await planner.allocate({ taskId: 'compute-2', size: 2048 });
await planner.allocate({ taskId: 'compute-2', size: 2048 }); // migrates unreferenced blocks

const stats = planner.stats();
console.log('=== allocation decisions ===');
for (const d of stats.decisions) {
  console.log(
    `#${d.seq} task=${d.taskId} size=${d.size} -> ${d.action} node=${d.nodeId ?? '-'}` +
      (d.migrated ? ` migrated=${d.migrated}` : '') +
      (d.reason ? ` (${d.reason})` : ''),
  );
}
console.log('\n=== fragmentation ===');
for (const [nodeId, regions] of Object.entries(stats.fragmentation.perNode)) {
  console.log(
    `node ${nodeId}: general=${(regions.general.fragmentationRate * 100).toFixed(1)}%` +
      ` huge=${(regions.huge.fragmentationRate * 100).toFixed(1)}%`,
  );
}
console.log(`overall: ${(stats.fragmentation.overall.fragmentationRate * 100).toFixed(1)}%`);
console.log(`\nmigrations: ${stats.migrations}, degradations: ${stats.degradations}`);
