// 交付复核全流程验证：node test/delivery.test.js
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `clock-delivery-test-${Date.now()}.json`);

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + "/health")).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动超时");
}

async function deliveryCount(clockId) {
  const { body } = await api("GET", `/deliveries?clockId=${clockId}`);
  return body.data.length;
}

async function main() {
  const server = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: "ignore"
  });
  try {
    await waitReady();

    // 建档
    const clock = (await api("POST", "/clocks", {
      code: "CLK-TEST-01",
      escapementType: "同轴擒纵",
      balanceFrequency: "25200vph",
      targetDailyRateSeconds: 10
    })).body.data;
    const cid = clock.id;
    assert.strictEqual(clock.deliveryStatus, "pending_adjustment");
    assert.strictEqual(clock.delivered, false);

    // 未调校就确认 → 409 不落库
    let r = await api("POST", `/clocks/${cid}/deliveries`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await deliveryCount(cid), 0);

    // 调校后待复测确认 → 409 不落库
    const adj1 = (await api("POST", `/clocks/${cid}/adjustments`, {
      currentDailyRateSeconds: 45, direction: "慢针方向", amount: "微调0.3格"
    })).body.data;
    r = await api("POST", `/clocks/${cid}/deliveries`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await deliveryCount(cid), 0);

    // 复测未达标确认 → 409 不落库
    await api("POST", `/clocks/${cid}/retests`, { dailyRateSeconds: 50, amplitude: 240 });
    r = await api("POST", `/clocks/${cid}/deliveries`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await deliveryCount(cid), 0);

    // 达标复测
    const okRetest = (await api("POST", `/clocks/${cid}/retests`, { dailyRateSeconds: 5, amplitude: 255 })).body.data;
    assert.strictEqual(okRetest.qualified, true);

    // 用非最新复测记录确认 → 409 不落库
    r = await api("POST", `/clocks/${cid}/deliveries`, { retestId: "retest_demo" });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await deliveryCount(cid), 0);

    // 用最新达标复测确认 → 201
    r = await api("POST", `/clocks/${cid}/deliveries`, { retestId: okRetest.id, note: "首轮交付" });
    assert.strictEqual(r.status, 201);
    const delivery1 = r.body.data;
    assert.strictEqual(delivery1.status, "active");
    assert.strictEqual(delivery1.adjustmentId, adj1.id);
    assert.strictEqual(r.body.clock.deliveryStatus, "delivered");

    // 重复确认同一轮 → 409，只保留首条
    r = await api("POST", `/clocks/${cid}/deliveries`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.delivery.id, delivery1.id);
    assert.strictEqual(await deliveryCount(cid), 1);

    // 交付状态列表与历史一致
    let delivered = (await api("GET", "/clocks/delivered")).body.data;
    assert.ok(delivered.some((item) => item.id === cid));
    assert.ok((await api("GET", "/clocks?delivered=true")).body.data.some((item) => item.id === cid));
    let history = (await api("GET", `/clocks/${cid}/history`)).body.data;
    assert.strictEqual(history.deliveries.length, 1);
    assert.strictEqual(history.activeDelivery.id, delivery1.id);

    // 再次调校 → 旧交付立即失效，快照可查，钟表回到待复测
    r = await api("POST", `/clocks/${cid}/adjustments`, {
      currentDailyRateSeconds: 8, direction: "快针方向", amount: "微调0.1格"
    });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.body.invalidatedDeliveries.map((d) => d.id), [delivery1.id]);
    delivered = (await api("GET", "/clocks/delivered")).body.data;
    assert.ok(!delivered.some((item) => item.id === cid), "失效后不得出现在已交付列表");
    history = (await api("GET", `/clocks/${cid}/history`)).body.data;
    assert.strictEqual(history.deliveries.length, 1);
    assert.strictEqual(history.deliveries[0].status, "invalid");
    assert.ok(history.deliveries[0].invalidatedAt);
    assert.strictEqual(history.activeDelivery, null);
    const summary = (await api("GET", "/clocks")).body.data.find((item) => item.id === cid);
    assert.strictEqual(summary.deliveryStatus, "pending_retest");

    // 旧轮次确认 → 409（待复测），不落库
    r = await api("POST", `/clocks/${cid}/deliveries`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await deliveryCount(cid), 1);

    // 新轮次复测未达标 → 409 不落库
    await api("POST", `/clocks/${cid}/retests`, { dailyRateSeconds: -40, amplitude: 238 });
    r = await api("POST", `/clocks/${cid}/deliveries`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await deliveryCount(cid), 1);

    // 新调校后的达标复测 → 形成新交付
    await api("POST", `/clocks/${cid}/retests`, { dailyRateSeconds: 8, amplitude: 250 });
    r = await api("POST", `/clocks/${cid}/deliveries`, {});
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.data.adjustmentId, r.body.clock.latestAdjustment.id);
    assert.strictEqual(await deliveryCount(cid), 2);

    // 最终一致性：已交付列表 == active 交付记录；历史含两条快照
    delivered = (await api("GET", "/clocks/delivered")).body.data;
    const active = (await api("GET", "/deliveries?status=active")).body.data;
    assert.deepStrictEqual(delivered.map((c) => c.id).sort(), [...new Set(active.map((d) => d.clockId))].sort());
    history = (await api("GET", `/clocks/${cid}/history`)).body.data;
    assert.strictEqual(history.deliveries.length, 2);
    assert.strictEqual(history.deliveries.filter((d) => d.status === "invalid").length, 1);
    assert.strictEqual(history.activeDelivery.status, "active");

    // 落库文件校验：409 没有产生垃圾记录
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    assert.strictEqual(raw.deliveries.filter((d) => d.clockId === cid).length, 2);

    console.log("全部交付复核场景验证通过 ✔");
  } finally {
    server.kill();
    fs.rmSync(DB_FILE, { force: true });
  }
}

main().catch((error) => {
  console.error("验证失败:", error);
  process.exit(1);
});
