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
  "GET /clocks/delivered",
  "GET /clocks/:id/history",
  "GET /clocks/:id/deliveries",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "POST /clocks/:id/deliveries",
  "GET /clocks/:id/latest-retest",
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
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!Array.isArray(db.deliveries)) db.deliveries = [];
  return db;
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
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function activeDelivery(db, clockId) {
  return db.deliveries.find((item) => item.clockId === clockId && item.status === "active") || null;
}

const DELIVERY_STATUS_LABELS = {
  pending_adjustment: "待调校",
  pending_retest: "待复测",
  retest_failed: "复测未达标",
  ready_to_deliver: "待确认交付",
  delivered: "已交付"
};

// 交付状态机：以最新调校为当前轮次，只有该轮最新复测达标且已确认才算已交付
function deliveryStatus(db, clockId) {
  if (activeDelivery(db, clockId)) return "delivered";
  const adjustment = latestAdjustment(db, clockId);
  if (!adjustment) return "pending_adjustment";
  const retest = latestRetest(db, clockId);
  if (!retest || retest.adjustmentId !== adjustment.id) return "pending_retest";
  if (!retest.qualified) return "retest_failed";
  return "ready_to_deliver";
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const delivery = activeDelivery(db, clock.id);
  const status = deliveryStatus(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    delivered: Boolean(delivery),
    activeDelivery: delivery,
    deliveryStatus: status,
    deliveryStatusLabel: DELIVERY_STATUS_LABELS[status]
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
    const delivered = url.searchParams.get("delivered");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    if (delivered !== null) {
      const expected = delivered === "true";
      data = data.filter((clock) => clock.delivered === expected);
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

  if (req.method === "GET" && pathname === "/clocks/delivered") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => clock.delivered);
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
        clock,
        adjustments,
        retests,
        deliveries,
        activeDelivery: activeDelivery(db, clock.id),
        latestRetest: latestRetest(db, clock.id)
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    // 再次调校：旧交付立即失效（保留快照），钟表回到待复测
    const invalidatedAt = new Date().toISOString();
    const invalidatedDeliveries = [];
    for (const delivery of db.deliveries) {
      if (delivery.clockId === clock.id && delivery.status === "active") {
        delivery.status = "invalid";
        delivery.invalidatedAt = invalidatedAt;
        delivery.invalidReason = "重新调校，原交付失效";
        invalidatedDeliveries.push(delivery);
      }
    }
    await writeDb(db);
    return send(res, 201, { data: adjustment, invalidatedDeliveries });
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

  const deliveryMatch = pathname.match(/^\/clocks\/([^/]+)\/deliveries$/);
  if (deliveryMatch && req.method === "POST") {
    const clock = findClock(db, deliveryMatch[1]);
    const body = await parseBody(req);
    const adjustment = latestAdjustment(db, clock.id);
    if (!adjustment) {
      return send(res, 409, { error: "钟表尚未调校，无法确认交付" });
    }
    if (body.adjustmentId && body.adjustmentId !== adjustment.id) {
      return send(res, 409, { error: "只能基于最新一轮调校确认交付" });
    }
    const duplicate = db.deliveries.find(
      (item) => item.clockId === clock.id && item.adjustmentId === adjustment.id && item.status === "active"
    );
    if (duplicate) {
      return send(res, 409, { error: "该轮调校已确认交付，请勿重复确认", delivery: duplicate });
    }
    const retest = latestRetest(db, clock.id);
    if (!retest || retest.adjustmentId !== adjustment.id) {
      return send(res, 409, { error: "钟表待复测，不能确认交付" });
    }
    if (body.retestId && body.retestId !== retest.id) {
      return send(res, 409, { error: "只能使用最新的达标复测记录确认交付" });
    }
    if (!retest.qualified) {
      return send(res, 409, { error: "最新复测未达标，不能确认交付" });
    }
    const delivery = {
      id: makeId("delivery"),
      clockId: clock.id,
      adjustmentId: adjustment.id,
      retestId: retest.id,
      status: "active",
      note: body.note || "",
      confirmedAt: new Date().toISOString(),
      invalidatedAt: null,
      invalidReason: null
    };
    db.deliveries.push(delivery);
    await writeDb(db);
    return send(res, 201, { data: delivery, clock: clockSummary(db, clock) });
  }

  if (deliveryMatch && req.method === "GET") {
    const clock = findClock(db, deliveryMatch[1]);
    const data = db.deliveries.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data });
  }

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

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
