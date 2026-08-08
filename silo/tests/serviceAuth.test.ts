import { isAuthorized, requireServiceToken } from "../src/serviceAuth.js";

describe("requireServiceToken", () => {
  it("accepts a 32+ char URL-safe token", () => {
    const token = "a".repeat(32);
    expect(requireServiceToken(token)).toBe(token);
  });

  it("rejects an unset token", () => {
    expect(() => requireServiceToken(undefined)).toThrow(/SILO_SERVICE_TOKEN/);
  });

  it("rejects a token shorter than 32 characters", () => {
    expect(() => requireServiceToken("short")).toThrow(/32/);
  });

  it("rejects a token with non-URL-safe characters", () => {
    expect(() => requireServiceToken("a".repeat(31) + " ")).toThrow();
    expect(() => requireServiceToken("a".repeat(31) + "!")).toThrow();
  });
});

describe("isAuthorized", () => {
  const serviceToken = "s".repeat(40);

  it("accepts the correct bearer token", () => {
    expect(isAuthorized(`Bearer ${serviceToken}`, serviceToken)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(isAuthorized(undefined, serviceToken)).toBe(false);
  });

  it("rejects a header without the Bearer scheme", () => {
    expect(isAuthorized(serviceToken, serviceToken)).toBe(false);
  });

  it("rejects the wrong token", () => {
    expect(isAuthorized(`Bearer ${"x".repeat(40)}`, serviceToken)).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    expect(isAuthorized(`Bearer short`, serviceToken)).toBe(false);
  });
});
