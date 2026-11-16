import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import {
  authenticate,
  caller,
  createEntityVars,
  forgetSession,
  publishTo,
  requireSystem,
  trackSession,
  writer,
  type EntityConn,
} from "./access.ts";
import { ENTITY_CLOSE_REASONS, ENTITY_ERRORS } from "./contracts.ts";
import { configureEntities, signPrincipal, systemParams } from "./principal.ts";

configureEntities({ secret: "access-test-secret" });

interface FakeConn extends EntityConn {
  sent: unknown[];
  closed: string[];
}

let open: { vars: ReturnType<typeof createEntityVars>; conn: FakeConn }[] = [];

afterEach(() => {
  for (const { vars, conn } of open) forgetSession({ vars }, conn);
  open = [];
});

function connect(principal: string | undefined, vars = createEntityVars()) {
  const conn: FakeConn = {
    id: crypto.randomUUID(),
    params: principal === undefined ? {} : { principal },
    sent: [],
    closed: [],
    send: (_name, snapshot) => void conn.sent.push(snapshot),
    disconnect: async (reason) => void conn.closed.push(reason ?? ""),
  };
  trackSession({ vars }, conn);
  open.push({ vars, conn });
  return { vars, conn };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

test("onBeforeConnect refuses missing and forged tokens", () => {
  assert.equal(
    codeOf(() => authenticate({}, {})),
    ENTITY_ERRORS.unauthenticated,
  );
  assert.equal(
    codeOf(() => authenticate({}, { principal: "user.x.y" })),
    ENTITY_ERRORS.unauthenticated,
  );
  const token = signPrincipal({ sub: "ada", name: "Ada" });
  assert.equal(authenticate({}, { principal: token }).principal.sub, "ada");
});

test("the transport check runs before the token check", () => {
  configureEntities({
    authorizeTransport: () => {
      throw new Error("origin blocked");
    },
  });
  try {
    const token = signPrincipal({ sub: "ada", name: "Ada" });
    assert.throws(
      () => authenticate({}, { principal: token }),
      /origin blocked/,
    );
  } finally {
    configureEntities({ authorizeTransport: () => {} });
  }
});

test("actions read the caller from vars, keyed by connection", () => {
  const { vars, conn } = connect(signPrincipal({ sub: "ada", name: "Ada" }));
  assert.equal(caller({ vars, conn }).sub, "ada");
  // Scheduled and inspector calls have no connection: never a caller.
  assert.equal(
    codeOf(() => caller({ vars })),
    ENTITY_ERRORS.unauthenticated,
  );
});

test("a session missing from vars is rebuilt from the signed params", () => {
  const { vars, conn } = connect(signPrincipal({ sub: "ada", name: "Ada" }));
  forgetSession({ vars }, conn);
  assert.equal(caller({ vars, conn }).sub, "ada");
  assert.equal(vars.sessions.size, 1);
});

test("an expired session is refused and its socket closed", async () => {
  const { vars, conn } = connect(signPrincipal({ sub: "ada", name: "Ada" }));
  vars.sessions.get(conn.id)!.expiresAt = Date.now() - 1;
  assert.equal(
    codeOf(() => caller({ vars, conn })),
    ENTITY_ERRORS.unauthenticated,
  );
  await Bun.sleep(0);
  assert.deepEqual(conn.closed, [ENTITY_CLOSE_REASONS.sessionExpired]);
  assert.equal(vars.sessions.size, 0);
});

test("the socket closes the moment its token expires", async () => {
  const { conn } = connect(signPrincipal({ sub: "ada", name: "Ada" }, 0.05));
  assert.deepEqual(conn.closed, []);
  await Bun.sleep(120);
  assert.deepEqual(conn.closed, [ENTITY_CLOSE_REASONS.sessionExpired]);
});

test("disconnecting clears the expiry timer", async () => {
  const { vars, conn } = connect(
    signPrincipal({ sub: "ada", name: "Ada" }, 0.05),
  );
  forgetSession({ vars }, conn);
  await Bun.sleep(120);
  assert.deepEqual(conn.closed, []);
});

test("writes have a refilling budget; the server has none", () => {
  const { vars, conn } = connect(signPrincipal({ sub: "ada", name: "Ada" }));
  let refused: string | undefined;
  for (let i = 0; i < 40 && !refused; i++)
    refused = codeOf(() => writer({ vars, conn }));
  assert.equal(refused, ENTITY_ERRORS.rateLimited);
  // Reads are never limited.
  assert.equal(caller({ vars, conn }).sub, "ada");

  const system = connect(systemParams().principal);
  for (let i = 0; i < 100; i++) writer(system);
});

test("only the server passes requireSystem", () => {
  const ada = connect(signPrincipal({ sub: "ada", name: "Ada" }));
  assert.equal(
    codeOf(() => requireSystem(ada)),
    ENTITY_ERRORS.forbidden,
  );
  requireSystem(connect(systemParams().principal));
});

test("publishTo reaches readers and the server, never expired sessions", async () => {
  const vars = createEntityVars();
  const conns = new Map<string, FakeConn>();
  const add = (token: string) => {
    const { conn } = connect(token, vars);
    conns.set(conn.id, conn);
    return conn;
  };
  const ada = add(signPrincipal({ sub: "ada", name: "Ada" }));
  const linus = add(signPrincipal({ sub: "linus", name: "Linus" }));
  const server = add(systemParams().principal!);
  const stale = add(signPrincipal({ sub: "ada", name: "Ada" }));
  vars.sessions.get(stale.id)!.expiresAt = Date.now() - 1;

  publishTo({ vars, conns }, (principal) => principal.sub === "ada")(
    "changed",
    { revision: 1 },
  );
  await Bun.sleep(0);
  assert.equal(ada.sent.length, 1);
  assert.equal(linus.sent.length, 0);
  assert.equal(server.sent.length, 1);
  assert.equal(stale.sent.length, 0);
  assert.deepEqual(stale.closed, [ENTITY_CLOSE_REASONS.sessionExpired]);
});
