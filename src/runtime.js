import { setTimeout as delay } from "node:timers/promises";

// Each lane waits only on its own work. A 40-second WeChat long poll, a slow
// GPT response and an unavailable web session cannot block Dot notifications.
export async function runBridge({
  bridge,
  client,
  abort,
  log = () => {},
  interval = 250,
}) {
  const signal = abort.signal;
  async function lane(work, pause) {
    while (!signal.aborted) {
      await work();
      await delay(pause, undefined, { signal });
    }
  }
  let failures = 0;
  async function receive() {
    let batch;
    try {
      batch = await client.getUpdates(bridge.state.cursor, { signal });
    } catch (error) {
      if (signal.aborted || error.code === "wechat_session_expired")
        throw error;
      failures++;
      if (failures === 1 || failures % 10 === 0)
        log("微信接收暂不可用，退避等待；不重复提交旧消息。");
      await delay(
        Math.min(30000, 1000 * 2 ** Math.min(failures, 5)),
        undefined,
        { signal },
      );
      return;
    }
    if (!signal.aborted) await bridge.ingest(batch);
    failures = 0;
  }
  const lanes = [
    lane(receive, 1000),
    lane(async () => {
      if (bridge.fatalError) throw bridge.fatalError;
      await bridge.drain({ wait: false });
    }, interval),
    lane(() => bridge.pollWeb(), interval),
    lane(() => bridge.pollDot(), interval),
    lane(() => bridge.flushOutgoing(), interval),
  ];
  let failure;
  try {
    await Promise.all(lanes);
  } catch (error) {
    if (!signal.aborted) failure = error;
  } finally {
    abort.abort();
    await bridge.provider.close();
    await Promise.allSettled(lanes);
    await bridge.settle();
  }
  if (failure) throw failure;
}
