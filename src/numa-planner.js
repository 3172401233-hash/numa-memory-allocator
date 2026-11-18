let nextBlockId = 1;

export class Block {
  constructor({ nodeId, start, size, region }) {
    this.id = nextBlockId++;
    this.nodeId = nodeId;
    this.start = start;
    this.size = size;
    this.region = region; // 'huge' | 'general'
    this.free = true;
    this.refs = 0;
    this.owner = null;
  }
}

class NumaNode {
  constructor({ id, capacity, reservedBytes = 0, hugePages = 0, hugePageSize = 2 * 1024 * 1024 }) {
    this.id = id;
    this.capacity = capacity;
    this.reservedBytes = reservedBytes;
    this.hugePageSize = hugePageSize;
    this.hugePagesTotal = hugePages;
    this.online = true;
    this.blocks = [];
    const hugeBytes = hugePages * hugePageSize;
    if (hugeBytes > capacity) {
      throw new Error(`node ${id}: huge page pool (${hugeBytes}) exceeds capacity (${capacity})`);
    }
    if (hugeBytes > 0) {
      this.blocks.push(new Block({ nodeId: id, start: 0, size: hugeBytes, region: 'huge' }));
    }
    if (capacity - hugeBytes > 0) {
      this.blocks.push(new Block({ nodeId: id, start: hugeBytes, size: capacity - hugeBytes, region: 'general' }));
    }
  }

  get hugePagesUsed() {
    let used = 0;
    for (const block of this.blocks) {
      if (block.region === 'huge' && !block.free) used += block.size / this.hugePageSize;
    }
    return used;
  }

  allocLimit(allowReserved) {
    return allowReserved ? this.capacity : this.capacity - this.reservedBytes;
  }

  allocate(region, size, { allowReserved = false, owner = null } = {}) {
    if (!this.online) return null;
    const need = region === 'huge' ? Math.ceil(size / this.hugePageSize) * this.hugePageSize : size;
    const limit = this.allocLimit(allowReserved);
    let best = null;
    for (const block of this.blocks) {
      if (!block.free || block.region !== region) continue;
      if (block.size < need) continue;
      if (block.start + need > limit) continue;
      if (!best || block.size < best.size) best = block;
    }
    if (!best) return null;
    if (best.size > need) {
      const rest = new Block({ nodeId: this.id, start: best.start + need, size: best.size - need, region });
      const idx = this.blocks.indexOf(best);
      this.blocks.splice(idx + 1, 0, rest);
      best.size = need;
    }
    best.free = false;
    best.owner = owner;
    return best;
  }

  release(block) {
    if (block.refs > 0) {
      throw new Error(`block ${block.id} is still referenced (refs=${block.refs})`);
    }
    block.free = true;
    block.owner = null;
    return this.coalesce(block);
  }

  coalesce(block) {
    let idx = this.blocks.indexOf(block);
    while (idx < this.blocks.length - 1) {
      const next = this.blocks[idx + 1];
      if (next.free && next.region === block.region) {
        block.size += next.size;
        this.blocks.splice(idx + 1, 1);
      } else break;
    }
    while (idx > 0) {
      const prev = this.blocks[idx - 1];
      if (prev.free && prev.region === block.region) {
        prev.size += block.size;
        this.blocks.splice(idx, 1);
        block = prev;
        idx -= 1;
      } else break;
    }
    return block;
  }
}

class Mutex {
  #tail = Promise.resolve();

  run(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}

export class NumaPlanner {
  #lock = new Mutex();
  #seq = 0;
  #migrations = 0;
  #degradations = 0;

  constructor({ nodes, migrationCost, remotePenalty = 100, hugePageSize = 2 * 1024 * 1024 }) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('NumaPlanner requires a non-empty nodes array');
    }
    this.nodes = new Map();
    for (const spec of nodes) {
      const node = new NumaNode({ hugePageSize, ...spec });
      this.nodes.set(node.id, node);
    }
    if (typeof migrationCost === 'function') {
      this.migrationCost = migrationCost;
    } else if (Array.isArray(migrationCost)) {
      this.migrationCost = (from, to) => migrationCost[from][to];
    } else {
      this.migrationCost = (from, to) => (from === to ? 0 : 10);
    }
    this.remotePenalty = remotePenalty;
    this.affinity = new Map();
    this.decisions = [];
  }

  setAffinity(taskId, nodeId) {
    if (!this.nodes.has(nodeId)) throw new Error(`unknown node ${nodeId}`);
    this.affinity.set(taskId, nodeId);
  }

  allocate(request) {
    return this.#lock.run(() => this.#allocate(request));
  }

  free(blockId) {
    return this.#lock.run(() => this.#free(blockId));
  }

  setNodeOnline(nodeId, online) {
    return this.#lock.run(() => this.#setOnline(nodeId, online));
  }

  addRef(blockId) {
    const block = this.#findBlock(blockId);
    block.refs += 1;
    return block.refs;
  }

  releaseRef(blockId) {
    const block = this.#findBlock(blockId);
    if (block.refs === 0) throw new Error(`block ${blockId} has no references`);
    block.refs -= 1;
    return block.refs;
  }

  get migrations() {
    return this.#migrations;
  }

  get degradations() {
    return this.#degradations;
  }

  fragmentation() {
    const perNode = {};
    let totalFree = 0;
    let largestFree = 0;
    for (const [id, node] of this.nodes) {
      const regions = {};
      for (const region of ['huge', 'general']) {
        const freeBlocks = node.blocks.filter((b) => b.region === region && b.free);
        const freeBytes = freeBlocks.reduce((sum, b) => sum + b.size, 0);
        const largest = freeBlocks.reduce((max, b) => Math.max(max, b.size), 0);
        regions[region] = {
          freeBytes,
          largestFreeBlock: largest,
          fragmentationRate: freeBytes > 0 ? 1 - largest / freeBytes : 0,
        };
        totalFree += freeBytes;
        largestFree = Math.max(largestFree, largest);
      }
      perNode[id] = regions;
    }
    return {
      perNode,
      overall: {
        freeBytes: totalFree,
        largestFreeBlock: largestFree,
        fragmentationRate: totalFree > 0 ? 1 - largestFree / totalFree : 0,
      },
    };
  }

  stats() {
    return {
      decisions: this.decisions.map((d) => ({ ...d })),
      migrations: this.#migrations,
      degradations: this.#degradations,
      fragmentation: this.fragmentation(),
    };
  }

  #record(entry) {
    const decision = { seq: ++this.#seq, ...entry };
    this.decisions.push(decision);
    return decision;
  }

  #findBlock(blockId) {
    for (const node of this.nodes.values()) {
      const block = node.blocks.find((b) => b.id === blockId);
      if (block) return block;
    }
    throw new Error(`unknown block ${blockId}`);
  }

  #preferredNode(taskId) {
    const aff = this.affinity.get(taskId);
    if (aff != null) {
      const node = this.nodes.get(aff);
      if (node && node.online) return node;
    }
    let best = null;
    for (const node of this.nodes.values()) {
      if (!node.online) continue;
      if (!best || node.id < best.id) best = node;
    }
    return best;
  }

  #remoteNodesByCost(fromId) {
    return [...this.nodes.values()]
      .filter((n) => n.online && n.id !== fromId)
      .sort((a, b) => this.migrationCost(fromId, a.id) - this.migrationCost(fromId, b.id));
  }

  #allocate({ taskId = 'anonymous', size, preferHuge = false }) {
    if (!Number.isFinite(size) || size <= 0) throw new Error(`invalid allocation size ${size}`);
    const pref = this.#preferredNode(taskId);
    if (!pref) {
      return this.#record({ taskId, size, preferHuge, action: 'fail', nodeId: null, blockId: null, reason: 'no online nodes' });
    }
    const offlineFallback = this.affinity.has(taskId) && this.affinity.get(taskId) !== pref.id
      ? 'preferred node offline, fell back to nearest online node'
      : undefined;

    let degraded = false;
    if (preferHuge) {
      let block = pref.allocate('huge', size, { owner: taskId });
      if (block) {
        return this.#record({ taskId, size, preferHuge, action: 'local', nodeId: pref.id, blockId: block.id, huge: true, reason: offlineFallback });
      }
      for (const node of this.#remoteNodesByCost(pref.id)) {
        block = node.allocate('huge', size, { owner: taskId });
        if (block) {
          return this.#record({ taskId, size, preferHuge, action: 'remote', nodeId: node.id, blockId: block.id, huge: true, reason: 'local huge page pool exhausted' });
        }
      }
      // Huge page pools exhausted everywhere: explicitly degrade to small pages.
      this.#degradations += 1;
      degraded = true;
    }

    let block = pref.allocate('general', size, { owner: taskId });
    if (block) {
      return this.#record({ taskId, size, preferHuge, action: degraded ? 'degraded' : 'local', nodeId: pref.id, blockId: block.id, degraded, reason: offlineFallback });
    }

    const migrated = this.#migrateForSpace(pref.id, size);
    if (migrated > 0) {
      block = pref.allocate('general', size, { owner: taskId });
      if (block) {
        return this.#record({ taskId, size, preferHuge, action: 'migrate', nodeId: pref.id, blockId: block.id, degraded, migrated });
      }
    }

    for (const node of this.#remoteNodesByCost(pref.id)) {
      block = node.allocate('general', size, { owner: taskId });
      if (block) {
        return this.#record({ taskId, size, preferHuge, action: 'remote', nodeId: node.id, blockId: block.id, degraded, reason: 'local node full' });
      }
    }

    block = pref.allocate('general', size, { owner: taskId, allowReserved: true });
    if (block) {
      return this.#record({ taskId, size, preferHuge, action: 'reserved', nodeId: pref.id, blockId: block.id, degraded, reason: 'reserved pool used as last resort' });
    }

    return this.#record({ taskId, size, preferHuge, action: 'fail', nodeId: null, blockId: null, degraded, reason: 'out of memory on all nodes' });
  }

  #migrateForSpace(nodeId, size) {
    const node = this.nodes.get(nodeId);
    let run = [];
    const flush = () => {
      const victims = run.filter((b) => !b.free);
      const total = run.reduce((sum, b) => sum + b.size, 0);
      run = [];
      if (victims.length === 0 || total < size) return 0;
      let migrated = 0;
      for (const victim of victims) {
        if (this.#migrateBlock(victim)) migrated += 1;
      }
      return migrated;
    };
    for (const block of node.blocks) {
      const migratable = block.region === 'general' && (block.free || block.refs === 0);
      if (migratable) {
        run.push(block);
      } else {
        const count = flush();
        if (count > 0) return count;
      }
    }
    return flush();
  }

  #migrateBlock(block) {
    if (block.free || block.refs > 0) return false; // never move referenced blocks
    const source = this.nodes.get(block.nodeId);
    let target = null;
    for (const node of this.nodes.values()) {
      if (node.id === source.id || !node.online) continue;
      if (this.migrationCost(source.id, node.id) >= this.remotePenalty) continue;
      const limit = node.allocLimit(false);
      const fits = node.blocks.some(
        (b) => b.free && b.region === block.region && b.size >= block.size && b.start + block.size <= limit,
      );
      if (!fits) continue;
      if (!target || this.migrationCost(source.id, node.id) < this.migrationCost(source.id, target.id)) {
        target = node;
      }
    }
    if (!target) return false;
    const dest = target.allocate(block.region, block.size, { owner: block.owner });
    if (!dest) return false;
    source.release(block);
    this.#migrations += 1;
    return true;
  }

  #free(blockId) {
    const block = this.#findBlock(blockId);
    const node = this.nodes.get(block.nodeId);
    node.release(block);
    return { ok: true, blockId };
  }

  #setOnline(nodeId, online) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`unknown node ${nodeId}`);
    if (node.online === online) return { migrated: 0 };
    node.online = online;
    let migrated = 0;
    if (!online) {
      for (const block of [...node.blocks]) {
        if (!block.free && block.refs === 0 && this.#migrateBlock(block)) migrated += 1;
      }
    }
    return { migrated };
  }
}
