import { describe, expect, it } from "vitest";
import { buildEvolutionStatusPatch, type EvolutionStatusRow } from "./evolution-status-sync";

const connectedRow: EvolutionStatusRow = {
  status: "connected",
  connected_at: "2026-07-01T00:00:00.000Z",
  disconnected_at: null,
};

const disconnectedRow: EvolutionStatusRow = {
  status: "disconnected",
  connected_at: null,
  disconnected_at: "2026-07-01T00:00:00.000Z",
};

describe("buildEvolutionStatusPatch", () => {
  it("returns null when already connected and observed connected", () => {
    expect(buildEvolutionStatusPatch(connectedRow, true)).toBeNull();
  });

  it("returns null when already disconnected and observed disconnected", () => {
    expect(buildEvolutionStatusPatch(disconnectedRow, false)).toBeNull();
  });

  it("patches status + connected_at on a disconnected -> connected transition", () => {
    const patch = buildEvolutionStatusPatch(disconnectedRow, true);
    expect(patch).not.toBeNull();
    expect(patch).toMatchObject({ status: "connected" });
    expect(typeof patch!.connected_at).toBe("string");
    expect(patch).not.toHaveProperty("disconnected_at");
  });

  it("patches status + disconnected_at on a connected -> disconnected transition", () => {
    const patch = buildEvolutionStatusPatch(connectedRow, false);
    expect(patch).not.toBeNull();
    expect(patch).toMatchObject({ status: "disconnected" });
    expect(typeof patch!.disconnected_at).toBe("string");
    expect(patch).not.toHaveProperty("connected_at");
  });

  it("does not clear the opposite timestamp on a transition", () => {
    // A row that has both a past connected_at and disconnected_at
    // (reconnected before, disconnected again) transitioning back to
    // connected should keep its old disconnected_at as history.
    const row: EvolutionStatusRow = {
      status: "disconnected",
      connected_at: "2026-06-01T00:00:00.000Z",
      disconnected_at: "2026-07-01T00:00:00.000Z",
    };
    const patch = buildEvolutionStatusPatch(row, true);
    expect(patch).not.toHaveProperty("disconnected_at");
  });
});
