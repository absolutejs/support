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
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX support_tickets_submission_idx
    ON support_tickets (requester_email, submission_id);
  CREATE TABLE support_messages (
    author_id varchar(320), author_kind varchar(16) NOT NULL,
    author_name varchar(255), body text NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    id bigserial PRIMARY KEY, internal boolean NOT NULL DEFAULT false,
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE
  );
  CREATE TABLE support_events (
    actor varchar(320), at timestamp NOT NULL DEFAULT now(),
    from_value varchar(320), id bigserial PRIMARY KEY,
    kind varchar(20) NOT NULL, note text,
    ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    to_value varchar(320)
  );
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
