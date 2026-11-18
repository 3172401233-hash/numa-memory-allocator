import { parentPort, workerData } from 'node:worker_threads';

const { workerId, requests } = workerData;
const results = [];

for (let i = 0; i < requests.length; i += 1) {
  const id = `${workerId}:${i}`;
  const reply = await new Promise((resolve, reject) => {
    const handler = (msg) => {
      if (msg.id === id) {
        parentPort.off('message', handler);
        resolve(msg);
      }
    };
    parentPort.on('message', handler);
    parentPort.postMessage({ id, taskId: `worker-${workerId}`, size: requests[i] });
    setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 10000).unref();
  });
  results.push(reply);
}

parentPort.postMessage({ done: true, workerId, results });
