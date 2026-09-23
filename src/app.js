import Fastify from "fastify";
import { openDatabase } from "./db.js";
import * as ledger from "./ledger.js";

// buildApp 支持注入时钟与数据库路径，便于测试按时间线重放场景。
export function buildApp({ dbPath = "data/app.db", now = () => new Date().toISOString() } = {}) {
  const db = openDatabase(dbPath);
  const ctx = { db, now };
  const app = Fastify({ logger: false });
  app.decorate("db", db);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ledger.LedgerError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: "bad_request", message: err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: "internal", message: "内部错误" } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: "not_found", message: "路由不存在" } }));

  // 写操作要求机构身份头；机构只能修订自己提供的事实
  const institutionOf = (req) => {
    const iid = req.headers["x-institution-id"];
    if (!iid) throw new ledger.LedgerError(401, "institution_required", "缺少 x-institution-id 请求头");
    const inst = db.prepare(`SELECT * FROM institutions WHERE id = ?`).get(String(iid));
    if (!inst) throw new ledger.LedgerError(401, "unknown_institution", `未知机构 ${iid}`);
    return inst;
  };

  app.get("/health", async () => {
    db.prepare("select 1").get();
    return { status: "ok" };
  });

  // 机构与人员
  app.post("/institutions", async (req) => ledger.createInstitution(ctx, req.body ?? {}));
  app.get("/institutions", async () => db.prepare(`SELECT * FROM institutions ORDER BY created_at, id`).all());
  app.post("/persons", async (req) => {
    institutionOf(req);
    return ledger.createPerson(ctx, req.body ?? {});
  });

  // 抓取批次与来源记录
  app.post("/batches", async (req) => {
    const inst = institutionOf(req);
    const b = req.body ?? {};
    return ledger.createBatch(ctx, { institutionId: inst.id, sourceType: b.source_type, fetchedAt: b.fetched_at, note: b.note });
  });
  app.get("/batches/:id", async (req) => ledger.getBatch(ctx, req.params.id));
  app.post("/batches/:id/records", async (req) => {
    const inst = institutionOf(req);
    const b = req.body ?? {};
    return ledger.ingestRecord(ctx, { institutionId: inst.id, batchId: req.params.id, externalId: b.external_id, payload: b.payload });
  });
  app.get("/records/:id", async (req) => ledger.getRecord(ctx, req.params.id));

  // 成果与版本
  app.get("/works/:id", async (req) => ledger.getWork(ctx, req.params.id));
  app.get("/works/:id/versions", async (req) => ledger.listWorkVersions(ctx, req.params.id));
  app.post("/works/:id/versions", async (req) => {
    const inst = institutionOf(req);
    const b = req.body ?? {};
    return ledger.addWorkVersion(ctx, {
      institutionId: inst.id,
      workId: req.params.id,
      sourceRecordId: b.source_record_id,
      changeReason: b.change_reason,
      changes: b.changes ?? {},
    });
  });

  // 标识映射（带有效期）
  app.post("/mappings", async (req) => {
    const inst = institutionOf(req);
    const b = req.body ?? {};
    return ledger.addMapping(ctx, {
      institutionId: inst.id,
      subjectType: b.subject_type,
      subjectId: b.subject_id,
      scheme: b.scheme,
      identifier: b.identifier,
      validFrom: b.valid_from,
      validTo: b.valid_to,
      evidence: b.evidence,
    });
  });
  app.post("/mappings/:id/close", async (req) => {
    const inst = institutionOf(req);
    return ledger.closeMapping(ctx, { institutionId: inst.id, mappingId: req.params.id, validTo: (req.body ?? {}).valid_to });
  });
  app.get("/mappings/resolve", async (req) => ledger.resolveMapping(ctx, req.query));

  // 候选重复与归并决议
  app.get("/duplicate-candidates", async (req) => ledger.listCandidates(ctx, { status: req.query.status }));
  app.get("/duplicate-candidates/:id", async (req) => ledger.getCandidate(ctx, req.params.id));
  app.post("/duplicate-candidates/:id/decisions", async (req) => {
    const inst = institutionOf(req);
    const b = req.body ?? {};
    return ledger.decideCandidate(ctx, {
      institutionId: inst.id,
      candidateId: req.params.id,
      decision: b.decision,
      targetWorkId: b.target_work_id,
      reason: b.reason,
      decidedBy: b.decided_by,
    });
  });
  app.get("/merge-decisions/:id", async (req) => ledger.getDecision(ctx, req.params.id));
  app.post("/merge-decisions/:id/confirm", async (req) => {
    const inst = institutionOf(req);
    const b = req.body ?? {};
    return ledger.confirmDecision(ctx, { institutionId: inst.id, decisionId: req.params.id, decidedBy: b.decided_by, note: b.note });
  });

  // 快照：发布 / 重建 / 下钻 / 差异
  app.post("/snapshots", async (req) => ledger.publishSnapshot(ctx, { cutoffAt: (req.body ?? {}).cutoff_at }));
  app.post("/snapshots/rebuild", async (req) => ledger.rebuildSnapshot(ctx, { cutoffAt: (req.body ?? {}).cutoff_at }));
  app.get("/snapshots", async () => ledger.listSnapshots(ctx));
  app.get("/snapshots/diff", async (req) => ledger.diffSnapshots(ctx, { fromId: req.query.from, toId: req.query.to }));
  app.get("/snapshots/:id", async (req) => ledger.getSnapshot(ctx, req.params.id));
  app.get("/snapshots/:id/entries", async (req) => {
    const included = req.query.included === undefined ? undefined : Number(req.query.included);
    return ledger.getSnapshotEntries(ctx, req.params.id, { included, workId: req.query.work_id });
  });

  // 下游更新：幂等应用与恢复
  app.get("/downstream-updates", async (req) => ledger.listDownstreamUpdates(ctx, { status: req.query.status }));
  app.post("/downstream-updates/recover", async () => ledger.recoverDownstream(ctx));
  app.post("/downstream-updates/:id/apply", async (req) => {
    const simulate = req.query.fail === "1" || (req.body ?? {}).simulate_failure === true;
    return ledger.applyDownstreamUpdate(ctx, { updateId: req.params.id, simulateFailure: simulate });
  });
  app.get("/downstream-stats", async () => ledger.getDownstreamStats(ctx));

  return app;
}
