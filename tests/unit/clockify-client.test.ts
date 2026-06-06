import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceClockifyClient,
  type ClockifyClientFactory,
} from "../../src/clockify/client.js";

describe("createWorkspaceClockifyClient", () => {
  it("passes the addonToken and backendUrl (as environment) to the factory", () => {
    const workspace = vi.fn((id: string) => ({ scopedTo: id }));
    const factory = vi.fn(() => ({ workspace })) as unknown as ClockifyClientFactory;

    createWorkspaceClockifyClient(
      { addonToken: "addon-token", backendUrl: "https://api.clockify.me", workspaceId: "ws-1" },
      factory,
    );

    expect(factory).toHaveBeenCalledWith({
      addonToken: "addon-token",
      environment: "https://api.clockify.me",
    });
  });

  it("scopes the returned client to the workspace id", () => {
    const workspace = vi.fn((id: string) => ({ scopedTo: id }));
    const factory = vi.fn(() => ({ workspace })) as unknown as ClockifyClientFactory;

    const result = createWorkspaceClockifyClient(
      { addonToken: "addon-token", workspaceId: "ws-42" },
      factory,
    );

    expect(workspace).toHaveBeenCalledWith("ws-42");
    expect(result).toEqual({ scopedTo: "ws-42" });
  });

  it("never passes apiKey to the factory", () => {
    const factory = vi.fn(() => ({ workspace: () => ({}) })) as unknown as ClockifyClientFactory;

    createWorkspaceClockifyClient({ addonToken: "addon-token", workspaceId: "ws-1" }, factory);

    const options = (factory as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls[0][0];
    expect(options).not.toHaveProperty("apiKey");
    expect(options.environment).toBeUndefined();
  });
});
