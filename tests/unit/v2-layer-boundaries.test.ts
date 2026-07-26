import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T16-F sanctioned structural gate: transport route files may only decode,
 * authorize, call ONE injected service seam, and encode/stream. They must not
 * import the model, store, harness, presenter, audit/metrics, or
 * entity-specific workflow layers at RUNTIME. `import type` is allowed — types
 * are erased and carry no behavior.
 *
 * Deliberately NOT covered here (composition/pipeline layer, documented in
 * api.ts): api.ts (the composition root wires services from those layers),
 * chat-pipeline.ts / v2-chat-pipeline.ts (the engine pipelines), deps.ts,
 * route-authority.ts (the authority choke point), request-schemas.ts (the
 * decode vocabulary), and the transport helpers (async-handler, best-effort,
 * ndjson, fifo-lock, request-abort, route-ports, rate-limit), plus the
 * non-API component/lifecycle/dev-inspector surfaces.
 */

const ROOT = join(__dirname, "..", "..");

const TRANSPORT_ROUTE_FILES = [
  "src/routes/me.ts",
  "src/routes/metrics.ts",
  "src/routes/permissions.ts",
  "src/routes/artifacts.ts",
  "src/routes/undo.ts",
  "src/routes/chat.ts",
  "src/routes/confirmations.ts",
  "src/routes/confirmation-batches.ts",
  "src/routes/operations.ts",
  "src/routes/runs.ts",
  "src/routes/clarifications.ts",
];

const FORBIDDEN_LAYERS = [
  { name: "model", pattern: /^\.\.\/assistant\// },
  { name: "store", pattern: /^\.\.\/db\// },
  { name: "harness", pattern: /^\.\.\/harness\// },
  { name: "assistant-v2 core", pattern: /^\.\.\/assistant-v2\// },
  { name: "presenter", pattern: /^\.\.\/services\/result-presentation-service/ },
  { name: "presenter registry", pattern: /^\.\.\/assistant-v2\/presentation\// },
  { name: "audit/metrics", pattern: /^\.\.\/metrics\// },
  { name: "entity workflows", pattern: /^\.\.\/harness\/workflows\// },
];

interface ParsedImport {
  typeOnly: boolean;
  specifier: string;
  statement: string;
}

function parseImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const pattern = /import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    imports.push({
      typeOnly: match[1] !== undefined,
      specifier: match[2],
      statement: match[0],
    });
  }
  return imports;
}

describe("v2 transport route layer boundaries (T16-F)", () => {
  it("covers every intended transport route file", () => {
    for (const file of TRANSPORT_ROUTE_FILES) {
      expect(() => readFileSync(join(ROOT, file), "utf8"), file).not.toThrow();
    }
  });

  for (const file of TRANSPORT_ROUTE_FILES) {
    it(`${file} has no runtime import from a forbidden layer`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const parsed of parseImports(source)) {
        if (parsed.typeOnly) continue;
        for (const layer of FORBIDDEN_LAYERS) {
          expect(
            layer.pattern.test(parsed.specifier),
            `${file} imports the ${layer.name} layer at runtime: ${parsed.statement}`,
          ).toBe(false);
        }
      }
    });

    it(`${file} performs no direct store access (no deps.store / AppDeps bag)`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, `${file} must not receive the AppDeps bag`).not.toMatch(/\bAppDeps\b/);
      expect(source, `${file} must not touch a store object directly`).not.toMatch(/\.store\./);
    });
  }
});
