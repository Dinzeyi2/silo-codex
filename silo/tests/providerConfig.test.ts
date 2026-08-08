import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProvidersConfig, providerConfigForRole } from "../src/providerConfig.js";

describe("loadProvidersConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "silo-providers-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves ${VAR} placeholders against the given environment", () => {
    const file = path.join(dir, "providers.yaml");
    writeFileSync(
      file,
      [
        "providers:",
        "  database:",
        "    baseUrl: ${DB_BASE_URL}",
        "    apiKey: ${DB_API_KEY}",
        "    model: gpt-silo-db",
        "  auth:",
        "    baseUrl: ${AUTH_BASE_URL}",
      ].join("\n"),
    );

    const providers = loadProvidersConfig(file, {
      DB_BASE_URL: "https://db-provider.example.com",
      DB_API_KEY: "sk-db-123",
    });

    expect(providers.database).toEqual({
      baseUrl: "https://db-provider.example.com",
      apiKey: "sk-db-123",
      model: "gpt-silo-db",
      modelReasoningEffort: undefined,
    });

    // AUTH_BASE_URL was never set, so it resolves to "not provided" rather than the literal placeholder.
    expect(providers.auth?.baseUrl).toBeUndefined();
  });

  it("returns an empty config when the file does not exist", () => {
    expect(loadProvidersConfig(path.join(dir, "missing.yaml"))).toEqual({});
  });
});

describe("providerConfigForRole", () => {
  it("returns an empty object for a role with no configured provider", () => {
    expect(providerConfigForRole("intelligence", {})).toEqual({});
  });
});
