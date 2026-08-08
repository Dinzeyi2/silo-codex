import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InvalidProjectError, ProjectStore, UnknownProjectError } from "../src/projects.js";

describe("ProjectStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "silo-projects-"));
    storePath = path.join(dir, "projects.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a project and can look it up", () => {
    const store = new ProjectStore(storePath);
    const project = store.register({
      id: "acme",
      name: "Acme",
      repoUrl: "https://github.com/acme/product.git",
      githubToken: "ghp_secret",
    });
    expect(project.baseBranch).toBe("integration");
    expect(store.get("acme")?.repoUrl).toBe("https://github.com/acme/product.git");
  });

  it("require() throws UnknownProjectError for a missing project", () => {
    const store = new ProjectStore(storePath);
    expect(() => store.require("ghost")).toThrow(UnknownProjectError);
  });

  it("list() never includes the githubToken", () => {
    const store = new ProjectStore(storePath);
    store.register({
      id: "acme",
      name: "Acme",
      repoUrl: "https://github.com/acme/product.git",
      githubToken: "ghp_secret",
    });
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("ghp_secret");
  });

  it("rejects a non-https repoUrl", () => {
    const store = new ProjectStore(storePath);
    expect(() =>
      store.register({
        id: "acme",
        name: "Acme",
        repoUrl: "git@github.com:acme/product.git",
        githubToken: "x",
      }),
    ).toThrow(InvalidProjectError);
  });

  it("rejects an invalid project id", () => {
    const store = new ProjectStore(storePath);
    expect(() =>
      store.register({
        id: "not a valid id!",
        name: "x",
        repoUrl: "https://github.com/a/b.git",
        githubToken: "x",
      }),
    ).toThrow(InvalidProjectError);
  });

  it("persists across store instances (survives a restart)", () => {
    const store1 = new ProjectStore(storePath);
    store1.register({
      id: "acme",
      name: "Acme",
      repoUrl: "https://github.com/acme/product.git",
      githubToken: "ghp_secret",
    });

    const store2 = new ProjectStore(storePath);
    expect(store2.require("acme").repoUrl).toBe("https://github.com/acme/product.git");
  });

  it("remove() deletes a project", () => {
    const store = new ProjectStore(storePath);
    store.register({
      id: "acme",
      name: "Acme",
      repoUrl: "https://github.com/acme/product.git",
      githubToken: "x",
    });
    expect(store.remove("acme")).toBe(true);
    expect(store.get("acme")).toBeUndefined();
    expect(store.remove("acme")).toBe(false);
  });
});
