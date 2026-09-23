import Database from "better-sqlite3";
import Fastify from "fastify";

const db = new Database("data/app.db");
db.pragma("journal_mode = WAL");
const app = Fastify();
const health = async (_request, response) => {
  db.prepare("select 1").get();
  return { status: "ok" };
};
app.get("/health", health);
await app.listen({ port: 8080, host: "0.0.0.0" });
