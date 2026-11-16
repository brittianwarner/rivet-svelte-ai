/**
 * The real server against a real engine, through the public edge only.
 * Run with `bun run test:integration` — not part of `bun run test`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ENTITY_CLOSE_REASONS,
  ENTITY_ERRORS,
  configureEntities,
  exportKey,
  organizationKey,
  projectKey,
  signPrincipal,
  userKey,
  type Comment,
  type CommentPage,
  type OrganizationSnapshot,
  type ProjectSnapshot,
  type UserSnapshot,
  type Viewer,
} from "@example/entities";
import {
  HARNESS_ENTITY_SECRET,
  startHarness,
  type Harness,
} from "./harness.ts";

// Sign short-lived tokens here, the way the server would.
configureEntities({ secret: HARNESS_ENTITY_SECRET });

let h: Harness;

beforeAll(async () => {
  // Short enough to watch an export expire.
  h = await startHarness({ env: { ENTITY_EXPORT_TTL_SECONDS: "4" } });
}, 180_000);

afterAll(async () => {
  await h?.stop();
}, 60_000);

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!accept(value)) {
    if (Date.now() > deadline)
      throw new Error(`Did not settle: ${JSON.stringify(value)}`);
    await Bun.sleep(50);
    value = await read();
  }
  return value;
}

async function signIn(persona: string): Promise<string> {
  const response = await fetch(`${h.origin}/api/entities/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: h.origin },
    body: JSON.stringify({ persona }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

describe("edge", () => {
  test("client config points at this origin's /rivet", () => {
    expect(h.config.rivetEndpoint).toBe(`${h.origin}/rivet`);
  });

  test("engine admin routes are not reachable", async () => {
    for (const path of [
      "/rivet/namespaces",
      "/rivet/actors",
      "/rivet/pools/default/nodes",
      "/rivet/auth/tokens",
    ]) {
      expect((await fetch(`${h.origin}${path}`)).status).toBe(404);
    }
  });

  test("a foreign origin cannot open the edge", async () => {
    const response = await fetch(
      `${h.origin}/rivet/gateway/counter/action/getCount`,
      {
        method: "POST",
        headers: { origin: "https://evil.example" },
      },
    );
    expect(response.status).toBe(403);
  });
});

describe("counter", () => {
  test("actions, events, and the HTTP API share one actor", async () => {
    const client = h.connect();
    try {
      const key = `it-${crypto.randomUUID()}`;
      const counter = client.counter.getOrCreate(["counter", key]);
      expect(await counter.increment(2)).toBe(2);

      const connection = counter.connect();
      const seen: number[] = [];
      connection.on("newCount", (count) => seen.push(count));
      await connection.getCount();

      const http = await fetch(`${h.origin}/api/counters/${key}/increment`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({ by: 3 }),
      });
      expect(await http.json()).toEqual({ count: 5 });
      await until(
        async () => seen,
        (values) => values.includes(5),
      );
      await connection.dispose();
    } finally {
      await client.dispose();
    }
  }, 60_000);
});

describe("entities", () => {
  test("an owner invites, the invitee accepts, both mirrors converge", async () => {
    const client = h.connect();
    try {
      const ada = { principal: await signIn("ada") };
      const grace = { principal: await signIn("grace") };
      const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;

      const asAda = client.organization.getOrCreate(organizationKey(orgId), {
        params: ada,
      });
      const created = (await asAda.create({
        name: "Analytical Engines",
      })) as OrganizationSnapshot;
      expect(created.ownerId).toBe("ada");

      const invited = (await asAda.invite({
        userId: "grace",
        role: "admin",
      })) as OrganizationSnapshot;
      const inviteId = invited.invitations[0]?.inviteId;
      expect(inviteId).toBeString();

      const graceUser = client.user.getOrCreate(userKey("grace"), {
        params: grace,
      });
      const inbox = (await until(
        () => graceUser.getSnapshot() as Promise<UserSnapshot>,
        (snapshot) =>
          snapshot.inbox.some((notice) => notice.inviteId === inviteId),
      )) as UserSnapshot;
      expect(inbox.inbox[0]?.orgName).toBe("Analytical Engines");

      const asGrace = client.organization.getOrCreate(organizationKey(orgId), {
        params: grace,
      });
      const joined = (await asGrace.respond({
        inviteId,
        accept: true,
      })) as OrganizationSnapshot;
      expect(
        joined.members.map((member) => [member.userId, member.role]),
      ).toEqual([
        ["ada", "owner"],
        ["grace", "admin"],
      ]);

      const mirrored = await until(
        () => graceUser.getSnapshot() as Promise<UserSnapshot>,
        (snapshot) =>
          snapshot.organizations.some((link) => link.orgId === orgId),
      );
      expect(mirrored.inbox).toHaveLength(0);
      expect(
        mirrored.organizations.find((link) => link.orgId === orgId)?.role,
      ).toBe("admin");
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test("the organization indexes its projects and keeps names in step", async () => {
    const client = h.connect();
    try {
      const ada = { principal: await signIn("ada") };
      const linus = { principal: await signIn("linus") };
      const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
      const org = client.organization.getOrCreate(organizationKey(orgId), {
        params: ada,
      });
      await org.create({ name: "Index Test" });

      const input = { projectId: "launch-plan", name: "Launch plan" };
      const first = (await org.createProject(input)) as OrganizationSnapshot;
      // A retried create returns the same project instead of a second one.
      const retried = (await org.createProject(input)) as OrganizationSnapshot;
      expect(first.projects.map((link) => link.projectId)).toEqual([
        "launch-plan",
      ]);
      expect(retried.revision).toBe(first.revision);

      const project = client.project.getOrCreate(
        projectKey(orgId, "launch-plan"),
        { params: ada },
      );
      const withTask = (await project.addTask("Draft copy")) as ProjectSnapshot;
      expect(withTask.tasks.map((task) => task.title)).toEqual(["Draft copy"]);
      await project.rename("Launch day");
      // The project tells the index after commit, through its outbox.
      await until(
        () => org.getSnapshot() as Promise<OrganizationSnapshot>,
        (snapshot) => snapshot.projects[0]?.name === "Launch day",
      );

      // Not a member: the project asks the organization and refuses.
      const outsider = client.project.getOrCreate(
        projectKey(orgId, "launch-plan"),
        { params: linus },
      );
      await expect(outsider.getSnapshot()).rejects.toThrow();

      // A key nobody started is not a project: the organization grants no
      // role on it, so even its owner is refused at connect.
      const guessed = client.project.getOrCreate(projectKey(orgId, "guessed"), {
        params: ada,
      });
      await expect(guessed.getSnapshot()).rejects.toMatchObject({
        code: ENTITY_ERRORS.forbidden,
      });
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test("open sockets only hear about entities their principal can read", async () => {
    const client = h.connect();
    const sockets: { dispose(): Promise<void> }[] = [];
    try {
      const ada = { principal: await signIn("ada") };
      const grace = { principal: await signIn("grace") };
      const linus = { principal: await signIn("linus") };
      const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
      const org = client.organization.getOrCreate(organizationKey(orgId), {
        params: ada,
      });
      await org.create({ name: "Quiet Sockets" });
      await org.createProject({ projectId: "roadmap", name: "Roadmap" });

      // Someone else's user actor refuses the socket outright.
      const snoop = client.user.getOrCreate(userKey("ada"), { params: grace });
      await expect(snoop.getSnapshot()).rejects.toThrow();

      // A non-member may open the org socket (to create or answer an
      // invitation) but hears nothing.
      const outsider = client.organization
        .getOrCreate(organizationKey(orgId), { params: linus })
        .connect();
      sockets.push(outsider);
      const heard: number[] = [];
      outsider.on("changed", (snapshot: OrganizationSnapshot) =>
        heard.push(snapshot.revision),
      );
      await outsider.getSnapshot().catch(() => undefined);

      // Grace joins, then holds sockets on the org and the project.
      const invited = (await org.invite({
        userId: "grace",
        role: "member",
      })) as OrganizationSnapshot;
      const asGrace = client.organization.getOrCreate(organizationKey(orgId), {
        params: grace,
      });
      await asGrace.respond({
        inviteId: invited.invitations[0]?.inviteId,
        accept: true,
      });
      const graceProject = client.project
        .getOrCreate(projectKey(orgId, "roadmap"), { params: grace })
        .connect();
      sockets.push(graceProject);
      expect(((await graceProject.getSnapshot()) as ProjectSnapshot).name).toBe(
        "Roadmap",
      );

      const graceOrg = asGrace.connect();
      sockets.push(graceOrg);
      const graceHeard: number[] = [];
      graceOrg.on("changed", (snapshot: OrganizationSnapshot) =>
        graceHeard.push(snapshot.revision),
      );
      await graceOrg.getSnapshot();
      await org.rename({ name: "Quiet Sockets Inc" });
      await until(
        async () => graceHeard.length,
        (count) => count > 0,
      );

      // Removing Grace silences her org socket and closes her project socket.
      const closed = new Promise<void>((resolve) =>
        graceProject.onClose(() => resolve()),
      );
      await org.removeMember("grace");
      await closed;
      const before = graceHeard.length;
      await org.rename({ name: "Quiet Sockets" });
      await Bun.sleep(300);
      expect(graceHeard.length).toBe(before);
      expect(heard).toEqual([]);
    } finally {
      await Promise.all(sockets.map((socket) => socket.dispose()));
      await client.dispose();
    }
  }, 60_000);

  test("tasks carry paged comments, live presence, and exact toggles", async () => {
    const client = h.connect();
    const sockets: { dispose(): Promise<void> }[] = [];
    try {
      const ada = { principal: await signIn("ada") };
      const grace = { principal: await signIn("grace") };
      const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
      const org = client.organization.getOrCreate(organizationKey(orgId), {
        params: ada,
      });
      await org.create({ name: "Threads" });
      const invited = (await org.invite({
        userId: "grace",
        role: "member",
      })) as OrganizationSnapshot;
      await client.organization
        .getOrCreate(organizationKey(orgId), { params: grace })
        .respond({ inviteId: invited.invitations[0]?.inviteId, accept: true });
      await org.createProject({ projectId: "board", name: "Board" });

      const adaSocket = client.project
        .get(projectKey(orgId, "board"), { params: ada })
        .connect();
      sockets.push(adaSocket);
      const heard: Comment[] = [];
      const seen: string[][] = [];
      adaSocket.on("comment", (comment: Comment) => heard.push(comment));
      adaSocket.on("presence", (viewers: Viewer[]) =>
        seen.push(viewers.map((viewer) => viewer.userId)),
      );
      expect(
        ((await adaSocket.watch()) as Viewer[]).map((v) => v.userId),
      ).toEqual(["ada"]);

      // Presence follows sockets: Grace appears, then leaves with her socket.
      const graceSocket = client.project
        .get(projectKey(orgId, "board"), { params: grace })
        .connect();
      await graceSocket.watch();
      await until(
        async () => seen.at(-1),
        (last) => last?.join() === "ada,grace",
      );
      await graceSocket.dispose();
      await until(
        async () => seen.at(-1),
        (last) => last?.join() === "ada",
      );

      const withTask = (await adaSocket.addTask("Ship it")) as ProjectSnapshot;
      const taskId = withTask.tasks[0]!.taskId;
      const total = 22;
      for (let i = 1; i <= total; i++)
        await adaSocket.addComment({ taskId, body: `Note ${i}` });
      await until(
        async () => heard.length,
        (count) => count === total,
      );

      const latest = (await adaSocket.listComments({ taskId })) as CommentPage;
      expect(latest.comments).toHaveLength(20);
      expect(latest.comments.at(-1)?.body).toBe(`Note ${total}`);
      expect(latest.before).toBeNumber();
      const older = (await adaSocket.listComments({
        taskId,
        before: latest.before,
      })) as CommentPage;
      expect(older.comments.map((comment) => comment.body)).toEqual([
        "Note 1",
        "Note 2",
      ]);
      expect(older.before).toBeNull();
      const counted = (await adaSocket.getSnapshot()) as ProjectSnapshot;
      expect(counted.tasks[0]?.comments).toBe(total);

      // Two toggles at once are two flips, never one lost update.
      await Promise.all([
        adaSocket.toggleTask(taskId),
        adaSocket.toggleTask(taskId),
      ]);
      const toggled = (await adaSocket.getSnapshot()) as ProjectSnapshot;
      expect(toggled.tasks[0]?.done).toBe(false);

      const removed = (await adaSocket.removeTask(taskId)) as ProjectSnapshot;
      expect(removed.tasks).toEqual([]);
      const gone = (await adaSocket.listComments({ taskId })) as CommentPage;
      expect(gone.comments).toEqual([]);
    } finally {
      await Promise.all(sockets.map((socket) => socket.dispose()));
      await client.dispose();
    }
  }, 90_000);

  test("a CSV export runs as a workflow, downloads for readers, and expires", async () => {
    const client = h.connect();
    try {
      const ada = { principal: await signIn("ada") };
      const linus = { principal: await signIn("linus") };
      const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
      const org = client.organization.getOrCreate(organizationKey(orgId), {
        params: ada,
      });
      await org.create({ name: "Exports" });
      await org.createProject({ projectId: "ledger", name: "Ledger" });
      const project = client.project.get(projectKey(orgId, "ledger"), {
        params: ada,
      });
      await project.addTask("Plain");
      await project.addTask("=SUM(A1), quoted");

      const started = (await project.startExport()) as ProjectSnapshot;
      const exportId = started.exports[0]!.exportId;
      expect(started.exports[0]?.status).toBe("queued");
      // One export per person at a time.
      await expect(project.startExport()).rejects.toMatchObject({
        code: ENTITY_ERRORS.conflict,
      });

      const ready = await until(
        () => project.getSnapshot() as Promise<ProjectSnapshot>,
        (snapshot) => snapshot.exports[0]?.status === "ready",
      );
      expect(ready.exports[0]?.rows).toBe(2);

      const file = client.projectExport.get(
        exportKey(orgId, "ledger", exportId),
        { params: ada },
      );
      const response = await file.fetch("/");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      const csv = await response.text();
      expect(csv.split("\r\n")[0]).toBe(
        "title,done,created_by,created_at,comments",
      );
      // Cells that start a formula are defused, and commas are quoted.
      expect(csv).toContain(`"'=SUM(A1), quoted"`);

      // A non-member cannot read it, and a guessed export key gets nothing.
      await expect(
        client.projectExport
          .get(exportKey(orgId, "ledger", exportId), { params: linus })
          .getStatus(),
      ).rejects.toThrow();
      await expect(
        client.projectExport
          .getOrCreate(exportKey(orgId, "ledger", "guessed"), { params: ada })
          .getStatus(),
      ).rejects.toThrow();

      // The workflow's durable timer deletes the file and the actor.
      await until(
        () => project.getSnapshot() as Promise<ProjectSnapshot>,
        (snapshot) => snapshot.exports.length === 0,
        20_000,
      );
      await expect(file.getStatus()).rejects.toThrow();
    } finally {
      await client.dispose();
    }
  }, 90_000);

  test("deleting a project closes its sockets and frees its key", async () => {
    const client = h.connect();
    try {
      const ada = { principal: await signIn("ada") };
      const linus = { principal: await signIn("linus") };
      const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
      const org = client.organization.getOrCreate(organizationKey(orgId), {
        params: ada,
      });
      await org.create({ name: "Cleanup" });
      await org.createProject({ projectId: "old", name: "Old" });
      const socket = client.project
        .get(projectKey(orgId, "old"), { params: ada })
        .connect();
      await socket.addTask("Leftover");
      const reasons: string[] = [];
      socket.onError((error: { group?: string; code?: string }) =>
        reasons.push(`${error.group}.${error.code}`),
      );
      const closed = new Promise<void>((resolve) =>
        socket.onClose(() => resolve()),
      );

      // Only admins delete projects.
      await expect(
        client.organization
          .getOrCreate(organizationKey(orgId), { params: linus })
          .deleteProject("old"),
      ).rejects.toMatchObject({ code: ENTITY_ERRORS.forbidden });

      const after = (await org.deleteProject("old")) as OrganizationSnapshot;
      expect(after.projects).toEqual([]);
      await closed;
      await socket.dispose();
      await until(
        () =>
          client.project
            .get(projectKey(orgId, "old"), { params: ada })
            .getSnapshot()
            .then(
              () => "alive",
              () => "gone",
            ),
        (state) => state === "gone",
      );
      expect(reasons).not.toContain(ENTITY_CLOSE_REASONS.accessRevoked);

      // The same id starts a fresh, empty project.
      await org.createProject({ projectId: "old", name: "Old again" });
      const fresh = (await client.project
        .get(projectKey(orgId, "old"), { params: ada })
        .getSnapshot()) as ProjectSnapshot;
      expect(fresh.name).toBe("Old again");
      expect(fresh.tasks).toEqual([]);
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test("a socket closes when its token expires and reconnects with a fresh one", async () => {
    const client = h.connect();
    try {
      let issued = 0;
      const socket = client.user
        .getOrCreate(userKey("ada"), {
          getParams: async () => {
            issued += 1;
            return { principal: signPrincipal({ sub: "ada", name: "Ada" }, 2) };
          },
        })
        .connect();
      const reasons: string[] = [];
      socket.onError((error: { group?: string; code?: string }) =>
        reasons.push(`${error.group}.${error.code}`),
      );
      await socket.register();
      await until(
        async () => issued,
        (count) => count >= 3,
        10_000,
      );
      expect(reasons).toContain("user.session_expired");
      // Still usable: every reconnect carried a new token.
      expect(((await socket.getSnapshot()) as UserSnapshot).id).toBe("ada");
      await socket.dispose();

      // An expired token cannot open a socket or call an action.
      const stale = client.user.getOrCreate(userKey("ada"), {
        params: { principal: signPrincipal({ sub: "ada", name: "Ada" }, -1) },
      });
      await expect(stale.getSnapshot()).rejects.toThrow();
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test("system is reserved and server-only actions refuse people", async () => {
    const client = h.connect();
    try {
      const ada = { principal: await signIn("ada") };
      // No user actor can be keyed "system", and no persona signs in as it.
      await expect(
        client.user
          .getOrCreate(userKey("system"), { params: ada })
          .getSnapshot(),
      ).rejects.toThrow();
      const response = await fetch(`${h.origin}/api/entities/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({ persona: "system" }),
      });
      expect(response.status).toBe(400);

      const orgId = `org-${crypto.randomUUID().slice(0, 8)}`;
      const org = client.organization.getOrCreate(organizationKey(orgId), {
        params: ada,
      });
      await org.create({ name: "Server Only" });
      for (const call of [
        () => org.projectRole({ projectId: "x", userId: "ada" }),
        () => org.drainOutbox(),
        () => org.applyProject({ projectId: "x", name: "X" }),
        () =>
          client.user
            .getOrCreate(userKey("ada"), { params: ada })
            .applyOrganization({
              orgId,
              name: "Forged",
              revision: 1e9,
              role: "owner",
              invitation: null,
            }),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: ENTITY_ERRORS.forbidden,
        });
      }
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test("each caller has a write budget per actor; reads stay open", async () => {
    const client = h.connect();
    try {
      const ada = client.user.getOrCreate(userKey("ada"), {
        params: { principal: await signIn("ada") },
      });
      await ada.register();
      let limited: { code?: string } | undefined;
      for (let i = 0; i < 40 && !limited; i++) {
        await ada
          .setTheme(i % 2 ? "light" : "dark")
          .catch((error: { code?: string }) => (limited = error));
      }
      expect(limited?.code).toBe(ENTITY_ERRORS.rateLimited);
      expect(((await ada.getSnapshot()) as UserSnapshot).id).toBe("ada");
    } finally {
      await client.dispose();
    }
  }, 60_000);

  test("connections without a signed principal are refused", async () => {
    const client = h.connect();
    try {
      const anonymous = client.organization.getOrCreate(
        organizationKey("nobody"),
        { params: {} },
      );
      await expect(anonymous.getSnapshot()).rejects.toThrow();
      const forged = client.organization.getOrCreate(
        organizationKey("nobody"),
        { params: { principal: "x.y" } },
      );
      await expect(forged.getSnapshot()).rejects.toThrow();
    } finally {
      await client.dispose();
    }
  }, 60_000);
});

describe("restart", () => {
  test("state survives a replica restart", async () => {
    const key = `restart-${crypto.randomUUID()}`;
    const before = h.connect();
    try {
      expect(
        await before.counter.getOrCreate(["counter", key]).increment(7),
      ).toBe(7);
    } finally {
      await before.dispose();
    }
    // Let the engine checkpoint, then roll the replica the way a deploy does.
    await Bun.sleep(1500);
    await h.stopServer();
    await h.startServer();
    const after = h.connect();
    try {
      expect(await after.counter.getOrCreate(["counter", key]).getCount()).toBe(
        7,
      );
    } finally {
      await after.dispose();
    }
  }, 120_000);
});
