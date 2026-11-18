# numa-memory-allocator
JavaScript NUMA 内存分配规划库，处理节点亲和、迁移、碎片和回收策略

## 使用

```js
import { NumaPlanner } from './src/numa-planner.js';

const planner = new NumaPlanner({
  hugePageSize: 2 * 1024 * 1024,
  remotePenalty: 100,
  migrationCost: [[0, 10], [10, 0]], // 或 (from, to) => cost
  nodes: [
    { id: 0, capacity: 1 << 30, reservedBytes: 1 << 26, hugePages: 64 },
    { id: 1, capacity: 1 << 30, reservedBytes: 1 << 26, hugePages: 64 },
  ],
});

planner.setAffinity('task-1', 0);
const decision = await planner.allocate({ taskId: 'task-1', size: 4096 });
await planner.free(decision.blockId);
console.log(planner.stats()); // { decisions, migrations, degradations, fragmentation }
```

运行测试：`node --test`；运行演示：`npm run demo`。

## NUMA 拓扑假设

- **节点模型**：每个 NUMA 节点是一段独立的连续物理地址空间 `[0, capacity)`，节点间内存不共享地址。节点布局为 `[大页池][通用区][保留池]`：大页池占底部 `hugePages × hugePageSize` 字节，保留池占顶部 `reservedBytes` 字节。
- **距离/代价**：节点间距离用静态代价矩阵（或函数）`migrationCost(from, to)` 表示，假设拓扑在运行期间不变（不支持热插拔改变矩阵，仅支持节点上/下线）。同节点代价为 0，跨节点为正值。
- **CPU 亲和**：任务的 CPU 亲和是静态的（`setAffinity` 设定后不随调度漂移），亲和节点即"本地节点"；未设置亲和的任务回退到最小 id 的在线节点。
- **分配策略**：本地 best-fit → 迁出本地无引用块腾空间（当代价 `migrationCost < remotePenalty` 时）→ 按代价升序选远端节点 → 保留池兜底 → 失败。大页请求在本地与远端大页池都耗尽后**显式降级**为小页分配（决策记为 `degraded`）。
- **回收与迁移约束**：页回收时只合并同区域内相邻的空闲块（大页区与通用区不互相合并）；`refs > 0` 的块既不能被迁移也不能被释放，节点下线时仍被引用的块留在原节点上。
- **并发模型**：规划器是单例服务，所有变更操作经内部互斥锁串行化；多线程场景下由 worker 线程向持有规划器的线程发送请求（见 `test/workers.test.js`）。
- **碎片率**：定义为 `1 - 最大空闲块 / 总空闲字节`，按节点 × 区域分别统计并给出全局汇总；无空闲字节时记为 0。
