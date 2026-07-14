import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { fifoAsyncHandler } from "../../src/routes/async-handler.js";
import { KeyedFifo } from "../../src/routes/fifo-lock.js";

type FakeRequest = Request & { testId: string };

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;

  end(): this {
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  disconnect(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function requestWithId(testId: string): FakeRequest {
  return { testId, aborted: false } as unknown as FakeRequest;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not settle");
}

describe("fifoAsyncHandler", () => {
  it("holds the FIFO until the whole async handler settles, even after the response finishes", async () => {
    const fifo = new KeyedFifo();
    let releaseBookkeeping!: () => void;
    const bookkeeping = new Promise<void>((resolve) => { releaseBookkeeping = resolve; });
    const started: string[] = [];
    const handler = fifoAsyncHandler(
      fifo,
      () => "session-1",
      async (req, res) => {
        const id = (req as FakeRequest).testId;
        started.push(id);
        if (id === "first") {
          (res as unknown as FakeResponse).end();
          await bookkeeping;
        }
      },
    );
    const next = vi.fn() as unknown as NextFunction;

    handler(requestWithId("first"), new FakeResponse() as unknown as Response, next);
    await until(() => started.includes("first"));
    handler(requestWithId("second"), new FakeResponse() as unknown as Response, next);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["first"]);

    releaseBookkeeping();
    await until(() => started.includes("second"));
    expect(started).toEqual(["first", "second"]);
    expect(next).not.toHaveBeenCalled();
  });

  it("skips a disconnected queued request and leaves the FIFO tail healthy", async () => {
    const fifo = new KeyedFifo();
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    const handler = fifoAsyncHandler(
      fifo,
      () => "session-1",
      async (req) => {
        const id = (req as FakeRequest).testId;
        started.push(id);
        if (id === "first") await blocked;
      },
    );
    const next = vi.fn() as unknown as NextFunction;
    const disconnected = new FakeResponse();

    handler(requestWithId("first"), new FakeResponse() as unknown as Response, next);
    await until(() => started.includes("first"));
    handler(requestWithId("disconnected"), disconnected as unknown as Response, next);
    handler(requestWithId("third"), new FakeResponse() as unknown as Response, next);
    disconnected.disconnect();
    releaseFirst();

    await until(() => started.includes("third"));
    expect(started).toEqual(["first", "third"]);
    expect(next).not.toHaveBeenCalled();
  });
});
