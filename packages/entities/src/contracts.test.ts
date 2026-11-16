import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  PERMISSIONS,
  ROLES,
  can,
  isEntityId,
  isReadPermission,
  roleAtLeast,
} from "./contracts.ts";

test("each role includes the permissions of the roles below it", () => {
  for (const permission of Object.keys(
    PERMISSIONS,
  ) as (keyof typeof PERMISSIONS)[]) {
    let granted = false;
    for (const role of ROLES) {
      if (can(role, permission)) granted = true;
      else assert.equal(granted, false, `${role} lost ${permission}`);
    }
    assert.equal(granted, true, `nobody has ${permission}`);
  }
});

test("a missing role grants nothing", () => {
  assert.equal(can(null, "org.read"), false);
  assert.equal(can(undefined, "project.read"), false);
  assert.equal(roleAtLeast(null, "viewer"), false);
});

test("only owners transfer; admins invite; members write projects", () => {
  assert.equal(can("admin", "org.transfer"), false);
  assert.equal(can("owner", "org.transfer"), true);
  assert.equal(can("member", "member.invite"), false);
  assert.equal(can("admin", "member.invite"), true);
  assert.equal(can("viewer", "project.write"), false);
  assert.equal(can("member", "project.write"), true);
});

test("system is never an entity id", () => {
  assert.equal(isEntityId("system"), false);
  assert.equal(isEntityId("systems"), true);
  assert.equal(isEntityId("Ada"), false);
  assert.equal(isEntityId("-ada"), false);
  assert.equal(isEntityId("ada-lovelace"), true);
});

test("only .read permissions skip the write budget", () => {
  assert.equal(isReadPermission("org.read"), true);
  assert.equal(isReadPermission("project.read"), true);
  assert.equal(isReadPermission("org.leave"), false);
  assert.equal(isReadPermission("project.write"), false);
});
