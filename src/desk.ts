/**
 * A support desk over the three tables: everything a requester and an agent
 * do to a ticket, and the numbers a team is judged on.
 *
 * Returned as an object bound to one database, so every call agrees on the
 * rules: an agent's first public reply starts the response clock, a reply
 * from the requester puts the ticket back in the agents' queue, a closed or
 * resolved ticket keeps when and how it was closed, and every change of
 * status, priority or assignee is an event somebody can read later.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";
import {
  supportEvents,
  supportMessages,
  supportTickets,
  type MessageAuthor,
  type TicketContext,
  type TicketPriority,
  type TicketStatus,
} from "./drizzle";

export type AnyPgDatabase = PgAsyncDatabase<any, any>;

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_ANALYTICS_DAYS = 30;

type TicketRow = typeof supportTickets.$inferSelect;
type MessageRow = typeof supportMessages.$inferSelect;
type EventRow = typeof supportEvents.$inferSelect;

export type SupportTicket = {
  agentUnread: boolean;
  assignee: string | null;
  category: string;
  closeReason: string | null;
  context: TicketContext;
  createdAt: number;
  errorFingerprint: string | null;
  firstResponseAt: number | null;
  id: string;
  number: number;
  priority: TicketPriority;
  replayId: string | null;
  requester: { email: string; id: string | null; name: string | null };
  requesterUnread: boolean;
  resolvedAt: number | null;
  source: string;
  status: TicketStatus;
  subject: string;
  traceId: string | null;
  updatedAt: number;
};

export type SupportMessage = {
  author: { id: string | null; kind: MessageAuthor; name: string | null };
  body: string;
  createdAt: number;
  id: number;
  internal: boolean;
};

export type SupportEvent = {
  actor: string | null;
  at: number;
  from: string | null;
  id: number;
  kind: string;
  note: string | null;
  to: string | null;
};

const time = (value: Date | null) => (value === null ? null : value.getTime());

export const toSupportTicket = (row: TicketRow): SupportTicket => ({
  agentUnread: row.agent_unread,
  assignee: row.assignee,
  category: row.category,
  closeReason: row.close_reason,
  context: row.context,
  createdAt: row.created_at.getTime(),
  errorFingerprint: row.error_fingerprint,
  firstResponseAt: time(row.first_response_at),
  id: row.id,
  number: Number(row.number),
  priority: row.priority,
  replayId: row.replay_id,
  requester: {
    email: row.requester_email,
    id: row.requester_id,
    name: row.requester_name,
  },
  requesterUnread: row.requester_unread,
  resolvedAt: time(row.resolved_at),
  source: row.source,
  status: row.status,
  subject: row.subject,
  traceId: row.trace_id,
  updatedAt: row.updated_at.getTime(),
});

const toSupportMessage = (row: MessageRow): SupportMessage => ({
  author: { id: row.author_id, kind: row.author_kind, name: row.author_name },
  body: row.body,
  createdAt: row.created_at.getTime(),
  id: Number(row.id),
  internal: row.internal,
});

const toSupportEvent = (row: EventRow): SupportEvent => ({
  actor: row.actor,
  at: row.at.getTime(),
  from: row.from_value,
  id: Number(row.id),
  kind: row.kind,
  note: row.note,
  to: row.to_value,
});

export type OpenTicketInput = {
  body: string;
  category?: string;
  context?: TicketContext;
  errorFingerprint?: string;
  priority?: TicketPriority;
  replayId?: string;
  requester: { email: string; id?: string; name?: string };
  source?: string;
  subject: string;
  /** The page's id for this submission: a retry returns the same ticket. */
  submissionId?: string;
  traceId?: string;
};

export type ReplyInput = {
  author: {
    id?: string;
    kind: Exclude<MessageAuthor, "system">;
    name?: string;
  };
  body: string;
  /** An agent's note to other agents: never shown to the requester. */
  internal?: boolean;
  ticketId: string;
};

export type TicketChange =
  | { kind: "opened"; message: SupportMessage; ticket: SupportTicket }
  | { kind: "replied"; message: SupportMessage; ticket: SupportTicket }
  | {
      kind: "status" | "priority" | "assignee";
      event: SupportEvent;
      ticket: SupportTicket;
    };

export type TicketListQuery = {
  /** One agent's tickets; `null` for nobody's. */
  assignee?: string | null;
  limit?: number;
  offset?: number;
  priority?: TicketPriority;
  /** Substring of the subject or the requester's email. */
  query?: string;
  /** One requester's tickets, by their id or email. */
  requester?: { email?: string; id?: string };
  /** One status, or `active` for open and pending together. */
  status?: TicketStatus | "active";
};

export type CreateSupportDeskOptions = {
  db: AnyPgDatabase;
  /** Called after every change, for the application to send its emails and
   *  live signals. Errors it throws are the caller's: the change is already
   *  stored. */
  onChange?: (change: TicketChange) => void | Promise<void>;
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

export const createSupportDesk = (options: CreateSupportDeskOptions) => {
  const { db, onChange } = options;
  const notify = async (change: TicketChange) => {
    if (onChange) await onChange(change);
  };

  const findTicket = async (ticketId: string) => {
    const [row] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId));

    return row;
  };

  const record = async (
    ticketId: string,
    kind: "assignee" | "priority" | "status",
    change: {
      actor?: string;
      from: string | null;
      note?: string;
      to: string | null;
    },
  ) => {
    const [row] = await db
      .insert(supportEvents)
      .values({
        actor: change.actor ?? null,
        from_value: change.from,
        kind,
        note: change.note ?? null,
        ticket_id: ticketId,
        to_value: change.to,
      })
      .returning();

    return toSupportEvent(row as EventRow);
  };

  /** Open a ticket with its first message, or return the one this
   *  submission already opened. */
  const open = async (input: OpenTicketInput) => {
    const email = input.requester.email.trim().toLowerCase();
    if (input.submissionId !== undefined) {
      const [existing] = await db
        .select()
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.requester_email, email),
            eq(supportTickets.submission_id, input.submissionId),
          ),
        );
      if (existing) return toSupportTicket(existing);
    }
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        category: input.category ?? "problem",
        context: input.context ?? {},
        error_fingerprint: input.errorFingerprint ?? null,
        priority: input.priority ?? "normal",
        replay_id: input.replayId ?? null,
        requester_email: email,
        requester_id: input.requester.id ?? null,
        requester_name: input.requester.name ?? null,
        source: input.source ?? "web",
        subject: input.subject.trim(),
        submission_id: input.submissionId ?? null,
        trace_id: input.traceId ?? null,
      })
      .returning();
    const opened = ticket as TicketRow;
    const [message] = await db
      .insert(supportMessages)
      .values({
        author_id: input.requester.id ?? email,
        author_kind: "requester",
        author_name: input.requester.name ?? null,
        body: input.body,
        ticket_id: opened.id,
      })
      .returning();
    const view = toSupportTicket(opened);
    await notify({
      kind: "opened",
      message: toSupportMessage(message as MessageRow),
      ticket: view,
    });

    return view;
  };

  /**
   * Add to the conversation. An agent's public reply starts the response
   * clock (once) and hands the ticket to the requester (`pending`); a note
   * changes nothing but the thread. A requester's reply hands it back to
   * the agents (`open`), reopening a resolved or closed one.
   */
  const reply = async (input: ReplyInput) => {
    const ticket = await findTicket(input.ticketId);
    if (!ticket) return null;
    const internal = input.author.kind === "agent" && input.internal === true;
    const [message] = await db
      .insert(supportMessages)
      .values({
        author_id: input.author.id ?? null,
        author_kind: input.author.kind,
        author_name: input.author.name ?? null,
        body: input.body,
        internal,
        ticket_id: ticket.id,
      })
      .returning();
    const now = new Date();
    let status: TicketStatus = ticket.status;
    if (input.author.kind === "requester") status = "open";
    else if (!internal && ticket.status === "open") status = "pending";
    const statusChanged = status !== ticket.status;
    const [updated] = await db
      .update(supportTickets)
      .set({
        updated_at: now,
        ...(statusChanged
          ? {
              status,
              ...(status === "open"
                ? { close_reason: null, resolved_at: null }
                : {}),
            }
          : {}),
        ...(input.author.kind === "agent" && !internal
          ? {
              agent_unread: false,
              first_response_at: ticket.first_response_at ?? now,
              requester_unread: true,
            }
          : {}),
        ...(input.author.kind === "requester"
          ? { agent_unread: true, requester_unread: false }
          : {}),
      })
      .where(eq(supportTickets.id, ticket.id))
      .returning();
    if (statusChanged)
      await record(ticket.id, "status", {
        actor: input.author.id ?? input.author.kind,
        from: ticket.status,
        to: status,
      });
    const view = toSupportTicket(updated as TicketRow);
    const posted = toSupportMessage(message as MessageRow);
    await notify({ kind: "replied", message: posted, ticket: view });

    return { message: posted, ticket: view };
  };

  /** Move a ticket on. Resolving or closing stamps when (and, with a
   *  reason, how); reopening clears both. */
  const setStatus = async (input: {
    actor?: string;
    closeReason?: string;
    note?: string;
    status: TicketStatus;
    ticketId: string;
  }) => {
    const ticket = await findTicket(input.ticketId);
    if (!ticket) return null;
    if (ticket.status === input.status) return toSupportTicket(ticket);
    const done = input.status === "resolved" || input.status === "closed";
    const [updated] = await db
      .update(supportTickets)
      .set({
        close_reason: done ? (input.closeReason ?? ticket.close_reason) : null,
        resolved_at: done ? (ticket.resolved_at ?? new Date()) : null,
        status: input.status,
        updated_at: new Date(),
      })
      .where(eq(supportTickets.id, ticket.id))
      .returning();
    const event = await record(ticket.id, "status", {
      actor: input.actor,
      from: ticket.status,
      note: input.note,
      to: input.status,
    });
    const view = toSupportTicket(updated as TicketRow);
    await notify({ event, kind: "status", ticket: view });

    return view;
  };

  const setPriority = async (input: {
    actor?: string;
    priority: TicketPriority;
    ticketId: string;
  }) => {
    const ticket = await findTicket(input.ticketId);
    if (!ticket) return null;
    if (ticket.priority === input.priority) return toSupportTicket(ticket);
    const [updated] = await db
      .update(supportTickets)
      .set({ priority: input.priority, updated_at: new Date() })
      .where(eq(supportTickets.id, ticket.id))
      .returning();
    const event = await record(ticket.id, "priority", {
      actor: input.actor,
      from: ticket.priority,
      to: input.priority,
    });
    const view = toSupportTicket(updated as TicketRow);
    await notify({ event, kind: "priority", ticket: view });

    return view;
  };

  /** Give it to an agent, or to nobody (`null`). */
  const assign = async (input: {
    actor?: string;
    assignee: string | null;
    ticketId: string;
  }) => {
    const ticket = await findTicket(input.ticketId);
    if (!ticket) return null;
    if (ticket.assignee === input.assignee) return toSupportTicket(ticket);
    const [updated] = await db
      .update(supportTickets)
      .set({ assignee: input.assignee, updated_at: new Date() })
      .where(eq(supportTickets.id, ticket.id))
      .returning();
    const event = await record(ticket.id, "assignee", {
      actor: input.actor,
      from: ticket.assignee,
      to: input.assignee,
    });
    const view = toSupportTicket(updated as TicketRow);
    await notify({ event, kind: "assignee", ticket: view });

    return view;
  };

  /**
   * One ticket with its conversation. For the requester, internal notes and
   * the event history are left out: what they see is the conversation.
   */
  const get = async (
    ticketId: string,
    view: { forRequester?: boolean } = {},
  ) => {
    const ticket = await findTicket(ticketId);
    if (!ticket) return null;
    const [messages, events] = await Promise.all([
      db
        .select()
        .from(supportMessages)
        .where(
          view.forRequester
            ? and(
                eq(supportMessages.ticket_id, ticketId),
                eq(supportMessages.internal, false),
              )
            : eq(supportMessages.ticket_id, ticketId),
        )
        .orderBy(asc(supportMessages.created_at), asc(supportMessages.id)),
      view.forRequester
        ? Promise.resolve([] as EventRow[])
        : db
            .select()
            .from(supportEvents)
            .where(eq(supportEvents.ticket_id, ticketId))
            .orderBy(asc(supportEvents.at), asc(supportEvents.id)),
    ]);

    return {
      events: events.map(toSupportEvent),
      messages: messages.map(toSupportMessage),
      ticket: toSupportTicket(ticket),
    };
  };

  const filtersFor = (query: TicketListQuery) => {
    const filters: SQL[] = [];
    if (query.status === "active")
      filters.push(inArray(supportTickets.status, ["open", "pending"]));
    else if (query.status !== undefined)
      filters.push(eq(supportTickets.status, query.status));
    if (query.priority !== undefined)
      filters.push(eq(supportTickets.priority, query.priority));
    if (query.assignee === null)
      filters.push(sql`${supportTickets.assignee} is null`);
    else if (query.assignee !== undefined)
      filters.push(eq(supportTickets.assignee, query.assignee));
    if (query.query !== undefined && query.query.trim() !== "") {
      const text = `%${query.query.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      const match = or(
        ilike(supportTickets.subject, text),
        ilike(supportTickets.requester_email, text),
      );
      if (match) filters.push(match);
    }
    const requester = query.requester;
    if (requester?.id !== undefined || requester?.email !== undefined) {
      const owner = or(
        ...(requester.id === undefined
          ? []
          : [eq(supportTickets.requester_id, requester.id)]),
        ...(requester.email === undefined
          ? []
          : [
              eq(supportTickets.requester_email, requester.email.toLowerCase()),
            ]),
      );
      if (owner) filters.push(owner);
    }

    return filters;
  };

  /** Most recently changed first, the page and its total. */
  const list = async (query: TicketListQuery = {}) => {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const where = and(...filtersFor(query));
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(supportTickets)
        .where(where)
        .orderBy(desc(supportTickets.updated_at))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(supportTickets).where(where),
    ]);

    return {
      tickets: rows.map(toSupportTicket),
      total: Number(total?.value ?? 0),
    };
  };

  /** How many tickets are in each status (for a requester, or everyone). */
  const statusCounts = async (requester?: TicketListQuery["requester"]) => {
    const rows = await db
      .select({
        count: sql<number>`count(*)::int`,
        status: supportTickets.status,
      })
      .from(supportTickets)
      .where(and(...filtersFor({ requester })))
      .groupBy(supportTickets.status);

    return rows.map((row) => ({
      count: Number(row.count),
      status: row.status,
    }));
  };

  /** A side has read the ticket: clears its unread marker. */
  /** Clears one side's unread flag. Writes nothing when it is already
   *  clear, so reading a ticket never looks like a change to it (a change
   *  feed or trigger watching the table stays quiet). */
  const markRead = async (ticketId: string, side: "agent" | "requester") => {
    const flag =
      side === "agent"
        ? supportTickets.agent_unread
        : supportTickets.requester_unread;
    const changed = await db
      .update(supportTickets)
      .set(
        side === "agent"
          ? { agent_unread: false }
          : { requester_unread: false },
      )
      .where(and(eq(supportTickets.id, ticketId), eq(flag, true)))
      .returning({ id: supportTickets.id });

    return changed.length > 0;
  };

  /**
   * How the desk is doing over a window: tickets opened and resolved, the
   * median time to a first answer and to resolution, and what is waiting
   * now, by priority. Medians, not means: one ticket left open for a month
   * should not hide that most were answered within the hour.
   */
  const analytics = async (days = DEFAULT_ANALYTICS_DAYS) => {
    const since = new Date(Date.now() - days * DAY_MS);
    const [opened, resolved, backlog] = await Promise.all([
      db
        .select({
          created: supportTickets.created_at,
          firstResponse: supportTickets.first_response_at,
        })
        .from(supportTickets)
        .where(sql`${supportTickets.created_at} >= ${since}`),
      db
        .select({
          created: supportTickets.created_at,
          resolved: supportTickets.resolved_at,
        })
        .from(supportTickets)
        .where(
          and(
            isNotNull(supportTickets.resolved_at),
            sql`${supportTickets.resolved_at} >= ${since}`,
          ),
        ),
      db
        .select({
          count: sql<number>`count(*)::int`,
          priority: supportTickets.priority,
        })
        .from(supportTickets)
        .where(inArray(supportTickets.status, ["open", "pending"]))
        .groupBy(supportTickets.priority),
    ]);

    return {
      backlog: backlog.map((row) => ({
        count: Number(row.count),
        priority: row.priority,
      })),
      days,
      medianFirstResponseMs: median(
        opened.flatMap((row) =>
          row.firstResponse === null
            ? []
            : [row.firstResponse.getTime() - row.created.getTime()],
        ),
      ),
      medianResolutionMs: median(
        resolved.flatMap((row) =>
          row.resolved === null
            ? []
            : [row.resolved.getTime() - row.created.getTime()],
        ),
      ),
      opened: opened.length,
      resolved: resolved.length,
      unanswered: opened.filter((row) => row.firstResponse === null).length,
    };
  };

  return {
    analytics,
    assign,
    get,
    list,
    markRead,
    open,
    reply,
    setPriority,
    setStatus,
    statusCounts,
  };
};

export type SupportDesk = ReturnType<typeof createSupportDesk>;
