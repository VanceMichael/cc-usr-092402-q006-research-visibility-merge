import Fastify from "fastify";
import { openDatabase, migrate } from "./db.js";
import * as domain from "./domain.js";

export async function buildApp(dbFile = process.env.LEDGER_DB || "data/app.db") {
  const db = openDatabase(dbFile);
  migrate(db);
  const app = Fastify({ logger: true });

  const fail = (reply, err) =>
    reply.code(err.status || 500).send({ error: err.message });

  app.get("/health", async () => {
    db.prepare("select 1").get();
    return { status: "ok" };
  });

  // --- 机构与下游目标 -------------------------------------------------------
  app.post("/institutions", async (req, reply) => {
    try {
      return reply.code(201).send(domain.registerInstitution(db, req.body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/downstream-targets", async (req, reply) => {
    try {
      return reply.code(201).send(domain.registerTarget(db, req.body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/downstream-targets/:id/recover", async (req, reply) => {
    try {
      return domain.recoverTarget(db, req.params.id);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/downstream-targets/:id/queue", async (req, reply) => {
    try {
      return { queue: domain.deliveryQueue(db, req.params.id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/downstream-targets/:id/deliver", async (req, reply) => {
    try {
      return domain.deliverPending(db, req.params.id, req.body || {});
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/downstream-targets/:id/inbox", async (req, reply) => {
    try {
      return { inbox: domain.inboxContents(db, req.params.id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- 抓取批次与原始记录 ---------------------------------------------------
  app.post("/batches", async (req, reply) => {
    try {
      return reply.code(201).send(domain.ingestBatch(db, req.body));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/batches", async () => ({ batches: domain.listBatches(db) }));

  // --- 成果与作者 -----------------------------------------------------------
  app.get("/works", async () => ({ works: domain.listWorks(db) }));
  app.get("/works/:id", async (req, reply) => {
    try {
      const w = domain.getWork(db, Number(req.params.id));
      if (!w) return reply.code(404).send({ error: "成果不存在" });
      return w;
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get("/persons/:id", async (req, reply) => {
    try {
      const p = domain.getPerson(db, Number(req.params.id));
      if (!p) return reply.code(404).send({ error: "作者不存在" });
      return p;
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- 候选重复与人工归并/拆分 ---------------------------------------------
  app.post("/candidates/scan", async () => domain.scanCandidates(db));
  app.get("/candidates", async (req) => ({
    candidates: domain.listCandidates(db, req.query.status),
  }));
  app.get("/candidates/:id", async (req, reply) => {
    try {
      const c = domain.getCandidate(db, Number(req.params.id));
      if (!c) return reply.code(404).send({ error: "候选不存在" });
      return c;
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post("/candidates/:id/decisions", async (req, reply) => {
    try {
      return domain.recordDecision(db, Number(req.params.id), req.body);
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post("/merges/:id/split-request", async (req, reply) => {
    try {
      return reply
        .code(201)
        .send(domain.openSplitCandidate(db, Number(req.params.id), req.body || {}));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // --- 快照：实时重建、发布冻结、下钻、差异 ---------------------------------
  app.get("/snapshots/rebuild", async (req) =>
    domain.buildSnapshot(db, req.query.asOf)
  );
  app.post("/snapshots", async (req, reply) => {
    try {
      return reply.code(201).send(domain.publishSnapshot(db, req.body));
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get("/snapshots", async () => ({ snapshots: domain.listPublished(db) }));
  app.get("/snapshots/:id", async (req, reply) => {
    try {
      const p = domain.getPublished(db, Number(req.params.id));
      if (!p) return reply.code(404).send({ error: "快照不存在" });
      return p;
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get("/snapshots/:id/items/:workId/explain", async (req, reply) => {
    try {
      return domain.explainItem(db, Number(req.params.id), Number(req.params.workId));
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get("/snapshots/diff", async (req, reply) => {
    try {
      const a = parseRef(req.query.a);
      const b = parseRef(req.query.b);
      if (a === undefined || b === undefined)
        return reply.code(400).send({ error: "需要 a、b 两个快照引用（数字=已发布ID，其余=截止时间）" });
      return domain.diffSnapshots(db, a, b);
    } catch (e) {
      return fail(reply, e);
    }
  });

  return app;
}

function parseRef(v) {
  if (v === undefined || v === null || v === "") return undefined;
  return /^\d+$/.test(v) ? Number(v) : v;
}

const isMain = process.argv[1] && process.argv[1].endsWith("server.js");
if (isMain) {
  const app = await buildApp();
  await app.listen({ port: Number(process.env.PORT || 8080), host: "0.0.0.0" });
}
