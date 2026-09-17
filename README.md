# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录和交付记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks?qualified=&delivered=`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/delivered`
- `GET /clocks/:id/history`（含交付快照 `deliveries` 与 `activeDelivery`）
- `GET /clocks/:id/deliveries`
- `POST /clocks/:id/adjustments`（再次调校会使旧交付立即失效）
- `POST /clocks/:id/retests`
- `POST /clocks/:id/deliveries`（确认交付）
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /deliveries?clockId=&status=`（`status` 为 `active` 或 `invalid`）

## 交付复核规则

每只钟表带有 `deliveryStatus`：`pending_adjustment`（待调校）→ `pending_retest`（待复测）→ `retest_failed`（复测未达标）/ `ready_to_deliver`（待确认交付）→ `delivered`（已交付）。

- 确认交付必须基于**最新一轮调校**的**最新达标复测**；钟表待复测或最新复测未达标时确认返回 `409`，且不写入任何记录。
- 同一轮调校重复确认返回 `409`，只保留首条交付记录。
- 确认成功后再次调校，旧交付立即失效（`status: invalid`，保留 `invalidatedAt`/`invalidReason` 快照可查），钟表回到待复测；只有新调校后的达标复测才能形成新的交付。
- `GET /clocks/delivered` 与历史记录同源：只有存在 `active` 交付记录的钟表才会出现在已交付列表中。

## 闭环示例

```bash
# 复测达标后确认交付
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/deliveries \
  -H 'Content-Type: application/json' -d '{}'

# 查看已交付钟表与交付记录
curl http://127.0.0.1:3021/clocks/delivered
curl 'http://127.0.0.1:3021/deliveries?status=active'

# 再次调校后旧交付自动失效，历史快照仍可查
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":9,"direction":"快针方向","amount":"微调0.2格"}'
curl http://127.0.0.1:3021/clocks/clock_demo/history
```

## 测试

```bash
node test/delivery.test.js
```
