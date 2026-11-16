import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  configureEntities,
  signPrincipal,
  systemParams,
  verifyPrincipal,
} from "./principal.ts";

configureEntities({ secret: "test-secret" });

const ada = { sub: "ada", name: "Ada" };

/** Re-encode a token's payload, keeping its kind and signature. */
function tamper(token: string, body: Record<string, unknown>): string {
  const [kind, , sig] = token.split(".");
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${kind}.${payload}.${sig}`;
}

test("a signed principal round-trips with its expiry", () => {
  const before = Date.now();
  const session = verifyPrincipal(signPrincipal(ada, 60));
  assert.deepEqual(session?.principal, ada);
  assert.ok(session!.expiresAt >= before + 60_000);
  assert.ok(session!.expiresAt <= Date.now() + 60_000);
});

test("a forged or tampered token is rejected", () => {
  const token = signPrincipal(ada);
  const [kind, payload, sig] = token.split(".");
  assert.equal(
    verifyPrincipal(tamper(token, { sub: "grace", name: "Grace", exp: 9e15 })),
    null,
  );
  assert.equal(verifyPrincipal(`${kind}.${payload}.${sig}x`), null);
  assert.equal(verifyPrincipal(`${kind}.${payload}`), null);
  assert.equal(verifyPrincipal(`${payload}.${sig}`), null);
  assert.equal(verifyPrincipal(`${token}.extra`), null);
  assert.equal(verifyPrincipal("x".repeat(4096)), null);
  assert.equal(verifyPrincipal(42), null);
});

test("an expired token is rejected", () => {
  assert.equal(verifyPrincipal(signPrincipal(ada, -1)), null);
});

test("a token signed with another secret is rejected", () => {
  const token = signPrincipal(ada);
  configureEntities({ secret: "rotated" });
  assert.equal(verifyPrincipal(token), null);
  configureEntities({ secret: "test-secret" });
  assert.deepEqual(verifyPrincipal(token)?.principal, ada);
});

test("nobody can sign a user token for the server or a malformed id", () => {
  assert.throws(() => signPrincipal({ sub: "system", name: "System" }));
  assert.throws(() => signPrincipal({ sub: "Ada", name: "Ada" }));
  assert.throws(() => signPrincipal({ sub: "", name: "Nobody" }));
});

test("user and system tokens use separate keys", () => {
  const system = systemParams().principal!;
  assert.deepEqual(verifyPrincipal(system)?.principal.sub, "system");

  // Relabelling a user token as a system token breaks its signature.
  const user = signPrincipal(ada);
  const relabelled = `system.${user.split(".").slice(1).join(".")}`;
  assert.equal(verifyPrincipal(relabelled), null);

  // A system-kind token must name the server, and a user token never can.
  assert.equal(
    verifyPrincipal(tamper(system, { sub: "ada", name: "Ada", exp: 9e15 })),
    null,
  );
});

test("system tokens are short-lived", () => {
  const session = verifyPrincipal(systemParams().principal);
  assert.ok(session!.expiresAt <= Date.now() + 60_000);
});
