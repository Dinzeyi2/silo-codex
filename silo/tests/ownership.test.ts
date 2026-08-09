import {
  checkBoundaries,
  classifyPath,
  normalizeRelativePath,
  ownedRootsForRole,
  validateOwnershipConfig,
} from "../src/ownership.js";
import type { OwnershipConfig } from "../src/types.js";

const config: OwnershipConfig = {
  roles: {
    database: { owns: ["db/", "migrations/", "schema/"] },
    auth: { owns: ["auth/", "security/"] },
    frontend: { owns: ["ui/", "web/", "mobile/"] },
  },
};

describe("normalizeRelativePath", () => {
  it("strips leading ./ and /", () => {
    expect(normalizeRelativePath("./db/users.sql")).toBe("db/users.sql");
    expect(normalizeRelativePath("/db/users.sql")).toBe("db/users.sql");
  });

  it("rejects paths that escape the repo root", () => {
    expect(() => normalizeRelativePath("../etc/passwd")).toThrow(/escapes/);
    expect(() => normalizeRelativePath("db/../../etc/passwd")).toThrow(/escapes/);
  });
});

describe("validateOwnershipConfig", () => {
  it("accepts a well-formed, non-overlapping config", () => {
    expect(validateOwnershipConfig(config)).toEqual([]);
  });

  it("rejects a role named 'architecture'", () => {
    const issues = validateOwnershipConfig({
      roles: { architecture: { owns: ["x/"] } },
    });
    expect(issues.some((i) => i.includes("reserved"))).toBe(true);
  });

  it("rejects a role that owns a path under architecture/", () => {
    const issues = validateOwnershipConfig({
      roles: { database: { owns: ["architecture/api/"] } },
    });
    expect(issues.some((i) => i.includes("belongs to the architecture registry"))).toBe(true);
  });

  it("rejects overlapping owned roots between two roles", () => {
    const issues = validateOwnershipConfig({
      roles: {
        a: { owns: ["shared/"] },
        b: { owns: ["shared/sub/"] },
      },
    });
    expect(issues.some((i) => i.includes("overlaps"))).toBe(true);
  });

  it("rejects a role that owns nothing", () => {
    const issues = validateOwnershipConfig({ roles: { empty: { owns: [] } } });
    expect(issues.some((i) => i.includes("owns no paths"))).toBe(true);
  });
});

describe("classifyPath", () => {
  it("classifies a path under a role's owned root", () => {
    expect(classifyPath("db/users.sql", config)).toEqual({ path: "db/users.sql", owner: "database" });
  });

  it("classifies architecture/ paths as 'architecture', never a role", () => {
    expect(classifyPath("architecture/api/auth.openapi.yaml", config).owner).toBe("architecture");
  });

  it("classifies a path outside every owned root as 'unowned'", () => {
    expect(classifyPath("README.md", config).owner).toBe("unowned");
  });

  it("does not let a similarly-prefixed path count as owned (db-tools/ is not under db/)", () => {
    expect(classifyPath("db-tools/script.sh", config).owner).toBe("unowned");
  });
});

describe("checkBoundaries", () => {
  it("produces no violations when every changed path is owned by the role", () => {
    const violations = checkBoundaries(
      "database",
      [
        { path: "db/users.sql", operation: "add" },
        { path: "migrations/0001.sql", operation: "add" },
      ],
      config,
    );
    expect(violations).toEqual([]);
  });

  it("flags a cross-domain write as BOUNDARY_VIOLATION", () => {
    const violations = checkBoundaries("auth", [{ path: "db/users.sql", operation: "modify" }], config);
    expect(violations).toEqual([
      {
        code: "BOUNDARY_VIOLATION",
        role: "auth",
        path: "db/users.sql",
        owner: "database",
        operation: "modify",
      },
    ]);
  });

  it("flags an attempt to write to the architecture registry itself", () => {
    const violations = checkBoundaries(
      "frontend",
      [{ path: "architecture/api/auth.openapi.yaml", operation: "modify" }],
      config,
    );
    expect(violations[0]).toMatchObject({ owner: "architecture" });
  });
});

describe("ownedRootsForRole", () => {
  it("returns the normalized owned roots for a role", () => {
    expect(ownedRootsForRole("frontend", config)).toEqual(["ui", "web", "mobile"]);
  });

  it("returns an empty array for an unknown role", () => {
    expect(ownedRootsForRole("nope", config)).toEqual([]);
  });
});
