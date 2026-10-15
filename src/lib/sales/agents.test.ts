import { describe, expect, it } from "vitest";
import { agentFlags, allowedIntents, anyAgentOn, type AgentSettingsLike } from "@/lib/ai/agents";
import { buildIntentSchema, NOT_AVAILABLE_REPLY, parseIntent } from "./intents";
import { buildSystemPromptText, type PromptInput } from "./agent-prompts";
import { dateInputFrom, dueFromDateInput, formatDue, isDueSoon, jobUpdateMessage } from "./job";

const acct = (over: Partial<AgentSettingsLike> & { enabled?: boolean; mode?: "ai" | "rules" } = {}): AgentSettingsLike => ({
  salesAgent: { enabled: over.enabled ?? false, mode: over.mode ?? "ai" },
  agents: over.agents ?? null,
});

describe("which agents are working", () => {
  it("is the sales rep's own switch for the sales rep", () => {
    expect(agentFlags(acct({ enabled: true })).salesRep).toBe(true);
    expect(agentFlags(acct({ enabled: false })).salesRep).toBe(false);
  });

  it("starts the new agents switched off for accounts that predate them", () => {
    const f = agentFlags(acct({ enabled: true }));
    expect(f.secretary).toBe(false);
    expect(f.projectManager).toBe(false);
  });

  it("turns the secretary and project manager on from their own switches", () => {
    const f = agentFlags(acct({ agents: { secretary: true, projectManager: true } }));
    expect(f).toEqual({ salesRep: false, secretary: true, projectManager: true });
  });

  it("ignores those two in keyword-rules mode, where there is no model to run them", () => {
    const f = agentFlags(acct({ enabled: true, mode: "rules", agents: { secretary: true, projectManager: true } }));
    expect(f).toEqual({ salesRep: true, secretary: false, projectManager: false });
  });

  it("knows when nothing is on", () => {
    expect(anyAgentOn(agentFlags(acct()))).toBe(false);
    expect(anyAgentOn(agentFlags(acct({ agents: { projectManager: true } })))).toBe(true);
  });
});

describe("what the model may ask for", () => {
  it("always allows talking and handing over", () => {
    expect(allowedIntents({ salesRep: false, secretary: false, projectManager: true })).toEqual(["chat", "handoff"]);
  });

  it("gives the sales rep orders, prices, photos and cancellations", () => {
    const i = allowedIntents({ salesRep: true, secretary: false, projectManager: false });
    expect(i).toEqual(expect.arrayContaining(["place_order", "price_list", "cancel_order", "send_photos"]));
    expect(i).not.toContain("log_enquiry");
  });

  it("gives the secretary enquiries and nothing that sells", () => {
    const i = allowedIntents({ salesRep: false, secretary: true, projectManager: false });
    expect(i).toContain("log_enquiry");
    expect(i).not.toContain("place_order");
  });

  it("puts the allowed list in the schema the model is held to", () => {
    const s = buildIntentSchema({ salesRep: false, secretary: true, projectManager: false }) as {
      properties: { intent: { enum: string[] }; enquiry_summary?: unknown };
      required: string[];
    };
    expect(s.properties.intent.enum).toEqual(["chat", "handoff", "log_enquiry"]);
    expect(s.required).toContain("enquiry_summary");
  });

  it("never names an action in the schema that this business has switched off", () => {
    const secretary = JSON.stringify(buildIntentSchema({ salesRep: false, secretary: true, projectManager: false }));
    expect(secretary).not.toContain("place_order");
    expect(secretary).not.toContain("send_photos");
    const sales = JSON.stringify(buildIntentSchema({ salesRep: true, secretary: false, projectManager: false }));
    expect(sales).toContain("place_order");
    expect(sales).not.toContain("log_enquiry");
  });

  it("leaves the enquiry fields out when the secretary is off", () => {
    const s = buildIntentSchema({ salesRep: true, secretary: false, projectManager: false }) as { properties: Record<string, unknown>; required: string[] };
    expect(s.properties.enquiry_summary).toBeUndefined();
    expect(s.required).not.toContain("enquiry_summary");
  });
});

describe("reading the model's answer", () => {
  const ids = new Set(["p1"]);
  const salesOnly = allowedIntents({ salesRep: true, secretary: false, projectManager: false });
  const secretaryOnly = allowedIntents({ salesRep: false, secretary: true, projectManager: false });

  it("accepts an order when the sales rep is on", () => {
    const i = parseIntent({ reply: "Done", intent: "place_order", items: [{ product_id: "p1", quantity: 2 }] }, ids, salesOnly);
    expect(i?.intent).toBe("place_order");
    expect(i?.items).toEqual([{ product_id: "p1", quantity: 2 }]);
  });

  it("does NOT honour an order when the sales rep is off — it becomes a handoff with a safe reply", () => {
    const i = parseIntent({ reply: "Great, I've placed your order!", intent: "place_order", items: [{ product_id: "p1", quantity: 2 }] }, ids, secretaryOnly);
    expect(i?.intent).toBe("handoff");
    expect(i?.items).toEqual([]);
    expect(i?.reply).toBe(NOT_AVAILABLE_REPLY);
    expect(i?.reply).not.toMatch(/placed/i);
  });

  it("treats the same for price lists, cancellations and photos", () => {
    for (const intent of ["price_list", "cancel_order", "send_photos"]) {
      expect(parseIntent({ reply: "x", intent }, ids, secretaryOnly)?.intent).toBe("handoff");
    }
  });

  it("does not honour an enquiry when the secretary is off", () => {
    const i = parseIntent({ reply: "Noted", intent: "log_enquiry", enquiry_summary: "500 flyers" }, ids, salesOnly);
    expect(i?.intent).toBe("handoff");
    expect(i?.enquiry).toBeNull();
  });

  it("reads an enquiry when the secretary is on", () => {
    const i = parseIntent({ reply: "Noted", intent: "log_enquiry", enquiry_summary: " 500 flyers for a church ", enquiry_deadline: "Friday" }, ids, secretaryOnly);
    expect(i?.intent).toBe("log_enquiry");
    expect(i?.enquiry).toEqual({ summary: "500 flyers for a church", deadline: "Friday" });
  });

  it("keeps a missing deadline as null", () => {
    const i = parseIntent({ reply: "ok", intent: "log_enquiry", enquiry_summary: "A logo", enquiry_deadline: "   " }, ids, secretaryOnly);
    expect(i?.enquiry?.deadline).toBeNull();
  });

  it("will not log an enquiry that says nothing", () => {
    const i = parseIntent({ reply: "ok", intent: "log_enquiry", enquiry_summary: "  " }, ids, secretaryOnly);
    expect(i?.intent).toBe("chat");
    expect(i?.enquiry).toBeNull();
  });

  it("treats an unknown intent as plain chat", () => {
    expect(parseIntent({ reply: "hi", intent: "give_discount" }, ids, salesOnly)?.intent).toBe("chat");
  });

  it("drops products that are not in the catalogue", () => {
    const i = parseIntent({ reply: "x", intent: "place_order", items: [{ product_id: "nope", quantity: 1 }, { product_id: "p1", quantity: 1 }] }, ids, salesOnly);
    expect(i?.items).toEqual([{ product_id: "p1", quantity: 1 }]);
  });

  it("rejects anything that is not an object", () => {
    expect(parseIntent("text", ids, salesOnly)).toBeNull();
    expect(parseIntent(null, ids, salesOnly)).toBeNull();
  });
});

describe("the prompt", () => {
  const base: PromptInput = {
    agentName: "Amaka",
    businessName: "Ada Fabrics",
    instructions: "Be warm.",
    flags: { salesRep: false, secretary: false, projectManager: false },
    catalogueLines: ["p1 | Lace | ₦5,000 | in stock"],
    knowledge: "ABOUT THE BUSINESS:\nWe sell lace.",
    openOrderText: "The customer has an UNPAID order ORD-1",
    jobLines: ["- ORD-7: Flyers — In progress — due Fri 17 Oct"],
  };
  const withFlags = (flags: Partial<PromptInput["flags"]>) => buildSystemPromptText({ ...base, flags: { ...base.flags, ...flags } });

  it("shows the catalogue and the order rules only to the sales rep", () => {
    const on = withFlags({ salesRep: true });
    expect(on).toContain("CATALOGUE");
    expect(on).toContain("Lace");
    expect(on).toContain("place_order");
    const off = withFlags({ secretary: true });
    expect(off).not.toContain("CATALOGUE");
    expect(off).not.toContain("Lace");
    expect(off).not.toContain("place_order");
  });

  it("tells a business without the sales rep that it cannot quote or take orders", () => {
    expect(withFlags({ secretary: true })).toMatch(/cannot take orders or quote prices/i);
    expect(withFlags({ salesRep: true })).not.toMatch(/cannot take orders or quote prices/i);
  });

  it("gives the secretary the enquiry rules, and says the team quotes when there is no sales rep", () => {
    const p = withFlags({ secretary: true });
    expect(p).toContain("log_enquiry");
    expect(p).toContain("enquiry_summary");
    expect(p).toMatch(/team will send a quote/i);
    expect(withFlags({ salesRep: true })).not.toContain("log_enquiry");
  });

  it("lets a secretary with the sales rep order from the catalogue instead", () => {
    const p = withFlags({ salesRep: true, secretary: true });
    expect(p).not.toMatch(/team will send a quote/i);
    expect(p).toMatch(/help them order it as the sales rep/i);
  });

  it("shows a customer's jobs only to the project manager", () => {
    const on = withFlags({ projectManager: true });
    expect(on).toContain("CUSTOMER'S JOBS");
    expect(on).toContain("ORD-7: Flyers — In progress");
    expect(withFlags({ secretary: true })).not.toContain("ORD-7");
  });

  it("says so plainly when the customer has no jobs", () => {
    const p = buildSystemPromptText({ ...base, flags: { salesRep: false, secretary: false, projectManager: true }, jobLines: [] });
    expect(p).toContain("this customer has no jobs yet");
  });

  it("keeps the unpaid order out of a prompt that cannot act on it", () => {
    expect(withFlags({ secretary: true })).not.toContain("UNPAID");
    expect(withFlags({ salesRep: true })).toContain("UNPAID");
  });

  it("names exactly the agents that are on", () => {
    const p = withFlags({ salesRep: true, projectManager: true });
    expect(p).toContain("the sales rep");
    expect(p).toContain("the project manager");
    expect(p).not.toContain("the secretary");
  });

  it("says there is no knowledge base when the merchant wrote none", () => {
    expect(buildSystemPromptText({ ...base, knowledge: null, flags: { salesRep: true, secretary: false, projectManager: false } })).toMatch(/no knowledge base yet/i);
  });
});

describe("job updates", () => {
  const due = new Date("2026-10-17T22:59:00Z"); // 23:59 in Lagos

  it("says nothing for a job that has not started", () => {
    expect(jobUpdateMessage("ORD-3", { stage: "queued", dueAt: null, note: null })).toBeNull();
  });

  it("tells the customer when work starts, with the date if there is one", () => {
    expect(jobUpdateMessage("ORD-3", { stage: "in_progress", dueAt: due, note: null })).toBe("Good news — we've started work on ORD-3. We expect to have it ready by Sat 17 Oct.");
    expect(jobUpdateMessage("ORD-3", { stage: "in_progress", dueAt: null, note: null })).toBe("Good news — we've started work on ORD-3.");
  });

  it("passes on the merchant's note, trimmed", () => {
    expect(jobUpdateMessage("ORD-3", { stage: "ready", dueAt: null, note: "  Collect from the shop.  " })).toBe("ORD-3 is ready! 🎉 Collect from the shop.");
    expect(jobUpdateMessage("ORD-3", { stage: "awaiting_customer", dueAt: null, note: "Please send your logo." })).toContain("Please send your logo.");
  });

  it("closes the loop when it is done", () => {
    expect(jobUpdateMessage("ORD-3", { stage: "done", dueAt: null, note: null })).toMatch(/ORD-3 is complete/);
  });

  it("caps a very long note", () => {
    const msg = jobUpdateMessage("ORD-3", { stage: "ready", dueAt: null, note: "x".repeat(900) })!;
    expect(msg.length).toBeLessThan(340);
  });
});

describe("job dates", () => {
  it("treats a picked day as the END of that day in Lagos, so Saturday morning is not overdue", () => {
    const d = dueFromDateInput("2026-10-17")!;
    expect(d.toISOString()).toBe("2026-10-17T22:59:00.000Z");
    expect(d.getTime() - new Date("2026-10-17T07:00:00Z").getTime()).toBeGreaterThan(0);
  });

  it("round-trips through the date box", () => {
    expect(dateInputFrom(dueFromDateInput("2026-10-17"))).toBe("2026-10-17");
    expect(dateInputFrom(null)).toBe("");
    expect(dateInputFrom("not a date")).toBe("");
  });

  it("rejects dates it cannot read", () => {
    expect(dueFromDateInput("17/10/2026")).toBeNull();
    expect(dueFromDateInput("2026-13-45")).toBeNull();
    expect(dueFromDateInput(undefined)).toBeNull();
  });

  it("formats in Lagos time whatever the server zone", () => {
    expect(formatDue(new Date("2026-10-17T22:59:00Z"))).toBe("Sat 17 Oct");
    // 23:30 UTC on the 17th is already the 18th in Lagos
    expect(formatDue(new Date("2026-10-17T23:30:00Z"))).toBe("Sun 18 Oct");
  });
});

describe("when the owner is reminded", () => {
  const now = new Date("2026-10-16T09:00:00Z").getTime();
  const job = (stage: "in_progress" | "done", due: string | null) => ({ stage, dueAt: due ? new Date(due) : null });

  it("reminds when it is due within a day", () => {
    expect(isDueSoon(job("in_progress", "2026-10-17T08:00:00Z"), now)).toBe(true);
  });

  it("reminds when it is already overdue", () => {
    expect(isDueSoon(job("in_progress", "2026-10-10T08:00:00Z"), now)).toBe(true);
  });

  it("stays quiet when the deadline is further off", () => {
    expect(isDueSoon(job("in_progress", "2026-10-20T08:00:00Z"), now)).toBe(false);
  });

  it("stays quiet for finished jobs and jobs with no date", () => {
    expect(isDueSoon(job("done", "2026-10-10T08:00:00Z"), now)).toBe(false);
    expect(isDueSoon(job("in_progress", null), now)).toBe(false);
  });
});
