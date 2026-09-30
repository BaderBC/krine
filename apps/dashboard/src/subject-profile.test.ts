import { describe, expect, it } from "vitest";
import {
  profileScopeError,
  provenanceLabel,
  validContext,
  validTimeline,
  visibleGroups,
  type TimelineEntry,
} from "./subject-profile";
import {
  context,
  entries,
  subject,
  timeline,
} from "./subject-profile.test-fixtures";

const valid = (v: unknown) => validTimeline(v, "user", subject, 100, 1000);
describe("direct subject history boundary", () => {
  it.each(["decision", "event"])(
    "rejects an array %s discriminator on a denied decision",
    (kind) => {
      const row = { ...entries()[1]!, kind: [kind] };
      expect(valid({ ...timeline(), items: [row], next_cursor: null })).toBe(
        false,
      );
    },
  );
  it("accepts bounded mixed history and preserves late occurrence, unknown authority and sample markers", () => {
    const value = timeline();
    expect(valid(value)).toBe(true);
    expect(value.items[0]!.summary.sample_data?.dataset_id).toBe(
      "synthetic-demo",
    );
    expect(provenanceLabel(null)).toBe("Unknown source");
    expect(provenanceLabel("future-source")).toBe("Unknown source");
  });
  it.each([
    [
      "another subject",
      (v: any) => {
        v.scope.id = "other";
      },
    ],
    [
      "another kind",
      (v: any) => {
        v.scope.kind = "client";
      },
    ],
    [
      "another requested interval",
      (v: any) => {
        v.range.from = 101;
      },
    ],
    [
      "false empty coverage",
      (v: any) => {
        v.range.effective_from = v.range.effective_to = null;
        v.items = [];
        v.next_cursor = null;
      },
    ],
    [
      "arbitrary clipped coverage",
      (v: any) => {
        v.range.effective_from = 200;
      },
    ],
    [
      "null row",
      (v: any) => {
        v.items = [null];
      },
    ],
    [
      "duplicate row",
      (v: any) => {
        v.items.splice(1, 0, v.items[0]);
      },
    ],
    [
      "wrong attribution",
      (v: any) => {
        v.items[0].summary.user_id = "another-user";
      },
    ],
    [
      "wrong row ID",
      (v: any) => {
        v.items[0].summary.event_id = "other";
      },
    ],
    [
      "wrong timestamp",
      (v: any) => {
        v.items[0].summary.accepted_at = 949;
      },
    ],
    [
      "object event name",
      (v: any) => {
        v.items[0].summary.name = {};
      },
    ],
    [
      "array provenance",
      (v: any) => {
        v.items[0].summary.provenance = ["backend"];
      },
    ],
    [
      "object subject",
      (v: any) => {
        v.items[0].summary.client_id = {};
      },
    ],
    [
      "missing occurrence",
      (v: any) => {
        delete v.items[0].summary.occurred_at;
      },
    ],
    [
      "invalid occurrence",
      (v: any) => {
        v.items[0].summary.occurred_at = 9e15;
      },
    ],
    [
      "unknown decision source",
      (v: any) => {
        v.items[1].summary.source = "new-authority";
      },
    ],
    [
      "array decision source",
      (v: any) => {
        v.items[1].summary.source = ["evaluation"];
      },
    ],
    [
      "object decision reason",
      (v: any) => {
        v.items[1].summary.reason = {};
      },
    ],
    [
      "object decision check",
      (v: any) => {
        v.items[1].summary.check = {};
      },
    ],
    [
      "object decision outcome",
      (v: any) => {
        v.items[1].summary.outcome = {};
      },
    ],
    [
      "missing completion",
      (v: any) => {
        delete v.items[1].summary.completed_at;
      },
    ],
    [
      "outside requested coverage",
      (v: any) => {
        v.items[0].accepted_at = v.items[0].summary.accepted_at = 1001;
      },
    ],
    [
      "out-of-order rows",
      (v: any) => {
        v.items.reverse();
      },
    ],
    [
      "too many rows",
      (v: any) => {
        v.items = Array(51).fill(v.items[0]);
      },
    ],
    [
      "cursor on empty page",
      (v: any) => {
        v.items = [];
      },
    ],
    [
      "empty cursor",
      (v: any) => {
        v.next_cursor = "";
      },
    ],
    [
      "oversized cursor",
      (v: any) => {
        v.next_cursor = "x".repeat(4097);
      },
    ],
    [
      "object sample marker",
      (v: any) => {
        v.items[0].summary.sample_data.dataset_id = {};
      },
    ],
  ])("rejects %s without inventing empty activity", (_name, mutate) => {
    const value = timeline();
    mutate(value);
    expect(valid(value)).toBe(false);
  });
  it("accepts expired and future empty coverage, but rejects a fabricated zero for observable history", () => {
    for (const partial of [
      { retention: { ...timeline().retention, available_since: 1001 } },
      { as_of: 99 },
    ]) {
      const value = timeline({
        ...partial,
        range: {
          ...timeline().range,
          effective_from: null,
          effective_to: null,
        },
        items: [],
        next_cursor: null,
      });
      expect(valid(value)).toBe(true);
    }
    expect(valid(timeline({ items: [], next_cursor: null }))).toBe(true);
    expect(validTimeline(timeline(), "user", subject, 100, 1000, "older")).toBe(
      false,
    );
  });
  it("uses record kind and UTF-8 byte order for ties, rather than locale or UTF-16 order", () => {
    const event = entries()[0]!;
    const decision = entries()[1]!;
    const make = (id: string) =>
      ({
        ...event,
        id,
        accepted_at: 900,
        summary: { ...event.summary, event_id: id, accepted_at: 900 },
      }) as TimelineEntry;
    const value = timeline({ items: [make("𐀀"), make("\ue000"), decision] });
    expect(valid(value)).toBe(true);
    value.items.reverse();
    expect(valid(value)).toBe(false);
  });
  it("allows cross-kind ID reuse, while rejecting duplicate logical records", () => {
    const value = timeline();
    const event = value.items[0]!;
    event.id = "decision_one";
    if (event.kind === "event") event.summary.event_id = "decision_one";
    expect(valid(value)).toBe(true);
  });
  it("does not merge separated session fragments into invented visits", () => {
    const value = entries();
    value[1]!.summary.session_id = null;
    expect(
      visibleGroups(value).map((v) => [v.session, v.entries.length]),
    ).toEqual([
      ["session_one", 1],
      [null, 1],
      ["session_one", 1],
    ]);
    expect(visibleGroups([])).toEqual([]);
  });
});
describe("profile addressing and independent context", () => {
  it.each([".", "..", "  ", "tenant\\x41", "tenant\\", "雪", subject])(
    "keeps exact user ID %j",
    (id) => {
      expect(
        profileScopeError(
          new URLSearchParams({ kind: "user", id, from: "0", to: "1" }),
          "user",
          id,
        ),
      ).toBeNull();
    },
  );
  it.each([
    "id=another",
    "kind=client",
    "from=100",
    "to=1000",
    "cursor=older&cursor=newer",
    "bogus=1",
    "from=",
    "trend=all",
    "range=all",
    "from=9000000000000000&to=9000000000000001",
  ])("rejects ambiguous or unsupported scope %s", (extra) => {
    expect(
      profileScopeError(
        new URLSearchParams(`kind=user&id=one&from=100&to=1000&${extra}`),
        "user",
        "one",
      ),
    ).not.toBeNull();
  });
  it("does not silently complete a partly specified interval or a cursor missing its interval", () => {
    expect(
      profileScopeError(
        new URLSearchParams("kind=user&id=one&from=100"),
        "user",
        "one",
      ),
    ).not.toBeNull();
    expect(
      profileScopeError(
        new URLSearchParams("kind=user&id=one&cursor=older"),
        "user",
        "one",
      ),
    ).not.toBeNull();
  });
  it("rejects malformed current metrics and accepts explicitly unknown live values", () => {
    const value = context();
    value.metrics["user.future"] = {
      version: 1,
      state: { status: "unknown", reason: "unavailable" },
      provenance: { source: "backend", observed_at: 1000 },
    };
    expect(validContext(value, "user", subject)).toBe(true);
    expect(validContext({ ...value, id: "wrong" }, "user", subject)).toBe(
      false,
    );
    expect(
      validContext({ ...value, observed_at: "yesterday" }, "user", subject),
    ).toBe(false);
    value.metrics["user.future"]!.state = { status: "known", value: Infinity };
    expect(validContext(value, "user", subject)).toBe(false);
  });
});
