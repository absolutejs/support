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
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";
import {
  supportAttachments,
  supportDiagnostics,
  supportEvents,
  supportMessages,
  supportRecipients,
  supportTickets,
  type AttachmentPurpose,
  type MessageKind,
  type MessageMeta,
  type RetestResult,
  type TicketReport,
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
type AttachmentRow = typeof supportAttachments.$inferSelect;
type DiagnosticRow = typeof supportDiagnostics.$inferSelect;
type RecipientRow = typeof supportRecipients.$inferSelect;

export type SupportTicket = {
  /** What it's about in the application: an order, a quote… */
  about: { id: string; type: string } | null;
  agentUnread: boolean;
  assignee: string | null;
  /** For the agents only (left out of a requester's view). */
  diagnosticNote: string | null;
  /** The fix: what was done, the change (agents only), and when. */
  fix: { at: number | null; commit: string | null; summary: string } | null;
  followUpNotes: string | null;
  /** For the agents only (left out of a requester's view). */
  internalNotes: string | null;
  report: TicketReport | null;
  retest: RetestResult | null;
  verifiedAt: number | null;
  verifiedBy: string | null;
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
  editedAt: number | null;
  id: number;
  internal: boolean;
  kind: MessageKind;
  meta: MessageMeta | null;
  ticketId: string;
};

export type SupportAttachment = {
  createdAt: number;
  id: number;
  kind: string;
  name: string | null;
  purpose: AttachmentPurpose;
  sizeBytes: number | null;
  ticketId: string;
  uploadedBy: string | null;
  url: string;
};

export type SupportDiagnostic = {
  bundle: Record<string, unknown>;
  captureId: string;
  createdAt: number;
  expiresAt: number;
  id: number;
  sizeBytes: number;
  ticketId: string;
};

export type SupportRecipient = {
  createdAt: number;
  email: string;
  id: number;
  scope: string;
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
  about:
    row.about_type !== null && row.about_id !== null
      ? { id: row.about_id, type: row.about_type }
      : null,
  agentUnread: row.agent_unread,
  assignee: row.assignee,
  diagnosticNote: row.diagnostic_note,
  fix:
    row.fix_summary === null
      ? null
      : {
          at: time(row.fixed_at),
          commit: row.fix_commit,
          summary: row.fix_summary,
        },
  followUpNotes: row.follow_up_notes,
  internalNotes: row.internal_notes,
  report: row.report,
  retest: row.retest,
  verifiedAt: time(row.verified_at),
  verifiedBy: row.verified_by,
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

export const toSupportMessage = (row: MessageRow): SupportMessage => ({
  author: { id: row.author_id, kind: row.author_kind, name: row.author_name },
  body: row.body,
  createdAt: row.created_at.getTime(),
  editedAt: time(row.edited_at),
  id: Number(row.id),
  internal: row.internal,
  kind: row.kind,
  meta: row.meta,
  ticketId: row.ticket_id,
});

const toSupportAttachment = (row: AttachmentRow): SupportAttachment => ({
  createdAt: row.created_at.getTime(),
  id: Number(row.id),
  kind: row.kind,
  name: row.name,
  purpose: row.purpose,
  sizeBytes: row.size_bytes,
  ticketId: row.ticket_id,
  uploadedBy: row.uploaded_by,
  url: row.url,
});

const toSupportDiagnostic = (row: DiagnosticRow): SupportDiagnostic => ({
  bundle: row.bundle,
  captureId: row.capture_id,
  createdAt: row.created_at.getTime(),
  expiresAt: row.expires_at.getTime(),
  id: Number(row.id),
  sizeBytes: row.size_bytes,
  ticketId: row.ticket_id,
});

const toSupportRecipient = (row: RecipientRow): SupportRecipient => ({
  createdAt: row.created_at.getTime(),
  email: row.email,
  id: Number(row.id),
  scope: row.scope,
});

/** A ticket as its requester may see it: the agents' notes, the page's
 *  diagnostic note and the fix's change are left out. */
export const forRequesterTicket = (ticket: SupportTicket): SupportTicket => ({
  ...ticket,
  diagnosticNote: null,
  fix: ticket.fix === null ? null : { ...ticket.fix, commit: null },
  internalNotes: null,
});

/** A message as the requester may see it: what it recorded about the
 *  fix's change is left out. */
export const forRequesterMessage = (
  message: SupportMessage,
): SupportMessage => {
  if (message.meta === null || message.meta.fixCommit === undefined)
    return message;
  const { fixCommit: _hidden, ...meta } = message.meta;

  return { ...message, meta };
};

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
  /** What it's about in the application: an order, a quote… */
  about?: { id: string; type: string };
  body: string;
  /** What the page captured for the agents; never shown to the requester. */
  diagnosticNote?: string;
  category?: string;
  context?: TicketContext;
  errorFingerprint?: string;
  priority?: TicketPriority;
  replayId?: string;
  /** The bug form: expected, actual, steps, how often. */
  report?: TicketReport;
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
  /** An agent's note to other agents: never shown to the requester. The
   *  same as kind `note`. */
  internal?: boolean;
  /**
   * `reply` (the default) or `note`; `fix` sends a fix for the requester to
   * try (the ticket waits in `verifying`); `resolution` closes it as fixed;
   * `reject` says a fix didn't hold and reopens it.
   */
  kind?: MessageKind;
  /** What this message records about the fix, at the time. */
  meta?: MessageMeta;
  ticketId: string;
};

export type TicketChange =
  | { kind: "opened"; message: SupportMessage; ticket: SupportTicket }
  | { kind: "replied"; message: SupportMessage; ticket: SupportTicket }
  | {
      kind: "status" | "priority" | "assignee";
      event: SupportEvent;
      ticket: SupportTicket;
    }
  | { kind: "deleted"; ticket: SupportTicket };

export type TicketSort = "created" | "name" | "priority" | "status" | "updated";

export type TicketListQuery = {
  /** One agent's tickets; `null` for nobody's. */
  assignee?: string | null;
  category?: string;
  /** Oldest or newest first, by `sort` (newest first by default). */
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
  priority?: TicketPriority;
  /** Substring of the subject or the requester's email. */
  query?: string;
  /** One requester's tickets, by their id or email. */
  requester?: { email?: string; id?: string };
  sort?: TicketSort;
  /** One status, or `active` for everything not yet resolved or closed. */
  status?: TicketStatus | "active";
  /** Any of these statuses. */
  statuses?: TicketStatus[];
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
      .where(
        and(eq(supportTickets.id, ticketId), isNull(supportTickets.deleted_at)),
      );

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
    const submitted = async (submissionId: string) => {
      const [existing] = await db
        .select()
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.requester_email, email),
            eq(supportTickets.submission_id, submissionId),
          ),
        );

      return existing;
    };
    if (input.submissionId !== undefined) {
      const existing = await submitted(input.submissionId);
      if (existing) return toSupportTicket(existing);
    }
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        about_id: input.about?.id ?? null,
        about_type: input.about?.type ?? null,
        category: input.category ?? "problem",
        context: input.context ?? {},
        diagnostic_note: input.diagnosticNote ?? null,
        report: input.report ?? null,
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
      /* A retry racing this one past the read above lands on the unique
       * index: it gets the ticket the first one opened, not an error. */
      .onConflictDoNothing({
        target: [supportTickets.requester_email, supportTickets.submission_id],
      })
      .returning();
    if (!ticket) {
      const raced =
        input.submissionId === undefined
          ? undefined
          : await submitted(input.submissionId);
      if (!raced) throw new Error("The ticket could not be opened");

      return toSupportTicket(raced);
    }
    const opened = ticket;
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
    const kind: MessageKind =
      input.kind ?? (input.internal === true ? "note" : "reply");
    const internal =
      input.author.kind === "agent" &&
      (kind === "note" || input.internal === true);
    const [message] = await db
      .insert(supportMessages)
      .values({
        author_id: input.author.id ?? null,
        author_kind: input.author.kind,
        author_name: input.author.name ?? null,
        body: input.body,
        internal,
        kind,
        meta: input.meta ?? null,
        ticket_id: ticket.id,
      })
      .returning();
    const now = new Date();
    const meta = input.meta ?? {};
    let status: TicketStatus = ticket.status;
    if (kind === "fix") status = "verifying";
    else if (kind === "resolution") status = "closed";
    else if (kind === "reject") status = "open";
    else if (internal) status = ticket.status;
    /* A requester writing back needs the agents again, unless somebody is
     * already on it or a fix is waiting on their verdict. */
    else if (input.author.kind === "requester")
      status =
        ticket.status === "in-progress" || ticket.status === "verifying"
          ? ticket.status
          : "open";
    else if (ticket.status === "open" || ticket.status === "in-progress")
      status = "pending";
    const statusChanged = status !== ticket.status;
    /* A fix or resolution writes what was done onto the ticket; a reject
     * keeps what the requester said; whoever verified it, when they did. */
    const fixed =
      kind === "fix" || kind === "resolution"
        ? {
            fix_commit: meta.fixCommit ?? ticket.fix_commit,
            fix_summary: input.body,
            fixed_at: now,
          }
        : {};
    const retest =
      meta.retest !== undefined && meta.retest !== null
        ? { retest: meta.retest }
        : kind === "fix"
          ? { retest: "pending" as const }
          : kind === "reject"
            ? { retest: "fail" as const }
            : {};
    const verified =
      typeof meta.verifiedBy === "string" && meta.verifiedBy !== ""
        ? { verified_at: now, verified_by: meta.verifiedBy }
        : {};
    const followUp =
      kind === "reject"
        ? { follow_up_notes: meta.followUpNotes ?? input.body }
        : {};
    const [updated] = await db
      .update(supportTickets)
      .set({
        updated_at: now,
        ...fixed,
        ...retest,
        ...verified,
        ...followUp,
        ...(statusChanged
          ? {
              status,
              ...(status === "closed"
                ? {
                    close_reason: "fixed",
                    resolved_at: ticket.resolved_at ?? now,
                  }
                : {}),
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

    const shown = messages.map(toSupportMessage);

    return {
      events: events.map(toSupportEvent),
      messages: view.forRequester ? shown.map(forRequesterMessage) : shown,
      ticket: view.forRequester
        ? forRequesterTicket(toSupportTicket(ticket))
        : toSupportTicket(ticket),
    };
  };

  const filtersFor = (query: TicketListQuery) => {
    const filters: SQL[] = [isNull(supportTickets.deleted_at)];
    if (query.status === "active")
      filters.push(
        inArray(supportTickets.status, [
          "open",
          "in-progress",
          "pending",
          "verifying",
        ]),
      );
    else if (query.status !== undefined)
      filters.push(eq(supportTickets.status, query.status));
    if (query.statuses !== undefined && query.statuses.length > 0)
      filters.push(inArray(supportTickets.status, query.statuses));
    if (query.category !== undefined)
      filters.push(eq(supportTickets.category, query.category));
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
        ilike(supportTickets.requester_name, text),
        sql`exists (select 1 from ${supportMessages} where ${supportMessages.ticket_id} = ${supportTickets.id} and ${supportMessages.body} ilike ${text})`,
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

  const SORT_COLUMNS = {
    created: supportTickets.created_at,
    name: supportTickets.requester_name,
    priority: supportTickets.priority,
    status: supportTickets.status,
    updated: supportTickets.updated_at,
  } as const;
  const orderFor = (query: TicketListQuery) => {
    const column = SORT_COLUMNS[query.sort ?? "updated"];

    return query.direction === "asc" ? asc(column) : desc(column);
  };

  /** Most recently changed first (or as sorted), the page and its total. */
  const list = async (query: TicketListQuery = {}) => {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const where = and(...filtersFor(query));
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(supportTickets)
        .where(where)
        .orderBy(orderFor(query))
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
        .where(
          and(
            sql`${supportTickets.created_at} >= ${since}`,
            isNull(supportTickets.deleted_at),
          ),
        ),
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
            isNull(supportTickets.deleted_at),
          ),
        ),
      db
        .select({
          count: sql<number>`count(*)::int`,
          priority: supportTickets.priority,
        })
        .from(supportTickets)
        .where(
          and(
            inArray(supportTickets.status, [
              "open",
              "in-progress",
              "pending",
              "verifying",
            ]),
            isNull(supportTickets.deleted_at),
          ),
        )
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

  /**
   * The requester's word on a fix waiting in `verifying`: it works (the
   * ticket closes as fixed, verified by them) or it doesn't (it reopens,
   * with what they said). Anything else is `not-verifying`.
   */
  const verdict = async (input: {
    by: { email: string; id?: string; name?: string };
    reason?: string;
    ticketId: string;
    works: boolean;
  }) => {
    const ticket = await findTicket(input.ticketId);
    if (!ticket) return null;
    if (ticket.status !== "verifying") return "not-verifying" as const;
    const author = {
      kind: "requester" as const,
      ...(input.by.id === undefined
        ? { id: input.by.email }
        : { id: input.by.id }),
      ...(input.by.name === undefined ? {} : { name: input.by.name }),
    };

    return input.works
      ? reply({
          author,
          body: input.reason?.trim() || "Confirmed: this works now.",
          kind: "resolution",
          meta: { retest: "pass", verifiedBy: input.by.email },
          ticketId: ticket.id,
        })
      : reply({
          author,
          body: input.reason?.trim() || "It still doesn't work.",
          kind: "reject",
          meta: {
            followUpNotes: input.reason ?? null,
            retest: "fail",
            verifiedBy: input.by.email,
          },
          ticketId: ticket.id,
        });
  };

  /** The agents' own notes on a ticket; `null` clears them. */
  const setNotes = async (input: {
    internalNotes: string | null;
    ticketId: string;
  }) => {
    const [updated] = await db
      .update(supportTickets)
      .set({ internal_notes: input.internalNotes, updated_at: new Date() })
      .where(
        and(
          eq(supportTickets.id, input.ticketId),
          isNull(supportTickets.deleted_at),
        ),
      )
      .returning();

    return updated ? toSupportTicket(updated) : null;
  };

  /** Rewrite a message (its body or what it recorded), marked as edited.
   *  Who may edit is the application's call. */
  const editMessage = async (input: {
    body?: string;
    messageId: number;
    meta?: MessageMeta | null;
  }) => {
    const [updated] = await db
      .update(supportMessages)
      .set({
        edited_at: new Date(),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.meta === undefined ? {} : { meta: input.meta }),
      })
      .where(eq(supportMessages.id, input.messageId))
      .returning();

    return updated ? toSupportMessage(updated) : null;
  };

  /** One message, to check who wrote it before an edit. */
  const getMessage = async (messageId: number) => {
    const [row] = await db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.id, messageId));

    return row ? toSupportMessage(row) : null;
  };

  /** Take a ticket out of every list and read; kept for the record. */
  const remove = async (ticketId: string, actor?: string) => {
    const ticket = await findTicket(ticketId);
    if (!ticket) return null;
    const [updated] = await db
      .update(supportTickets)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(eq(supportTickets.id, ticket.id))
      .returning();
    await record(ticket.id, "status", {
      ...(actor === undefined ? {} : { actor }),
      from: ticket.status,
      note: "deleted",
      to: ticket.status,
    });
    const view = toSupportTicket(updated as TicketRow);
    await notify({ kind: "deleted", ticket: view });

    return view;
  };

  /**
   * A guest's own ticket by the reference they were given (the start of
   * its id, at least six characters) and their email.
   */
  const findByReference = async (input: {
    email: string;
    reference: string;
  }) => {
    const reference = input.reference.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (reference.length < 6) return null;
    const [row] = await db
      .select()
      .from(supportTickets)
      .where(
        and(
          isNull(supportTickets.deleted_at),
          eq(supportTickets.requester_email, input.email.trim().toLowerCase()),
          sql`replace(${supportTickets.id}::text, '-', '') like ${`${reference}%`}`,
        ),
      )
      .limit(1);

    return row ? toSupportTicket(row) : null;
  };

  /** How many tickets the agents haven't read, in the given statuses (or
   *  in any not yet resolved or closed). */
  const unreadCount = async (statuses?: TicketStatus[]) => {
    const [row] = await db
      .select({ value: count() })
      .from(supportTickets)
      .where(
        and(
          isNull(supportTickets.deleted_at),
          eq(supportTickets.agent_unread, true),
          inArray(
            supportTickets.status,
            statuses ?? ["open", "in-progress", "pending", "verifying"],
          ),
        ),
      );

    return Number(row?.value ?? 0);
  };

  /** How many tickets are in each category. */
  const categoryCounts = async () => {
    const rows = await db
      .select({
        category: supportTickets.category,
        count: sql<number>`count(*)::int`,
      })
      .from(supportTickets)
      .where(isNull(supportTickets.deleted_at))
      .groupBy(supportTickets.category);

    return rows.map((row) => ({
      category: row.category,
      count: Number(row.count),
    }));
  };

  const touch = (ticketId: string) =>
    db
      .update(supportTickets)
      .set({ updated_at: new Date() })
      .where(eq(supportTickets.id, ticketId));

  /** Evidence on a ticket: the requester's (`report`) or the agents'
   *  proof of a fix (`fix`). The file is stored by the application. */
  const attachments = {
    add: async (input: {
      kind: string;
      name?: string;
      purpose?: AttachmentPurpose;
      sizeBytes?: number;
      ticketId: string;
      uploadedBy?: string;
      url: string;
    }) => {
      const ticket = await findTicket(input.ticketId);
      if (!ticket) return null;
      const [row] = await db
        .insert(supportAttachments)
        .values({
          kind: input.kind,
          name: input.name ?? null,
          purpose: input.purpose ?? "report",
          size_bytes: input.sizeBytes ?? null,
          ticket_id: ticket.id,
          uploaded_by: input.uploadedBy ?? null,
          url: input.url,
        })
        .returning();
      await touch(ticket.id);

      return toSupportAttachment(row as AttachmentRow);
    },
    list: async (ticketId: string) =>
      (
        await db
          .select()
          .from(supportAttachments)
          .where(eq(supportAttachments.ticket_id, ticketId))
          .orderBy(
            asc(supportAttachments.created_at),
            asc(supportAttachments.id),
          )
      ).map(toSupportAttachment),
    remove: async (attachmentId: number) => {
      const removed = await db
        .delete(supportAttachments)
        .where(eq(supportAttachments.id, attachmentId))
        .returning({ id: supportAttachments.id });

      return removed.length > 0;
    },
  };

  /** A browser's diagnostic capture with a report, kept until it
   *  expires; storing the same capture twice keeps the first. */
  const diagnostics = {
    list: async (ticketId: string) => {
      await db
        .delete(supportDiagnostics)
        .where(
          and(
            eq(supportDiagnostics.ticket_id, ticketId),
            lt(supportDiagnostics.expires_at, new Date()),
          ),
        );

      return (
        await db
          .select()
          .from(supportDiagnostics)
          .where(eq(supportDiagnostics.ticket_id, ticketId))
          .orderBy(asc(supportDiagnostics.created_at))
      ).map(toSupportDiagnostic);
    },
    purgeExpired: async () => {
      const removed = await db
        .delete(supportDiagnostics)
        .where(lt(supportDiagnostics.expires_at, new Date()))
        .returning({ id: supportDiagnostics.id });

      return removed.length;
    },
    remove: async (diagnosticId: number) => {
      const removed = await db
        .delete(supportDiagnostics)
        .where(eq(supportDiagnostics.id, diagnosticId))
        .returning({ id: supportDiagnostics.id });

      return removed.length > 0;
    },
    store: async (input: {
      bundle: Record<string, unknown>;
      captureId: string;
      expiresAt: Date;
      sizeBytes: number;
      ticketId: string;
    }) => {
      const ticket = await findTicket(input.ticketId);
      if (!ticket) return null;
      await db
        .insert(supportDiagnostics)
        .values({
          bundle: input.bundle,
          capture_id: input.captureId,
          expires_at: input.expiresAt,
          size_bytes: input.sizeBytes,
          ticket_id: ticket.id,
        })
        .onConflictDoNothing();
      const [row] = await db
        .select()
        .from(supportDiagnostics)
        .where(
          and(
            eq(supportDiagnostics.ticket_id, ticket.id),
            eq(supportDiagnostics.capture_id, input.captureId),
          ),
        );

      return row ? toSupportDiagnostic(row) : null;
    },
  };

  /** Who hears about new tickets: everyone listed for `all`, or for the
   *  ticket's category. */
  const recipients = {
    add: async (input: { email: string; scope?: string }) => {
      const email = input.email.trim().toLowerCase();
      await db
        .insert(supportRecipients)
        .values({ email, scope: input.scope ?? "all" })
        .onConflictDoUpdate({
          set: { scope: input.scope ?? "all" },
          target: supportRecipients.email,
        });
      const [row] = await db
        .select()
        .from(supportRecipients)
        .where(eq(supportRecipients.email, email));

      return toSupportRecipient(row as RecipientRow);
    },
    for: async (category: string) =>
      (
        await db
          .select({ email: supportRecipients.email })
          .from(supportRecipients)
          .where(
            or(
              eq(supportRecipients.scope, "all"),
              eq(supportRecipients.scope, category),
            ),
          )
      ).map((row) => row.email),
    list: async () =>
      (
        await db
          .select()
          .from(supportRecipients)
          .orderBy(asc(supportRecipients.email))
      ).map(toSupportRecipient),
    remove: async (recipientId: number) => {
      const removed = await db
        .delete(supportRecipients)
        .where(eq(supportRecipients.id, recipientId))
        .returning({ id: supportRecipients.id });

      return removed.length > 0;
    },
  };

  return {
    analytics,
    assign,
    attachments,
    categoryCounts,
    diagnostics,
    editMessage,
    findByReference,
    get,
    getMessage,
    list,
    markRead,
    open,
    recipients,
    remove,
    reply,
    setNotes,
    setPriority,
    setStatus,
    statusCounts,
    unreadCount,
    verdict,
  };
};

export type SupportDesk = ReturnType<typeof createSupportDesk>;
