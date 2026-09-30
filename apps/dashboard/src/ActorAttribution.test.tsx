import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ActorAttribution, validOptionalActor } from "./ActorAttribution";
afterEach(cleanup);
it("shows captured name and immutable operator identity", () => {
  render(
    <ActorAttribution
      value={{ id: "op_alex", type: "operator", name: "Alex at publication" }}
    />,
  );
  expect(screen.getByText(/Alex at publication/)).toBeTruthy();
  expect(screen.getByText("(op_alex)")).toBeTruthy();
});
it.each([undefined, null])(
  "does not invent an individual for a missing legacy actor",
  (value) => {
    render(<ActorAttribution value={value} legacy="administrator" />);
    expect(screen.getByText("Shared administrator (legacy)")).toBeTruthy();
    expect(validOptionalActor(value)).toBe(true);
  },
);
it("distinguishes unavailable attribution from a raw stable legacy actor ID", () => {
  render(<ActorAttribution value={null} legacy="op_previous" />);
  expect(screen.getByText("op_previous · name not recorded")).toBeTruthy();
});
it.each(["operator", "installation_recovery", "installation_configuration"])(
  "does not coerce array-valued actor type %s",
  (type) => {
    const malformed = { id: "op_alex", type: [type], name: "Pretended actor" };
    render(<ActorAttribution value={malformed} />);
    expect(screen.getByText("Attribution could not be read")).toBeTruthy();
    expect(validOptionalActor(malformed)).toBe(false);
    expect(screen.queryByText("Pretended actor")).toBeNull();
  },
);
it("host configuration never appears as a named human", () => {
  render(
    <ActorAttribution
      value={{
        id: "installation_configuration",
        type: "installation_configuration",
        name: "Installation configuration",
      }}
    />,
  );
  expect(screen.getByText("Host configuration")).toBeTruthy();
});
