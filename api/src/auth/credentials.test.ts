import { describe, expect, it } from "vitest";
import { credentialsMatch } from "./credentials.js";

const expected = { username: "operator", password: "correct-horse" };

describe("credentialsMatch", () => {
  it("matches identical username and password", () => {
    expect(credentialsMatch({ ...expected }, expected)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(
      credentialsMatch({ username: "operator", password: "wrong" }, expected),
    ).toBe(false);
  });

  it("rejects a wrong username", () => {
    expect(
      credentialsMatch(
        { username: "someone-else", password: "correct-horse" },
        expected,
      ),
    ).toBe(false);
  });

  it("rejects inputs of a different length than expected", () => {
    expect(
      credentialsMatch({ username: "operator", password: "short" }, expected),
    ).toBe(false);
  });
});
