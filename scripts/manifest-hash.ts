import { buildManifest } from "../src/addon/manifest.js";
import { hashCanonicalJson } from "./lib/live-evidence.js";

const rawBaseUrl = process.env.LIVE_ADDON_BASE_URL ?? process.env.BASE_URL;
if (!rawBaseUrl) throw new Error("LIVE_ADDON_BASE_URL or BASE_URL is required");

let baseUrl: URL;
try {
  baseUrl = new URL(rawBaseUrl);
} catch {
  throw new Error("add-on base URL is invalid");
}
if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error("add-on base URL must be a credential-free HTTPS URL");
}

process.stdout.write(`${hashCanonicalJson(buildManifest(rawBaseUrl))}\n`);
