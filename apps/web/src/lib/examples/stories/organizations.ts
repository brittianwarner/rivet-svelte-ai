import type { ExampleStory } from "../types";

export const organizations: ExampleStory = {
  slug: "organizations-and-users",
  section: "foundations",
  title: "Organizations and Users",
  tagline:
    "Model users, organizations, and the things they own as actors that check access on every call.",
  ideas: [
    "Every socket carries a signed principal: verified in onBeforeConnect, kept in c.vars, closed when it expires.",
    "The organization owns membership and pushes each user a view of it.",
    "Owned actors ask the organization for a role before each write, so removal takes effect at once.",
    "Each actor keeps its data in its own SQLite database. A change, its audit entry, and its follow-up calls commit together.",
  ],
  docs: "https://rivet.dev/actors/docs/communicating-between-actors/",
  requires: [
    {
      label: "This repo",
      detail:
        "Everything is in packages/entities. No extra packages, keys, or accounts.",
    },
    {
      label: "ENTITY_SECRET",
      detail:
        "Optional. Without it a random per-process secret signs tokens, which stop working after a restart.",
    },
  ],
  live: "/examples/organizations-and-users/live",
  nodes: [
    { id: "alice", label: "Alice's browser", kind: "client", x: 14, y: 10 },
    {
      id: "api",
      label: "API",
      kind: "service",
      key: "signs tokens",
      x: 14,
      y: 30,
    },
    { id: "bob", label: "Bob's browser", kind: "client", x: 14, y: 50 },
    {
      id: "org",
      label: "organization",
      kind: "actor",
      key: '["organization", "acme"]',
      x: 44,
      y: 30,
    },
    {
      id: "ua",
      label: "user alice",
      kind: "actor",
      key: '["user", "alice"]',
      x: 76,
      y: 10,
    },
    {
      id: "ub",
      label: "user bob",
      kind: "actor",
      key: '["user", "bob"]',
      x: 76,
      y: 30,
    },
    {
      id: "project",
      label: "project",
      kind: "actor",
      key: '["project", "acme", "q3"]',
      x: 76,
      y: 50,
    },
  ],
  edges: [
    { id: "alice-api", from: "alice", to: "api" },
    { id: "bob-api", from: "bob", to: "api" },
    { id: "alice-ua", from: "alice", to: "ua" },
    { id: "bob-ub", from: "bob", to: "ub" },
    { id: "alice-org", from: "alice", to: "org" },
    { id: "bob-org", from: "bob", to: "org" },
    { id: "org-ua", from: "org", to: "ua" },
    { id: "org-ub", from: "org", to: "ub" },
    { id: "bob-project", from: "bob", to: "project" },
    { id: "project-org", from: "project", to: "org" },
  ],
  beats: [
    {
      title: "Alice signs in.",
      body: "The API authenticates Alice and signs a principal token. Her browser connects to her user actor with it. onBeforeConnect verifies the signature before the socket opens, and onConnect keeps the session in c.vars, keyed by the connection.",
      enter: ["alice", "api", "ua"],
      focus: ["api", "ua"],
      status: { ua: "verified" },
      flows: [
        { edge: "alice-api", label: "principal token", back: true },
        { edge: "alice-ua", label: "register()" },
      ],
      panel: {
        kind: "state",
        title: "user alice · c.vars.sessions",
        rows: [
          ["principal.sub", "alice"],
          ["principal.name", "Alice"],
          ["token", "user.base64url(json).base64url(hmac)"],
          ["expires", "in 1 hour · the socket reconnects with a fresh token"],
          ["forged or expired", "Sign in to continue. (UNAUTHENTICATED)"],
        ],
      },
    },
    {
      title: "Alice creates an organization.",
      body: "create on the organization actor makes Alice its owner. One SQLite transaction writes the rows, bumps the revision, adds the audit entry, and queues a delivery to Alice's user actor in the outbox. The snapshot goes out after commit, then the outbox delivers her view.",
      enter: ["org"],
      focus: ["org", "ua"],
      status: { org: "rev 1", ua: "acme · owner" },
      flows: [
        { edge: "alice-org", label: 'create({ name: "Acme" })' },
        { edge: "org-ua", label: "applyOrganization(view)" },
      ],
      panel: {
        kind: "state",
        title: "organization acme",
        rows: [
          ["name", "Acme"],
          ["ownerId", "alice"],
          ["members", "alice · owner"],
          ["revision", "1"],
          ["audit", "org.create · Created Acme"],
          ["outbox", "user alice · delivered after commit"],
        ],
      },
    },
    {
      title: "Invite Bob as a member.",
      body: "Bob signed in the same way and has his user actor open. The organization stores a seven-day invitation and pushes it to that actor, and Bob's tab gets the changed event.",
      enter: ["bob", "ub"],
      focus: ["org", "ub", "bob"],
      status: { org: "rev 2", ub: "1 invitation" },
      flows: [
        {
          edge: "alice-org",
          label: 'invite({ userId: "bob", role: "member" })',
        },
        { edge: "bob-api", label: "principal token", back: true },
        { edge: "org-ub", label: "applyOrganization(view)" },
        { edge: "bob-ub", label: "changed", back: true },
      ],
      panel: {
        kind: "state",
        title: "user bob · inbox",
        rows: [
          ["orgName", "Acme"],
          ["role", "member"],
          ["invitedBy", "alice"],
          ["expiresAt", "in 7 days"],
          ["organizations", "none yet"],
        ],
      },
    },
    {
      title: "Bob accepts.",
      body: "respond checks that the invitation is his, then adds him with the invited role. His mirror moves Acme from the inbox to his organizations. Alice's tab sees the new member through the organization's changed event.",
      focus: ["bob", "org", "ub"],
      status: { org: "rev 3", ub: "acme · member" },
      flows: [
        { edge: "bob-org", label: "respond({ inviteId, accept: true })" },
        { edge: "org-ub", label: "applyOrganization(view)" },
        { edge: "alice-org", label: "changed", back: true },
      ],
      panel: {
        kind: "state",
        title: "organization acme",
        rows: [
          ["members", "alice · owner, bob · member"],
          ["invitations", "none"],
          ["revision", "3"],
          ["user bob", "organizations: Acme (member) · inbox: empty"],
        ],
      },
    },
    {
      title: "The project asks first.",
      body: "A project never copies membership. Before each action it asks the organization for the caller's role with system params, then checks the permission. It uses get, not getOrCreate, so a guessed key never starts an actor.",
      enter: ["project"],
      focus: ["bob", "project", "org"],
      status: { project: "task added", org: "bob · member" },
      flows: [
        { edge: "bob-project", label: 'addTask("Draft the plan")' },
        { edge: "project-org", label: "projectRole({ projectId, userId })" },
      ],
      panel: {
        kind: "trace",
        title: "project.addTask",
        spans: [
          {
            name: "project.addTask",
            depth: 0,
            start: 0,
            width: 100,
            tone: "actor",
          },
          {
            name: "allow(project.write)",
            depth: 1,
            start: 4,
            width: 56,
            tone: "actor",
          },
          {
            name: "organization.projectRole",
            depth: 2,
            start: 10,
            width: 44,
            note: "member",
            tone: "actor",
          },
          {
            name: "commit",
            depth: 1,
            start: 66,
            width: 30,
            note: "task.add · rev 1",
            tone: "actor",
          },
        ],
      },
    },
    {
      title: "Alice removes Bob.",
      body: "removeMember deletes Bob's row and queues two deliveries in the same transaction: a view with no role for his user actor, so Acme leaves his switcher, and a revoke that asks each project to close his sockets. From now on, changes reach current members only.",
      focus: ["alice", "org", "ub", "project"],
      status: { org: "rev 4", ub: "no orgs" },
      flows: [
        { edge: "alice-org", label: 'removeMember("bob")' },
        { edge: "org-ub", label: "applyOrganization(view)" },
        { edge: "project-org", label: 'revokeAccess("bob")', back: true },
      ],
      panel: {
        kind: "state",
        title: "user bob",
        rows: [
          ["organizations", "none"],
          ["inbox", "empty"],
          ["org_views.acme", "revision 4 · role null"],
        ],
      },
    },
    {
      title: "Every call asks again.",
      body: "Bob's tab reconnects and is refused at connect. Even a socket that slipped through would fail: each action asks the organization for the role, never a copy.",
      focus: ["bob", "project", "org"],
      status: { project: "refused", org: "bob · none" },
      flows: [
        { edge: "bob-project", label: 'addTask("One more")' },
        { edge: "project-org", label: "projectRole({ projectId, userId })" },
      ],
      panel: {
        kind: "trace",
        title: "project.addTask",
        spans: [
          {
            name: "project.addTask",
            depth: 0,
            start: 0,
            width: 100,
            tone: "error",
          },
          {
            name: "allow(project.write)",
            depth: 1,
            start: 4,
            width: 70,
            tone: "actor",
          },
          {
            name: "organization.projectRole",
            depth: 2,
            start: 10,
            width: 44,
            note: "null",
            tone: "actor",
          },
          {
            name: "forbidden()",
            depth: 1,
            start: 76,
            width: 22,
            note: "FORBIDDEN · You do not have access to do that.",
            tone: "error",
          },
        ],
      },
    },
    {
      title: "A slow mirror catches up.",
      body: "Say Bob's user actor was slow to wake. The change is already committed, and its outbox row stays until a delivery succeeds. Failures back off, a cron job retries while rows remain, and waking the actor resumes the drain. The revision check makes a late or repeated push safe.",
      focus: ["org", "ub"],
      status: { org: "retry in 2s", ub: "waking" },
      flows: [{ edge: "org-ub", label: "drainOutbox → applyOrganization" }],
      panel: {
        kind: "state",
        title: "organization acme · outbox",
        rows: [
          ["change", "committed (rev 4)"],
          ["user bob", "attempt 1 failed · due in 2s"],
          ["revoke bob", "delivered"],
          ["retry", 'cron.every({ name: "outbox", action: "drainOutbox" })'],
          ["older revision", "ignored by user bob"],
        ],
      },
    },
  ],
  code: [
    {
      name: "access.ts",
      note: "Rivet's auth pattern: reject in onBeforeConnect, keep the caller in c.vars.",
      source: `export function authenticate(
  c: { request?: Request },
  params: unknown,
): Session {
  authorizeTransport(c, params);
  const session = verifyPrincipal(tokenOf(params));
  if (!session) throw unauthenticated();
  return session;
}

export function trackSession(c: { vars: EntityVars }, conn: EntityConn): void {
  const session = verifyPrincipal(tokenOf(conn.params));
  // onBeforeConnect already verified it; an edge case like a token expiring
  // between the two hooks still closes the socket instead of trusting it.
  if (!session) {
    void closeExpired(conn);
    return;
  }
  forgetSession(c, conn);
  const live: LiveSession = { ...session };
  live.expiry = setTimeout(
    () => void closeExpired(conn),
    Math.min(Math.max(session.expiresAt - Date.now(), 0), MAX_TIMER_MS),
  );
  c.vars.sessions.set(conn.id, live);
}

export function caller(c: EntityContext): Principal {
  if (!c.conn) throw unauthenticated();
  const principal = sessionPrincipal(c, c.conn);
  if (!principal) throw unauthenticated("Your sign-in expired. Reconnecting.");
  return principal;
}

export function writer(c: EntityContext): Principal {
  const principal = caller(c);
  if (!isSystem(principal)) spendWrite(c.vars, principal.sub);
  return principal;
}`,
    },
    {
      name: "store.ts",
      note: "The one write path: rows, revision, audit, and snapshot in one SQLite transaction. Publish after commit.",
      source: `export async function commit<TSnapshot>(
  store: Store<TSnapshot>,
  name: string,
  write: (tx: RawAccess) => Promise<WriteResult>,
): Promise<TSnapshot> {
  let changed = false;
  const next = await store.db.transaction(
    async (tx) => {
      const result = await write(tx);
      if (result !== null) {
        changed = true;
        const at = Date.now();
        await tx.execute(
          "UPDATE ledger SET revision = revision + 1, updated_at = ? WHERE id = 1",
          at,
        );
        if (result !== QUIET) {
          await tx.execute(
            "INSERT INTO audit (at, by, action, summary) VALUES (?, ?, ?, ?)",
            at, result.by, result.action, result.summary,
          );
          // …prune to LIMITS.auditRetained
        }
      }
      return store.read(tx);
    },
    { name },
  );
  if (changed) store.publish(next);
  return next;
}`,
    },
    {
      name: "actors/organization.ts",
      note: "Checks run inside the transaction. Calls to other actors go in the outbox and run after commit.",
      source: `    removeMember: async (c, userIdInput: unknown) => {
      const userId = assertId(userIdInput, "user id");
      const principal = writer(c);
      const leaving = userId === principal.sub;
      const next = await commit(store(c), "member.remove", async (tx) => {
        const actorRole = await authorize(
          tx,
          principal,
          leaving ? "org.leave" : "member.remove",
        );
        const role = await roleOf(tx, userId);
        if (!role) return null;
        if (role === "owner")
          throw forbidden("The owner must transfer ownership first.");
        // …rank checks
        await tx.execute("DELETE FROM members WHERE user_id = ?", userId);
        await enqueue(tx, SYNC_USER, userId);
        await enqueue(tx, REVOKE, userId);
        return {
          by: principal.sub,
          action: "member.remove",
          summary: leaving ? \`\${userId} left\` : \`Removed \${userId}\`,
        };
      });
      kick(c); // drain the outbox now; cron retries what fails
      return leaving ? null : next;
    },`,
    },
    {
      name: "actors/project.ts",
      note: "The template for your own entities: gate the socket, ask the organization, commit.",
      source: `/** The caller's role, straight from the owning organization. Never cached. */
async function roleIn(c: ProjectContext, userId: string): Promise<Role | null> {
  const { orgId, projectId } = idsOf(c.key);
  return unlessMissing(
    () =>
      c
        .client()
        .organization.get(organizationKey(orgId), asSystem())
        .projectRole({ projectId, userId }),
    null,
  );
}

export const project = actor({
  db: projectDb, // migrations() creates the tables on first wake
  createVars: () => ({ ...createEntityVars(), viewers: new Map() }),
  onBeforeConnect: async (c, params) => {
    const { principal } = authenticate(c, params);
    if (!(await canRead(c, principal))) throw forbidden();
  },
  onConnect: (c, conn) => trackSession(c, conn),
  events: {
    changed: event<ProjectSnapshot, ProjectContext>({
      canSubscribe: (c) => canRead(c, caller(c)),
    }),
  },
  actions: {
    addTask: async (c, title: unknown): Promise<ProjectSnapshot> => {
      const { sub } = await allow(c, "project.write");
      const clean = cleanName(title, "task title");
      return commit(store(c), "task.add", async (tx) => {
        const [row] = await tx.execute<{ n: number }>(
          "SELECT count(*) AS n FROM tasks",
        );
        assertRoom(row?.n ?? 0, LIMITS.tasks, "task");
        await tx.execute(
          "INSERT INTO tasks (task_id, title, created_by, created_at) VALUES (?, ?, ?, ?)",
          crypto.randomUUID(), clean, sub, Date.now(),
        );
        return { by: sub, action: "task.add", summary: \`Added \${clean}\` };
      });
    },
    // …
  },
});`,
    },
  ],
};
