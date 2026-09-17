# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录和交付记录。

## 启动

```bash
PORT=3021 node server.js
```

## 交付复核闭环

钟表按状态机流转：`pending_adjustment`（待调校）→ `pending_retest`（待复测）→ `awaiting_confirmation`（待确认交付）→ `delivered`（已交付）。

- 调校后只有**当前轮次最新的达标复测**才能确认交付；待复测、未达标、旧轮次记录确认一律返回 **409 且不落库**。
- 确认成功后再次调校，旧交付**立刻失效**（`status: invalidated`，保留快照可查），钟表回到待复测；只有新调校后的达标复测才能形成新交付。
- 重复确认同一轮只保留首条，后续返回 **409**。
- `qualified` 与 `deliveryStatus` 都按当前调校轮次判定：再次调校后旧的达标复测不再生效，未复测钟表不会出现在达标/已交付列表中。
- 交付状态列表（`GET /deliveries`、`GET /clocks?deliveryStatus=`）与历史记录（`GET /clocks/:id/history`、`GET /clocks/:id/deliveries`）同源派生，保证一致。

## 主要接口

- `GET /health`
- `GET /clocks?qualified=&deliveryStatus=`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含 deliveries 快照）
- `POST /clocks/:id/adjustments`（再次调校会使旧交付失效）
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `POST /clocks/:id/deliveries`（确认交付，可指定 `retestId`）
- `GET /clocks/:id/deliveries`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /deliveries?clockId=&status=`

## 闭环示例

```bash
# 1. 查看待复测钟表
curl http://127.0.0.1:3021/clocks/not-qualified

# 2. 复测达标
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'

# 3. 确认交付
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/deliveries \
  -H 'Content-Type: application/json' \
  -d '{"note":"复核通过，允许交付"}'

# 4. 查看交付状态列表与历史快照
curl 'http://127.0.0.1:3021/deliveries?status=active'
curl http://127.0.0.1:3021/clocks/clock_demo/history
```

## 测试

```bash
node test/delivery.test.js
```
