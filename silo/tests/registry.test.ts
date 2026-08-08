import path from "node:path";
import { computeRegistryHash, contractsReadableByRole, loadRegistry } from "../src/registryLoader.js";
import { validateRegistry } from "../src/registryValidator.js";
import { loadAndValidateOwnershipConfig } from "../src/ownershipConfigLoader.js";
import { SAMPLE_PROJECT } from "./testRepo.js";

const ARCHITECTURE_DIR = path.join(SAMPLE_PROJECT, "architecture");
const OWNERSHIP_PATH = path.join(SAMPLE_PROJECT, "silo", "config", "ownership.yaml");

describe("the bundled sample-project registry", () => {
  it("loads with product, domains, contracts, and a version", () => {
    const registry = loadRegistry(ARCHITECTURE_DIR);
    expect(registry.product.name).toBe("Acme Subscriptions");
    expect(Object.keys(registry.domains)).toEqual(
      expect.arrayContaining(["database", "auth", "billing", "frontend", "intelligence", "infrastructure"]),
    );
    expect(registry.contracts["api:auth"]?.kind).toBe("api");
    expect(registry.contracts["type:user"]?.kind).toBe("type");
    expect(registry.contracts["event:user-created"]?.kind).toBe("event");
    expect(registry.versionsLock.version).toBe("1.0.0");
  });

  it("passes validation against the matching ownership config with zero issues", () => {
    const ownership = loadAndValidateOwnershipConfig(OWNERSHIP_PATH);
    const registry = loadRegistry(ARCHITECTURE_DIR);
    expect(validateRegistry(registry, ownership)).toEqual([]);
  });

  it("produces a stable content hash independent of property insertion order", () => {
    const registry = loadRegistry(ARCHITECTURE_DIR);
    const hash1 = computeRegistryHash(registry);
    const hash2 = computeRegistryHash(registry);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("grants frontend read access to the auth and billing API contracts, not their implementations", () => {
    const registry = loadRegistry(ARCHITECTURE_DIR);
    const readable = contractsReadableByRole("frontend", registry);
    expect(readable).toEqual(expect.arrayContaining(["api:auth", "api:billing"]));
  });
});

describe("validateRegistry", () => {
  it("flags a domain dependency on an unknown domain", () => {
    const registry = loadRegistry(ARCHITECTURE_DIR);
    registry.domains.frontend!.dependsOn = ["not-a-real-domain"];
    const issues = validateRegistry(registry);
    expect(issues.some((i) => i.includes("unknown domain 'not-a-real-domain'"))).toBe(true);
  });

  it("flags a permission grant referencing an unknown contract", () => {
    const registry = loadRegistry(ARCHITECTURE_DIR);
    registry.permissions.frontend = { canRead: ["api:does-not-exist"] };
    const issues = validateRegistry(registry);
    expect(issues.some((i) => i.includes("unknown contract 'api:does-not-exist'"))).toBe(true);
  });

  it("flags a non-semver versions.lock", () => {
    const registry = loadRegistry(ARCHITECTURE_DIR);
    registry.versionsLock.version = "not-a-version";
    const issues = validateRegistry(registry);
    expect(issues.some((i) => i.includes("not valid semver"))).toBe(true);
  });

  it("flags an OpenAPI contract missing 'paths'", () => {
    const registry = loadRegistry(ARCHITECTURE_DIR);
    registry.contracts["api:auth"]!.content = { openapi: "3.0.3", info: { title: "x", version: "1" } };
    const issues = validateRegistry(registry);
    expect(issues.some((i) => i.includes("declares no paths"))).toBe(true);
  });
});
