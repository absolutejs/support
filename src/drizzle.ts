/**
 * The three tables behind a support desk.
 *
 * A ticket is the request and where it stands; its messages are the
 * conversation (with internal notes the requester never sees); its events are
 * what happened to it (status, priority, assignee), so "who closed this, and
 * why" has an answer after the fact.
 *
 * The ticket carries the context it was reported with (page, browser,
 * release, the error and the session replay recorded alongside), because that
 * is what makes a report answerable without a round of "which page were you
 * on?". Nothing on it is derived later: by the time somebody reads it, the
 * page may have changed.
 */
import {
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const TICKET_STATUSES = [
  "open",
  "pending",
  "resolved",
  "closed",
] as const;
/** `open`: waiting on us. `pending`: waiting on the requester. `resolved`:
 *  answered, the requester can reopen. `closed`: done. */
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Where it was reported and what it was about, as the reporting page saw
 *  it. Every key is optional: a page sends what it knows. */
export type TicketContext = {
  /** The browser's own description of itself. */
  userAgent?: string;
  /** The page it was reported from. */
  url?: string;
  /** The application's surface: `admin`, `portal`, `studio`… */
  surface?: string;
  release?: string;
  environment?: string;
  viewport?: string;
  /** Anything else the application wants a reader to see. */
  [key: string]: unknown;
};

export const supportTickets = pgTable(
  "support_tickets",
  {
    agent_unread: boolean().notNull().default(true),
    /** Who is handling it (the application's own id for an agent, or an
     *  email). */
    assignee: varchar({ length: 320 }),
    category: varchar({ length: 40 }).notNull().default("problem"),
    close_reason: varchar({ length: 40 }),
    context: jsonb().$type<TicketContext>().notNull().default({}),
    created_at: timestamp().notNull().defaultNow(),
    /** The `@absolutejs/errors` issue the report is about, when known. */
    error_fingerprint: varchar({ length: 128 }),
    /** When an agent first replied (an internal note does not count): what
     *  first-response time is measured to. */
    first_response_at: timestamp(),
    id: uuid().primaryKey().defaultRandom(),
    /** A short number a person can say out loud ("ticket 1042"). */
    number: bigserial({ mode: "number" }).notNull(),
    priority: varchar({ length: 16 })
      .$type<TicketPriority>()
      .notNull()
      .default("normal"),
    /** The session replay recorded with the report, when there is one. */
    replay_id: varchar({ length: 64 }),
    requester_email: varchar({ length: 320 }).notNull(),
    /** The application's own id for the person, when signed in. */
    requester_id: varchar({ length: 128 }),
    requester_name: varchar({ length: 255 }),
    requester_unread: boolean().notNull().default(false),
    resolved_at: timestamp(),
    source: varchar({ length: 40 }).notNull().default("web"),
    status: varchar({ length: 16 })
      .$type<TicketStatus>()
      .notNull()
      .default("open"),
    subject: varchar({ length: 255 }).notNull(),
    /** The page's own id for one submission, so a retried POST does not
     *  open the same ticket twice. */
    submission_id: varchar({ length: 64 }),
    trace_id: varchar({ length: 64 }),
    updated_at: timestamp().notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("support_tickets_number_idx").on(table.number),
    uniqueIndex("support_tickets_submission_idx").on(
      table.requester_email,
      table.submission_id,
    ),
    index("support_tickets_status_updated_idx").on(
      table.status,
      table.updated_at,
    ),
    index("support_tickets_requester_idx").on(
      table.requester_id,
      table.updated_at,
    ),
    index("support_tickets_requester_email_idx").on(
      table.requester_email,
      table.updated_at,
    ),
  ],
);

export const MESSAGE_AUTHORS = ["requester", "agent", "system"] as const;
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];

export const supportMessages = pgTable(
  "support_messages",
  {
    author_id: varchar({ length: 320 }),
    author_kind: varchar({ length: 16 }).$type<MessageAuthor>().notNull(),
    author_name: varchar({ length: 255 }),
    body: text().notNull(),
    created_at: timestamp().notNull().defaultNow(),
    id: bigserial({ mode: "number" }).primaryKey(),
    /** A note between agents. Never shown to the requester, never sent. */
    internal: boolean().notNull().default(false),
    ticket_id: uuid()
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("support_messages_ticket_idx").on(table.ticket_id, table.created_at),
  ],
);

export const supportEvents = pgTable(
  "support_events",
  {
    actor: varchar({ length: 320 }),
    at: timestamp().notNull().defaultNow(),
    from_value: varchar({ length: 320 }),
    id: bigserial({ mode: "number" }).primaryKey(),
    /** `status`, `priority` or `assignee`. */
    kind: varchar({ length: 20 }).notNull(),
    note: text(),
    ticket_id: uuid()
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    to_value: varchar({ length: 320 }),
  },
  (table) => [index("support_events_ticket_idx").on(table.ticket_id, table.at)],
);

export const supportDrizzleSchema = {
  supportEvents,
  supportMessages,
  supportTickets,
};
