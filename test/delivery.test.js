// 交付复核闭环集成测试：独立临时库 + 随机端口，不触碰 data/db.json
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `clock-delivery-test-${process.pid}.json`);

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ""}`);
  }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function dbRaw() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: "ignore"
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i += 1) {
      try {
        up = (await fetch(BASE + "/health")).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!up) throw new Error("服务启动失败");

    // 新建钟表：待调校，不能确认交付
    const created = await api("POST", "/clocks", {
      code: "CLK-TEST-01",
      escapementType: "同轴擒纵",
      balanceFrequency: "25200vph",
      targetDailyRateSeconds: 20
    });
    check("建表返回201", created.status === 201, created);
    const clockId = created.body.data.id;
    check("初始状态 pending_adjustment", created.body.data.deliveryStatus === "pending_adjustment", created.body.data);

    let r = await api("POST", `/clocks/${clockId}/deliveries`, {});
    check("未调校确认交付返回409", r.status === 409, r);
    check("未调校确认不落库", dbRaw().deliveries.length === 0, dbRaw().deliveries);

    // 第一轮调校：进入待复测
    const adj1 = await api("POST", `/clocks/${clockId}/adjustments`, {
      currentDailyRateSeconds: 55,
      direction: "慢针方向",
      amount: "快慢针向慢侧0.3格"
    });
    check("调校返回201", adj1.status === 201, adj1);
    check("调校后状态 pending_retest", adj1.body.clock.deliveryStatus === "pending_retest", adj1.body.clock);

    r = await api("POST", `/clocks/${clockId}/deliveries`, {});
    check("待复测确认返回409", r.status === 409, r);
    check("待复测确认不落库", dbRaw().deliveries.length === 0, dbRaw().deliveries);

    // 未达标复测：仍不能确认
    const badRetest = await api("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 41, amplitude: 244 });
    check("未达标复测 qualified=false", badRetest.body.data.qualified === false, badRetest.body.data);
    r = await api("POST", `/clocks/${clockId}/deliveries`, {});
    check("未达标确认返回409", r.status === 409, r);
    r = await api("POST", `/clocks/${clockId}/deliveries`, { retestId: badRetest.body.data.id });
    check("指定未达标记录确认返回409", r.status === 409, r);
    check("未达标确认不落库", dbRaw().deliveries.length === 0, dbRaw().deliveries);

    // 达标复测：进入待确认
    const goodRetest1 = await api("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 9, amplitude: 251 });
    check("达标复测 qualified=true", goodRetest1.body.data.qualified === true, goodRetest1.body.data);
    check("达标后状态 awaiting_confirmation", goodRetest1.body.clock.deliveryStatus === "awaiting_confirmation", goodRetest1.body.clock);

    // 指定非最新复测记录确认 → 409
    r = await api("POST", `/clocks/${clockId}/deliveries`, { retestId: badRetest.body.data.id });
    check("指定非最新复测确认返回409", r.status === 409, r);

    // 确认交付成功
    const d1 = await api("POST", `/clocks/${clockId}/deliveries`, { note: "首轮复核通过" });
    check("确认交付返回201", d1.status === 201, d1);
    check("交付记录状态 active", d1.body.data.status === "active", d1.body.data);
    check("交付后状态 delivered", d1.body.clock.deliveryStatus === "delivered", d1.body.clock);
    const delivery1 = d1.body.data;

    // 重复确认同一轮：只保留首条
    r = await api("POST", `/clocks/${clockId}/deliveries`, {});
    check("重复确认返回409", r.status === 409, r);
    r = await api("GET", `/clocks/${clockId}/deliveries`);
    check("重复确认只保留首条", r.body.data.length === 1 && r.body.data[0].id === delivery1.id, r.body.data);

    // 列表一致性：已交付/达标列表包含，未达标列表不包含
    r = await api("GET", "/clocks?deliveryStatus=delivered");
    check("已交付列表包含该表", r.body.data.some((c) => c.id === clockId), r.body.data);
    r = await api("GET", "/clocks?qualified=true");
    check("达标列表包含该表", r.body.data.some((c) => c.id === clockId), r.body.data);
    r = await api("GET", "/clocks/not-qualified");
    check("未达标列表不包含该表", !r.body.data.some((c) => c.id === clockId), r.body.data);

    // 再次调校：旧交付立刻失效，回到待复测
    const adj2 = await api("POST", `/clocks/${clockId}/adjustments`, {
      currentDailyRateSeconds: 33,
      direction: "快针方向",
      amount: "快慢针向快侧0.2格"
    });
    check("二次调校返回201", adj2.status === 201, adj2);
    check("二次调校使旧交付失效", adj2.body.invalidatedDeliveries.length === 1 && adj2.body.invalidatedDeliveries[0].id === delivery1.id, adj2.body);
    check("二次调校后回到 pending_retest", adj2.body.clock.deliveryStatus === "pending_retest", adj2.body.clock);
    check("二次调校后 qualified=false", adj2.body.clock.qualified === false, adj2.body.clock);

    // 历史快照仍可查
    r = await api("GET", `/clocks/${clockId}/deliveries`);
    const oldSnap = r.body.data.find((d) => d.id === delivery1.id);
    check("旧交付快照保留且已失效", Boolean(oldSnap && oldSnap.status === "invalidated" && oldSnap.invalidatedAt), oldSnap);
    check("失效记录关联新调校", oldSnap && oldSnap.invalidatedByAdjustmentId === adj2.body.data.id, oldSnap);
    r = await api("GET", `/clocks/${clockId}/history`);
    check("历史记录含交付快照", r.body.data.deliveries.length === 1 && r.body.data.deliveries[0].status === "invalidated", r.body.data.deliveries);

    // 关键安全判定：旧轮次达标复测不能让未复测钟表被取走
    r = await api("GET", "/clocks?qualified=true");
    check("再调校后达标列表不含该表", !r.body.data.some((c) => c.id === clockId), r.body.data);
    r = await api("GET", "/clocks?deliveryStatus=delivered");
    check("再调校后已交付列表不含该表", !r.body.data.some((c) => c.id === clockId), r.body.data);
    r = await api("GET", "/clocks/not-qualified");
    check("再调校后未达标列表包含该表", r.body.data.some((c) => c.id === clockId), r.body.data);

    // 新轮次未复测 / 用旧达标记录确认 → 409 不落库
    r = await api("POST", `/clocks/${clockId}/deliveries`, {});
    check("新轮次待复测确认返回409", r.status === 409, r);
    r = await api("POST", `/clocks/${clockId}/deliveries`, { retestId: goodRetest1.body.data.id });
    check("用旧轮次达标记录确认返回409", r.status === 409, r);
    check("失败确认均不落库", dbRaw().deliveries.length === 1, dbRaw().deliveries);

    // 新轮次未达标复测 → 仍不能确认
    await api("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 26, amplitude: 247 });
    r = await api("POST", `/clocks/${clockId}/deliveries`, {});
    check("新轮次未达标确认返回409", r.status === 409, r);
    check("确认仍未落库", dbRaw().deliveries.length === 1, dbRaw().deliveries);

    // 新轮次达标复测 → 形成新交付
    await api("POST", `/clocks/${clockId}/retests`, { dailyRateSeconds: 6, amplitude: 253 });
    const d2 = await api("POST", `/clocks/${clockId}/deliveries`, {});
    check("新轮次确认交付返回201", d2.status === 201, d2);
    check("新交付关联新调校", d2.body.data.adjustmentId === adj2.body.data.id, d2.body.data);

    // 交付列表与历史记录一致
    const listAll = await api("GET", `/deliveries?clockId=${clockId}`);
    const hist = await api("GET", `/clocks/${clockId}/history`);
    check("交付列表与历史记录数量一致", listAll.body.data.length === 2 && hist.body.data.deliveries.length === 2, { list: listAll.body.data, hist: hist.body.data.deliveries });
    const ids = (xs) => xs.map((x) => `${x.id}:${x.status}`).sort().join(",");
    check("交付列表与历史记录内容一致", ids(listAll.body.data) === ids(hist.body.data.deliveries));
    r = await api("GET", `/deliveries?clockId=${clockId}&status=active`);
    check("active交付仅新一条", r.body.data.length === 1 && r.body.data[0].id === d2.body.data.id, r.body.data);
    r = await api("GET", `/deliveries?clockId=${clockId}&status=invalidated`);
    check("invalidated交付仅旧一条", r.body.data.length === 1 && r.body.data[0].id === delivery1.id, r.body.data);
    r = await api("GET", "/clocks?deliveryStatus=delivered");
    check("新交付后已交付列表再次包含", r.body.data.some((c) => c.id === clockId), r.body.data);
  } finally {
    server.kill();
    fs.rmSync(DB_FILE, { force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
