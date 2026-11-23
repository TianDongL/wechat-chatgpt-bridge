// Coordinates one account socket. Only fixed state and selected-conversation
// wake-ups cross this boundary; signed URLs and account frames stay in memory.
export class WebChatPush {
  constructor({ open, now = Date.now }) {
    this.open = open;
    this.now = now;
    this.target = null;
    this.generation = 0;
    this.connection = null;
    this.ready = false;
    this.dirty = null;
    this.retryAt = 0;
    this.retryAfter = null;
    this.failures = 0;
    this.connections = 0;
    this.updates = 0;
  }

  select(url, generation) {
    const target = url && url !== "dot" ? new URL(url).pathname.split("/").at(-1) : null;
    if (target === this.target && generation === this.generation) return;
    this.target = target;
    this.generation = generation;
    this.dirty = this.ready && target ? "sync" : null;
    if (!target) {
      this.close();
    } else {
      this.connection?.watch?.select({ target, generation });
    }
  }

  tick() {
    if (!this.target || this.connection || this.now() < this.retryAt) return;
    const connection = { watch: null };
    this.connection = connection;
    try {
      connection.watch = this.open((event) => this.receive(connection, event));
      if (this.connection === connection)
        connection.watch.select({ target: this.target, generation: this.generation });
      else
        connection.watch.close();
    } catch {
      this.receive(connection, { kind: "offline" });
    }
  }

  receive(connection, event) {
    if (connection !== this.connection || !this.target) return;
    if (event.kind === "ready") {
      this.ready = true;
      this.dirty = "sync";
      this.failures = 0;
      this.connections++;
    } else if (event.kind === "update") {
      if (event.target !== this.target || event.generation !== this.generation) return;
      this.dirty = "update";
      this.updates++;
    } else if (event.kind === "offline" || event.kind === "limited") {
      this.connection = null;
      this.ready = false;
      this.failures++;
      const delay = Math.min(180000, 5000 * 2 ** Math.min(6, this.failures - 1));
      this.retryAt = Math.max(this.retryAt, this.now() + delay);
      if (event.kind === "limited" && Number.isFinite(event.seconds) && event.seconds > 0) {
        this.retryAfter = Math.max(this.retryAfter || 0, event.seconds);
        this.retryAt = Math.max(this.retryAt, this.now() + event.seconds * 1000);
      }
      connection.watch?.close();
    }
  }

  take() {
    const state = { ready: this.ready, dirty: this.dirty, retryAfter: this.retryAfter };
    this.dirty = null;
    this.retryAfter = null;
    return state;
  }

  status() {
    return {
      state: !this.target ? "off" : this.ready ? "ready" :
        this.connection ? "connecting" : this.now() < this.retryAt ? "backoff" : "waiting",
      connections: this.connections,
      targetUpdates: this.updates,
    };
  }

  close() {
    const connection = this.connection;
    this.connection = null;
    this.target = null;
    this.ready = false;
    this.dirty = null;
    connection?.watch?.close();
  }
}
