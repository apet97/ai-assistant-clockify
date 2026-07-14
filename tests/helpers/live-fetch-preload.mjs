import { appendFileSync } from "node:fs";

const logPath = process.env.LIVE_TEST_REQUEST_LOG;
let tag = process.env.LIVE_TEST_SEED_TAG === "1"
  ? { id: "tag-live", name: "AIASSIST_SMOKE_seed" }
  : undefined;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  if (logPath) appendFileSync(logPath, `${method} ${url.pathname}\n`, "utf8");
  if (method === "GET" && url.pathname === "/api/v1/user") return json({ id: "admin-1" });
  if (
    method === "GET"
    && url.pathname === "/api/v1/workspaces/ws-1/invoices"
    && process.env.LIVE_TEST_FAIL_INVOICE_LIST === "1"
  ) {
    return json({ message: "denied" }, 403);
  }
  if (method === "GET" && url.pathname.includes("/user/admin-1/time-entries")) return json([]);
  if (method === "GET" && url.pathname === "/api/v1/workspaces/ws-1/tags") {
    return json(tag ? [tag] : []);
  }
  if (method === "GET" && url.pathname.startsWith("/api/v1/workspaces/ws-1/tags/")) {
    return tag ? json(tag) : new Response(null, { status: 404 });
  }
  if (method === "POST" && url.pathname === "/api/v1/workspaces/ws-1/tags") {
    const body = JSON.parse(String(init.body ?? "{}"));
    tag = { id: "tag-live", name: body.name };
    return json(tag);
  }
  if (method === "DELETE" && url.pathname === "/api/v1/workspaces/ws-1/tags/tag-live") {
    tag = undefined;
    return new Response(null, { status: 204 });
  }
  if (method === "GET") return json([]);
  return new Response(null, { status: 204 });
};
