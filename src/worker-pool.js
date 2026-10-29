// Tiny round-robin-ish pool: tasks queue until a worker is free; aborted tasks that
// haven't started yet are dropped from the queue.
export class WorkerPool {
  constructor(createWorker, size) {
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 0;
    for (let i = 0; i < size; i++) {
      const worker = createWorker();
      worker.onmessage = ({ data }) => {
        const task = this.pending.get(data.id);
        this.pending.delete(data.id);
        this.idle.push(worker);
        if (data.error) task.reject(new Error(data.error));
        else task.resolve(data);
        this.pump();
      };
      this.idle.push(worker);
    }
  }

  run(message, signal) {
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, message, resolve, reject, signal };
      signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(task);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
      this.queue.push(task);
      this.pump();
    });
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const task = this.queue.shift();
      const worker = this.idle.pop();
      this.pending.set(task.id, task);
      worker.postMessage({ id: task.id, ...task.message });
    }
  }
}
