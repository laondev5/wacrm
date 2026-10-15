import { describe, expect, it } from "vitest";
import { ChainFailedError, COOLDOWN_MS, orderForAttempt, runChain, worstKind, type ChainMember, type ErrorKind } from "./chain-core";

const NOW = 1_000_000;
const member = (id: string, health?: ChainMember["health"]): ChainMember => ({ id, model: `model-${id}`, health });
const cooling = (): ChainMember["health"] => ({ ok: false, cooldownUntil: new Date(NOW + 60_000) });
const expired = (): ChainMember["health"] => ({ ok: false, cooldownUntil: new Date(NOW - 1) });

class Boom extends Error {
  constructor(readonly kind: ErrorKind, readonly plain?: string) {
    super(`boom ${kind}`);
  }
}
const classify = (err: unknown) => {
  const e = err as Boom;
  return { kind: e.kind ?? "other", message: e.message, salvage: e.plain ?? null };
};

describe("orderForAttempt", () => {
  it("keeps the configured order when everything is healthy", () => {
    expect(orderForAttempt([member("a"), member("b"), member("c")], NOW).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("sends a model that is cooling down to the back", () => {
    const list = [member("a", cooling()), member("b"), member("c")];
    expect(orderForAttempt(list, NOW).map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("forgives a cooldown that has run out", () => {
    const list = [member("a", expired()), member("b")];
    expect(orderForAttempt(list, NOW).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("still tries everything when every model is cooling down", () => {
    const list = [member("a", cooling()), member("b", cooling())];
    expect(orderForAttempt(list, NOW).map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("runChain", () => {
  const opts = { timeouts: [30_000, 20_000], classify, now: () => NOW };

  it("uses the primary when it works and never touches the others", async () => {
    const called: string[] = [];
    const out = await runChain([member("a"), member("b")], async (m) => (called.push(m.id), "ok-" + m.id), opts);
    expect(out.value).toBe("ok-a");
    expect(called).toEqual(["a"]);
    expect(out.attempts).toHaveLength(1);
  });

  it("falls through to the next model, recording each failure", async () => {
    const out = await runChain(
      [member("a"), member("b"), member("c")],
      async (m) => {
        if (m.id === "a") throw new Boom("quota");
        if (m.id === "b") throw new Boom("timeout");
        return "from-c";
      },
      opts,
    );
    expect(out.value).toBe("from-c");
    expect(out.member.id).toBe("c");
    expect(out.attempts.map((a) => [a.id, a.ok, a.kind])).toEqual([
      ["a", false, "quota"],
      ["b", false, "timeout"],
      ["c", true, null],
    ]);
  });

  it("gives the first attempt the long deadline and later ones the short one", async () => {
    const seen: number[] = [];
    await runChain(
      [member("a"), member("b"), member("c")],
      async (_m, ms) => {
        seen.push(ms);
        if (seen.length < 3) throw new Boom("other");
        return "x";
      },
      opts,
    );
    expect(seen).toEqual([30_000, 20_000, 20_000]);
  });

  it("gives the last model in line the long deadline, since nobody follows it", async () => {
    const seen: number[] = [];
    await runChain(
      [member("a"), member("b"), member("c")],
      async (_m, ms) => {
        seen.push(ms);
        if (seen.length < 3) throw new Boom("other");
        return "x";
      },
      { ...opts, timeouts: [30_000, 20_000], finalTimeoutMs: 60_000 },
    );
    expect(seen).toEqual([30_000, 20_000, 60_000]);
  });

  it("does not cut a lone model short — a chain of one gets the long deadline", async () => {
    const seen: number[] = [];
    await runChain([member("a")], async (_m, ms) => (seen.push(ms), "ok"), { ...opts, timeouts: [30_000], finalTimeoutMs: 60_000 });
    expect(seen).toEqual([60_000]);
  });

  it("never shortens a deadline that was already longer", async () => {
    const seen: number[] = [];
    await runChain([member("a")], async (_m, ms) => (seen.push(ms), "ok"), { ...opts, timeouts: [90_000], finalTimeoutMs: 60_000 });
    expect(seen).toEqual([90_000]);
  });

  it("throws once every model has failed, reporting the most actionable cause", async () => {
    const err = await runChain(
      [member("a"), member("b")],
      async (m) => {
        throw new Boom(m.id === "a" ? "timeout" : "quota");
      },
      opts,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ChainFailedError);
    expect(err.kind).toBe("quota");
    expect(err.attempts).toHaveLength(2);
  });

  it("keeps a reply the model wrote without JSON as a last resort", async () => {
    const err = await runChain(
      [member("a"), member("b")],
      async (m) => {
        throw new Boom("other", m.id === "a" ? "Sure, send the file here." : undefined);
      },
      opts,
    ).catch((e) => e);
    expect(err.salvage).toBe("Sure, send the file here.");
  });

  it("does not let a later model overwrite an earlier salvaged reply", async () => {
    const err = await runChain(
      [member("a"), member("b")],
      async (m) => {
        throw new Boom("other", m.id === "a" ? "first" : "second");
      },
      opts,
    ).catch((e) => e);
    expect(err.salvage).toBe("first");
  });

  it("reports an empty chain plainly", async () => {
    const err = await runChain([], async () => "x", opts).catch((e) => e);
    expect(err).toBeInstanceOf(ChainFailedError);
    expect(err.message).toMatch(/No AI model is configured/);
  });

  it("reports every outcome so health can be recorded", async () => {
    const seen: Array<[string, boolean, number]> = [];
    await runChain(
      [member("a"), member("b")],
      async (m) => {
        if (m.id === "a") throw new Boom("quota");
        return "ok";
      },
      { ...opts, onOutcome: (m, o) => void seen.push([m.id, o.ok, o.cooldownMs]) },
    );
    expect(seen).toEqual([
      ["a", false, COOLDOWN_MS.quota],
      ["b", true, 0],
    ]);
  });

  it("tries a cooling primary last, so a dead one does not cost every customer a timeout", async () => {
    const order: string[] = [];
    await runChain([member("a", cooling()), member("b")], async (m) => (order.push(m.id), "ok"), opts);
    expect(order).toEqual(["b"]);
  });
});

describe("worstKind", () => {
  it("ranks out-of-credit above everything, then a bad key", () => {
    expect(worstKind(["timeout", "quota", "other"])).toBe("quota");
    expect(worstKind(["timeout", "auth"])).toBe("auth");
    expect(worstKind([null, "other"])).toBe("other");
    expect(worstKind([])).toBe("other");
  });
});
