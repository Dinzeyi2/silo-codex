import { MemberDirectory } from "../src/members.js";
import { RoleMismatchError, UnknownMemberError, UnknownRoleError } from "../src/types.js";
import type { OwnershipConfig } from "../src/types.js";

const ownership: OwnershipConfig = {
  roles: {
    database: { owns: ["db/"] },
    auth: { owns: ["auth/"] },
  },
};

const directory = new MemberDirectory({
  members: [
    { id: "alice", role: "database" },
    { id: "bob", role: "auth" },
  ],
});

describe("MemberDirectory.authorize", () => {
  it("returns the member when their assigned role matches the requested role", () => {
    expect(directory.authorize("alice", "database", ownership)).toMatchObject({
      id: "alice",
      role: "database",
    });
  });

  it("throws RoleMismatchError when a member requests a role they are not assigned", () => {
    // A database member cannot invoke the authentication specialist.
    expect(() => directory.authorize("alice", "auth", ownership)).toThrow(RoleMismatchError);
  });

  it("throws UnknownMemberError for an unregistered member id", () => {
    expect(() => directory.authorize("ghost", "database", ownership)).toThrow(UnknownMemberError);
  });

  it("throws UnknownRoleError when the requested role is not in the ownership registry", () => {
    expect(() => directory.authorize("alice", "quantum", ownership)).toThrow(UnknownRoleError);
  });

  it("checks the role's existence before the member's identity", () => {
    // Even for an unknown member, an invalid role should be reported as UnknownRoleError,
    // not leak whether the member id exists.
    expect(() => directory.authorize("ghost", "quantum", ownership)).toThrow(UnknownRoleError);
  });
});
