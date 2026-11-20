/**
 * The desk against real Postgres (PGlite, in-process): idempotent opening,
 * the response clock, notes, status rules, and the analytics medians all
 * live in SQL and column updates a mock would not check.
 */
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { createSupportDesk, type TicketChange } from "../src/index";

const SCHEMA = `
  CREATE TABLE support_tickets (
    agent_unread boolean NOT NULL DEFAULT true,
    assignee varchar(320), category varchar(40) NOT NULL DEFAULT 'problem',
    close_reason varchar(40), context jsonb NOT NULL DEFAULT '{}',
    created_at timestamp NOT NULL DEFAULT now(),
    error_fingerprint varchar(128), first_response_at timestamp,
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number bigserial NOT NULL,
    priority varchar(16) NOT NULL DEFAULT 'normal', replay_id varchar(64),
    requester_email varchar(320) NOT NULL, requester_id varchar(128),
    requester_name varchar(255),
    requester_unread boolean NOT NULL DEFAULT false, resolved_at timestamp,
    source varchar(40) NOT NULL DEFAULT 'web',
    status varchar(16) NOT NULL DEFAULT 'open', subject varchar(255) NOT NULL,
    submission_id varchar(64), trace_id varchar(64),
    updated_at timestamp NOT NULL DEFAULT now(),
    about_id varchar(255), about_type varchar(40), deleted_at timestamp,
    diagnostic_note text, fix_commit varchar(120), fix_summary text,
    fixed_at timestamp, follow_up_notes text, internal_notes text,
    report jsonb, retest varchar(10), verified_at timestamp,
    verified_by varchar(320)
  );
  CREATE UNIQUE INDEX support_tickets_submission_idx
    ON support_tickets (requester_email, submission_id);
  CREATE TABLE support_messages (
    author_id varchar(320), author_kind varchar(16) NOT NULL,
    author_name varchar(255), body text NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    id bigserial PRIMARY KEY, internal boolean NOT NULL DEFAULT false,
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    edited_at timestamp, kind varchar(16) NOT NULL DEFAULT 'reply', meta jsonb
  );
  CREATE TABLE support_events (
    actor varchar(320), at timestamp NOT NULL DEFAULT now(),
    from_value varchar(320), id bigserial PRIMARY KEY,
    kind varchar(20) NOT NULL, note text,
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    to_value varchar(320)
  );
  CREATE TABLE support_attachments (
    created_at timestamp NOT NULL DEFAULT now(), id bigserial PRIMARY KEY,
    kind varchar(16) NOT NULL, name varchar(255),
    purpose varchar(8) NOT NULL DEFAULT 'report', size_bytes integer,
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    uploaded_by varchar(320), url text NOT NULL
  );
  CREATE TABLE support_diagnostics (
    bundle jsonb NOT NULL, capture_id varchar(128) NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(), expires_at timestamp NOT NULL,
    id bigserial PRIMARY KEY, size_bytes integer NOT NULL DEFAULT 0,
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX support_diagnostics_capture_idx
    ON support_diagnostics (ticket_id, capture_id);
  CREATE TABLE support_recipients (
    created_at timestamp NOT NULL DEFAULT now(), email varchar(320) NOT NULL,
    id bigserial PRIMARY KEY, scope varchar(40) NOT NULL DEFAULT 'all'
  );
  CREATE UNIQUE INDEX support_recipients_email_idx ON support_recipients (email);
`;

let db: ReturnType<typeof drizzle>;
let changes: TicketChange[];
let desk: ReturnType<typeof createSupportDesk>;

const REQUESTER = { email: "Ada@Example.com", id: "user-1", name: "Ada" };
const AGENT = {
  id: "agent@absolutejs.ai",
  kind: "agent" as const,
  name: "Sam",
};

beforeEach(async () => {
  const client = new PGlite();
  await client.exec(SCHEMA);
  db = drizzle({ client });
  changes = [];
  desk = createSupportDesk({
    db,
    onChange: (change) => {
      changes.push(change);
    },
  });
});

const openOne = (overrides: Partial<Parameters<typeof desk.open>[0]> = {}) =>
  desk.open({
    body: "The deploy button does nothing.",
    context: { surface: "portal", url: "/portal/projects/1" },
    requester: REQUESTER,
    subject: "Deploy does nothing",
    ...overrides,
  });

describe("opening", () => {
  test("a ticket keeps its context and its first message", async () => {
    const ticket = await openOne({ errorFingerprint: "fp-1", replayId: "r-1" });
    const detail = await desk.get(ticket.id);

    expect(ticket.status).toBe("open");
    expect(ticket.requester.email).toBe("ada@example.com");
    expect(ticket.context.url).toBe("/portal/projects/1");
    expect(ticket.errorFingerprint).toBe("fp-1");
    expect(detail?.messages.map((message) => message.body)).toEqual([
      "The deploy button does nothing.",
    ]);
    expect(changes.map((change) => change.kind)).toEqual(["opened"]);
  });

  test("a retried submission returns the same ticket", async () => {
    const first = await openOne({ submissionId: "s-1" });
    const second = await openOne({ submissionId: "s-1" });

    expect(second.id).toBe(first.id);
    expect((await desk.list()).total).toBe(1);
  });

  test("tickets get short sequential numbers", async () => {
    const first = await openOne();
    const second = await openOne({ subject: "Another" });

    expect(second.number).toBe(first.number + 1);
  });
});

describe("the conversation", () => {
  test("an agent's first reply starts the clock and waits on the requester", async () => {
    const ticket = await openOne();
    const replied = await desk.reply({
      author: AGENT,
      body: "Looking now.",
      ticketId: ticket.id,
    });

    expect(replied?.ticket.status).toBe("pending");
    expect(replied?.ticket.firstResponseAt).not.toBeNull();
    expect(replied?.ticket.requesterUnread).toBe(true);
    const firstResponse = replied?.ticket.firstResponseAt;
    const again = await desk.reply({
      author: AGENT,
      body: "Still looking.",
      ticketId: ticket.id,
    });
    expect(again?.ticket.firstResponseAt).toBe(firstResponse ?? null);
  });

  test("an internal note changes nothing and the requester never sees it", async () => {
    const ticket = await openOne();
    const noted = await desk.reply({
      author: AGENT,
      body: "Probably the release from this morning.",
      internal: true,
      ticketId: ticket.id,
    });

    expect(noted?.ticket.status).toBe("open");
    expect(noted?.ticket.firstResponseAt).toBeNull();
    const asRequester = await desk.get(ticket.id, { forRequester: true });
    expect(asRequester?.messages).toHaveLength(1);
    expect((await desk.get(ticket.id))?.messages).toHaveLength(2);
  });

  test("a requester's reply reopens a resolved ticket", async () => {
    const ticket = await openOne();
    await desk.setStatus({
      actor: AGENT.id,
      closeReason: "fixed",
      status: "resolved",
      ticketId: ticket.id,
    });
    const replied = await desk.reply({
      author: { id: REQUESTER.id, kind: "requester" },
      body: "Still broken.",
      ticketId: ticket.id,
    });

    expect(replied?.ticket.status).toBe("open");
    expect(replied?.ticket.resolvedAt).toBeNull();
    expect(replied?.ticket.closeReason).toBeNull();
    expect(replied?.ticket.agentUnread).toBe(true);
  });
});

describe("reading", () => {
  test("marking read writes only when something was unread", async () => {
    const ticket = await openOne();

    expect(await desk.markRead(ticket.id, "agent")).toBe(true);
    expect(await desk.markRead(ticket.id, "agent")).toBe(false);
    expect((await desk.get(ticket.id))?.ticket.agentUnread).toBe(false);
  });
});

describe("status, priority and assignment", () => {
  test("resolving stamps when and why, and every change is an event", async () => {
    const ticket = await openOne();
    await desk.setPriority({
      actor: AGENT.id,
      priority: "high",
      ticketId: ticket.id,
    });
    await desk.assign({
      actor: AGENT.id,
      assignee: AGENT.id,
      ticketId: ticket.id,
    });
    const resolved = await desk.setStatus({
      actor: AGENT.id,
      closeReason: "fixed",
      note: "Shipped in r42",
      status: "resolved",
      ticketId: ticket.id,
    });
    const detail = await desk.get(ticket.id);

    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.closeReason).toBe("fixed");
    expect(detail?.events.map((event) => `${event.kind}:${event.to}`)).toEqual([
      "priority:high",
      `assignee:${AGENT.id}`,
      "status:resolved",
    ]);
    expect(detail?.events.at(-1)?.note).toBe("Shipped in r42");
  });

  test("setting what is already set records nothing", async () => {
    const ticket = await openOne();
    await desk.setStatus({ status: "open", ticketId: ticket.id });

    expect((await desk.get(ticket.id))?.events).toEqual([]);
  });
});

describe("lists and analytics", () => {
  test("filters by requester, status and text, and counts by status", async () => {
    const first = await openOne();
    await openOne({
      requester: { email: "bob@example.com" },
      subject: "Billing question",
    });
    await desk.setStatus({ status: "closed", ticketId: first.id });

    const mine = await desk.list({ requester: { id: REQUESTER.id } });
    expect(mine.tickets.map((ticket) => ticket.id)).toEqual([first.id]);
    expect((await desk.list({ status: "active" })).total).toBe(1);
    expect((await desk.list({ query: "billing" })).total).toBe(1);
    const counts = await desk.statusCounts();
    expect(counts).toContainEqual({ count: 1, status: "closed" });
    expect(counts).toContainEqual({ count: 1, status: "open" });
  });

  test("medians for first response and resolution, and the backlog", async () => {
    const answered = await openOne();
    await openOne({ priority: "urgent", subject: "Down" });
    await desk.reply({ author: AGENT, body: "On it", ticketId: answered.id });
    await desk.setStatus({ status: "resolved", ticketId: answered.id });
    const report = await desk.analytics(7);

    expect(report.opened).toBe(2);
    expect(report.resolved).toBe(1);
    expect(report.unanswered).toBe(1);
    expect(report.medianFirstResponseMs).not.toBeNull();
    expect(report.backlog).toEqual([{ count: 1, priority: "urgent" }]);
  });
});

describe("the fix workflow", () => {
  test("a fix waits on the requester, who confirms it closes it as fixed", async () => {
    const ticket = await openOne({
      report: { actual: "Nothing", expected: "A deploy", frequency: "always" },
    });
    const fix = await desk.reply({
      author: AGENT,
      body: "Fixed in the last release: try again.",
      kind: "fix",
      meta: { fixCommit: "a1b2c3d" },
      ticketId: ticket.id,
    });
    expect(fix?.ticket.status).toBe("verifying");
    expect(fix?.ticket.fix).toMatchObject({
      commit: "a1b2c3d",
      summary: "Fixed in the last release: try again.",
    });
    expect(fix?.ticket.retest).toBe("pending");
    expect(fix?.ticket.firstResponseAt).not.toBeNull();
    const confirmed = await desk.verdict({
      by: { email: "ada@example.com" },
      ticketId: ticket.id,
      works: true,
    });
    expect(confirmed).not.toBe("not-verifying");
    const after = await desk.get(ticket.id);
    expect(after?.ticket).toMatchObject({
      closeReason: "fixed",
      report: { actual: "Nothing", expected: "A deploy", frequency: "always" },
      retest: "pass",
      status: "closed",
      verifiedBy: "ada@example.com",
    });
    expect(after?.messages.map((message) => message.kind)).toEqual([
      "reply",
      "fix",
      "resolution",
    ]);
  });

  test("a fix that didn't hold reopens with what the requester said", async () => {
    const ticket = await openOne();
    await desk.reply({
      author: AGENT,
      body: "Try now.",
      kind: "fix",
      ticketId: ticket.id,
    });
    await desk.verdict({
      by: { email: "ada@example.com" },
      reason: "Still spins on Safari.",
      ticketId: ticket.id,
      works: false,
    });
    const after = await desk.get(ticket.id);
    expect(after?.ticket).toMatchObject({
      followUpNotes: "Still spins on Safari.",
      retest: "fail",
      status: "open",
    });
    expect(
      await desk.verdict({
        by: { email: "ada@example.com" },
        ticketId: ticket.id,
        works: true,
      }),
    ).toBe("not-verifying");
  });

  test("the requester's view leaves out notes, the diagnostic note and the fix's change", async () => {
    const ticket = await openOne({ diagnosticNote: "viewport 390x844" });
    await desk.setNotes({ internalNotes: "VIP", ticketId: ticket.id });
    await desk.reply({
      author: AGENT,
      body: "Checking the logs.",
      kind: "note",
      ticketId: ticket.id,
    });
    await desk.reply({
      author: AGENT,
      body: "Fixed.",
      kind: "fix",
      meta: { fixCommit: "deadbeef" },
      ticketId: ticket.id,
    });
    const theirs = await desk.get(ticket.id, { forRequester: true });
    expect(theirs?.ticket.internalNotes).toBeNull();
    expect(theirs?.ticket.diagnosticNote).toBeNull();
    expect(theirs?.ticket.fix?.commit).toBeNull();
    expect(theirs?.messages.map((message) => message.kind)).toEqual([
      "reply",
      "fix",
    ]);
    expect(theirs?.messages[1]?.meta?.fixCommit).toBeUndefined();
    const ours = await desk.get(ticket.id);
    expect(ours?.ticket.internalNotes).toBe("VIP");
    expect(ours?.messages).toHaveLength(3);
  });
});

describe("around a ticket", () => {
  test("attachments are evidence or proof, and touch the ticket", async () => {
    const ticket = await openOne();
    await desk.attachments.add({
      kind: "image",
      name: "screen.png",
      sizeBytes: 1200,
      ticketId: ticket.id,
      url: "https://files.test/screen.png",
    });
    const proof = await desk.attachments.add({
      kind: "video",
      purpose: "fix",
      ticketId: ticket.id,
      url: "https://files.test/fixed.mp4",
    });
    expect(
      (await desk.attachments.list(ticket.id)).map((file) => file.purpose),
    ).toEqual(["report", "fix"]);
    expect(await desk.attachments.remove(proof?.id ?? 0)).toBe(true);
    expect(await desk.attachments.list(ticket.id)).toHaveLength(1);
  });

  test("a diagnostic capture is stored once and goes when it expires", async () => {
    const ticket = await openOne();
    const capture = {
      bundle: { archive: { manifest: { id: "cap-1" } } },
      captureId: "cap-1",
      expiresAt: new Date(Date.now() + 60_000),
      sizeBytes: 20,
      ticketId: ticket.id,
    };
    const first = await desk.diagnostics.store(capture);
    const again = await desk.diagnostics.store(capture);
    expect(again?.id).toBe(first?.id ?? -1);
    await desk.diagnostics.store({
      ...capture,
      captureId: "cap-old",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(
      (await desk.diagnostics.list(ticket.id)).map((entry) => entry.captureId),
    ).toEqual(["cap-1"]);
  });

  test("recipients hear about everything, or about one category", async () => {
    await desk.recipients.add({ email: "Owner@Shop.test" });
    await desk.recipients.add({ email: "dev@shop.test", scope: "bug" });
    expect((await desk.recipients.for("bug")).sort()).toEqual([
      "dev@shop.test",
      "owner@shop.test",
    ]);
    expect(await desk.recipients.for("order")).toEqual(["owner@shop.test"]);
  });

  test("a guest finds their ticket by its reference and their email", async () => {
    const ticket = await openOne();
    const reference = ticket.id.replaceAll("-", "").slice(0, 8).toUpperCase();
    expect(
      (await desk.findByReference({ email: "ada@example.com", reference }))?.id,
    ).toBe(ticket.id);
    expect(
      await desk.findByReference({ email: "someone@else.test", reference }),
    ).toBeNull();
  });

  test("a deleted ticket leaves every list and read", async () => {
    const ticket = await openOne();
    await desk.remove(ticket.id, "agent@absolutejs.ai");
    expect(await desk.get(ticket.id)).toBeNull();
    expect((await desk.list()).total).toBe(0);
    expect(await desk.unreadCount()).toBe(0);
  });

  test("an edited message says so", async () => {
    const ticket = await openOne();
    const posted = await desk.reply({
      author: AGENT,
      body: "Lookin into it",
      ticketId: ticket.id,
    });
    const edited = await desk.editMessage({
      body: "Looking into it.",
      messageId: posted?.message.id ?? 0,
    });
    expect(edited?.body).toBe("Looking into it.");
    expect(edited?.editedAt).not.toBeNull();
  });

  test("an agent's reply to a ticket in progress waits on the requester", async () => {
    const ticket = await openOne({ category: "bug" });
    await desk.setStatus({ status: "in-progress", ticketId: ticket.id });
    const replied = await desk.reply({
      author: AGENT,
      body: "Which browser?",
      ticketId: ticket.id,
    });
    expect(replied?.ticket.status).toBe("pending");
    expect(
      (await desk.list({ category: "bug", sort: "created" })).tickets,
    ).toHaveLength(1);
    expect(await desk.categoryCounts()).toEqual([
      { category: "bug", count: 1 },
    ]);
  });
});

describe("a requester writing back", () => {
  test("doesn't take a ticket out of progress or out of verifying", async () => {
    const ticket = await openOne();
    await desk.reply({
      author: AGENT,
      body: "Try now.",
      kind: "fix",
      ticketId: ticket.id,
    });
    const wrote = await desk.reply({
      author: { id: "user-1", kind: "requester" },
      body: "Trying it tonight.",
      ticketId: ticket.id,
    });
    expect(wrote?.ticket.status).toBe("verifying");
    expect(wrote?.message.ticketId).toBe(ticket.id);
    const message = await desk.getMessage(wrote?.message.id ?? 0);
    expect(message?.ticketId).toBe(ticket.id);
  });
});
