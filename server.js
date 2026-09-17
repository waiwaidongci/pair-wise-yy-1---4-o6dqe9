const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  deliveries: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "POST /clocks/:id/deliveries",
  "GET /clocks/:id/deliveries",
  "GET /adjustments",
  "GET /retests",
  "GET /deliveries"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const data = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!Array.isArray(data.deliveries)) data.deliveries = [];
  return data;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  let latest = null;
  for (const item of db.retests) {
    if (item.clockId !== clockId) continue;
    if (!latest || new Date(item.testedAt) >= new Date(latest.testedAt)) latest = item;
  }
  return latest;
}

function latestAdjustment(db, clockId) {
  let latest = null;
  for (const item of db.adjustments) {
    if (item.clockId !== clockId) continue;
    if (!latest || new Date(item.createdAt) >= new Date(latest.createdAt)) latest = item;
  }
  return latest;
}

// 复测是否属于当前（最新）调校轮次：优先按 adjustmentId 归属，历史无归属记录退化为时间比较
function retestInRound(retest, adjustment) {
  if (!retest || !adjustment) return false;
  if (retest.adjustmentId) return retest.adjustmentId === adjustment.id;
  return new Date(retest.testedAt) >= new Date(adjustment.createdAt);
}

function activeDelivery(db, clockId) {
  return db.deliveries.find((item) => item.clockId === clockId && item.status === "active") || null;
}

// 交付状态机：pending_adjustment → pending_retest → awaiting_confirmation → delivered
// 再次调校会使 active 交付失效，状态回到 pending_retest
function clockSummary(db, clock) {
  const adjustment = latestAdjustment(db, clock.id);
  const retest = latestRetest(db, clock.id);
  const delivery = activeDelivery(db, clock.id);
  // 达标判定必须限定在当前调校轮次，否则旧达标记录会让未复测钟表被误判为可取走
  const roundQualified = Boolean(adjustment && retestInRound(retest, adjustment) && retest.qualified);
  let deliveryStatus = "pending_adjustment";
  if (delivery) deliveryStatus = "delivered";
  else if (roundQualified) deliveryStatus = "awaiting_confirmation";
  else if (adjustment) deliveryStatus = "pending_retest";
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: roundQualified,
    deliveryStatus,
    activeDelivery: delivery
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    const deliveryStatus = url.searchParams.get("deliveryStatus");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    if (deliveryStatus !== null) {
      data = data.filter((clock) => clock.deliveryStatus === deliveryStatus);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const deliveries = db.deliveries.filter((item) => item.clockId === clock.id);
    return send(res, 200, {
      data: {
        clock: clockSummary(db, clock),
        adjustments,
        retests,
        deliveries,
        latestRetest: latestRetest(db, clock.id)
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const now = new Date().toISOString();
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: now
    };
    db.adjustments.push(adjustment);
    // 再次调校：旧交付立刻失效（保留快照），钟表回到待复测
    const invalidatedDeliveries = [];
    for (const delivery of db.deliveries) {
      if (delivery.clockId === clock.id && delivery.status === "active") {
        delivery.status = "invalidated";
        delivery.invalidatedAt = now;
        delivery.invalidatedByAdjustmentId = adjustment.id;
        invalidatedDeliveries.push(delivery);
      }
    }
    await writeDb(db);
    return send(res, 201, { data: adjustment, invalidatedDeliveries, clock: clockSummary(db, clock) });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  const deliveriesMatch = pathname.match(/^\/clocks\/([^/]+)\/deliveries$/);
  if (deliveriesMatch && req.method === "GET") {
    const clock = findClock(db, deliveriesMatch[1]);
    const data = db.deliveries.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data });
  }

  // 交付确认复核：只有最新调校轮次的最新达标复测才能确认交付；
  // 待复测 / 未达标 / 旧轮次记录 / 重复确认一律 409 且不落库
  if (deliveriesMatch && req.method === "POST") {
    const clock = findClock(db, deliveriesMatch[1]);
    const body = await parseBody(req);
    const adjustment = latestAdjustment(db, clock.id);
    if (!adjustment) {
      const error = new Error("钟表尚未调校，不能确认交付");
      error.status = 409;
      throw error;
    }
    const duplicated = db.deliveries.find(
      (item) => item.clockId === clock.id && item.adjustmentId === adjustment.id && item.status === "active"
    );
    if (duplicated) {
      const error = new Error("本轮调校已确认交付，请勿重复确认");
      error.status = 409;
      throw error;
    }
    let retest = null;
    if (body.retestId) {
      retest = db.retests.find((item) => item.id === body.retestId && item.clockId === clock.id) || null;
      if (!retest) {
        const error = new Error("复测记录不存在");
        error.status = 404;
        throw error;
      }
    } else {
      retest = latestRetest(db, clock.id);
    }
    if (!retestInRound(retest, adjustment)) {
      const error = new Error("钟表处于待复测状态：当前调校轮次缺少复测记录，不能确认交付");
      error.status = 409;
      throw error;
    }
    const latest = latestRetest(db, clock.id);
    if (latest && retest.id !== latest.id) {
      const error = new Error("只能使用最新的复测记录确认交付");
      error.status = 409;
      throw error;
    }
    if (!retest.qualified) {
      const error = new Error("最新复测未达标，不能确认交付");
      error.status = 409;
      throw error;
    }
    const delivery = {
      id: makeId("delivery"),
      clockId: clock.id,
      adjustmentId: adjustment.id,
      retestId: retest.id,
      status: "active",
      confirmedAt: new Date().toISOString(),
      invalidatedAt: null,
      invalidatedByAdjustmentId: null,
      note: body.note || ""
    };
    db.deliveries.push(delivery);
    await writeDb(db);
    return send(res, 201, { data: delivery, clock: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  // 交付状态列表：与 /clocks/:id/deliveries、/clocks/:id/history 同源，保证一致
  if (req.method === "GET" && pathname === "/deliveries") {
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const data = db.deliveries.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchStatus = !status || item.status === status;
      return matchClock && matchStatus;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
