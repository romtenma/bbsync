import { startStateStoreServer } from "@romtenma/bbsync/http";

const token = process.env.BBSYNC_TOKEN;
if (!token) throw new Error("Set BBSYNC_TOKEN to a private random token");
const server = await startStateStoreServer({
  rootDirectory: process.argv[2] ?? "./bbsync-server",
  token, host: process.env.BBSYNC_HOST ?? "127.0.0.1",
  port: Number(process.env.BBSYNC_PORT ?? 8787),
});
console.log(`bbsync listening at ${server.url}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void server.close().catch((error) => { console.error(error); process.exitCode = 1; });
});
