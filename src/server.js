import { buildApp } from "./app.js";

const app = buildApp({ dbPath: process.env.DB_PATH ?? "data/app.db" });
await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
