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
  integer,
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
  "in-progress",
  "pending",
  "verifying",
  "resolved",
  "closed",
] as const;
/** `open`: waiting on us. `in-progress`: somebody is on it. `pending`:
 *  waiting on the requester. `verifying`: a fix is out, waiting for the
 *  requester to say it works. `resolved`: answered, the requester can
 *  reopen. `closed`: done. */
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

/** What a problem report says: the bug form's own fields, every one
 *  optional. */
export type TicketReport = {
  actual?: string;
  expected?: string;
  /** How often: `always`, `sometimes`, `once`… */
  frequency?: string;
  steps?: string;
};

/** Whether a fix held when it was tried again. */
export const RETEST_RESULTS = ["pending", "pass", "fail"] as const;
export type RetestResult = (typeof RETEST_RESULTS)[number];

export const supportTickets = pgTable(
  "support_tickets",
  {
    /** What the ticket is about in the application (an order, a quote, a
     *  design): its kind and id. */
    about_id: varchar({ length: 255 }),
    about_type: varchar({ length: 40 }),
    agent_unread: boolean().notNull().default(true),
    /** Who is handling it (the application's own id for an agent, or an
     *  email). */
    assignee: varchar({ length: 320 }),
    category: varchar({ length: 40 }).notNull().default("problem"),
    close_reason: varchar({ length: 40 }),
    context: jsonb().$type<TicketContext>().notNull().default({}),
    created_at: timestamp().notNull().defaultNow(),
    /** Removed from every list and read, kept for the record. */
    deleted_at: timestamp(),
    /** What the reporting page captured for the agents (viewport, console
     *  errors…): never shown to the requester. */
    diagnostic_note: text(),
    /** The `@absolutejs/errors` issue the report is about, when known. */
    error_fingerprint: varchar({ length: 128 }),
    /** When an agent first replied (an internal note does not count): what
     *  first-response time is measured to. */
    first_response_at: timestamp(),
    /** The change that fixed it, for the agents (a commit, a release). */
    fix_commit: varchar({ length: 120 }),
    /** What was done about it, as the requester was told. */
    fix_summary: text(),
    fixed_at: timestamp(),
    /** What the requester said when a fix didn't hold. */
    follow_up_notes: text(),
    id: uuid().primaryKey().defaultRandom(),
    /** Between the agents: never shown to the requester. */
    internal_notes: text(),
    /** A short number a person can say out loud ("ticket 1042"). */
    number: bigserial({ mode: "number" }).notNull(),
    priority: varchar({ length: 16 })
      .$type<TicketPriority>()
      .notNull()
      .default("normal"),
    /** The session replay recorded with the report, when there is one. */
    replay_id: varchar({ length: 64 }),
    /** The bug form: expected, actual, steps, how often. */
    report: jsonb().$type<TicketReport>(),
    requester_email: varchar({ length: 320 }).notNull(),
    /** The application's own id for the person, when signed in. */
    requester_id: varchar({ length: 128 }),
    requester_name: varchar({ length: 255 }),
    requester_unread: boolean().notNull().default(false),
    resolved_at: timestamp(),
    /** Whether the fix held when it was tried again. */
    retest: varchar({ length: 10 }).$type<RetestResult>(),
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
    /** Who confirmed the fix, and when. */
    verified_at: timestamp(),
    verified_by: varchar({ length: 320 }),
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

/** What a message is: a reply, an agents' note, a fix sent for the
 *  requester to try, the resolution, or a requester saying a fix didn't
 *  hold. */
export const MESSAGE_KINDS = [
  "reply",
  "note",
  "fix",
  "resolution",
  "reject",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** What a message recorded at the time it was written, beside the
 *  ticket's current state: the fix it carried, how a retest went, who
 *  verified it. */
export type MessageMeta = {
  blocksAcceptance?: boolean;
  fixCommit?: string | null;
  followUpNotes?: string | null;
  retest?: RetestResult | null;
  verifiedBy?: string | null;
};

export const supportMessages = pgTable(
  "support_messages",
  {
    author_id: varchar({ length: 320 }),
    author_kind: varchar({ length: 16 }).$type<MessageAuthor>().notNull(),
    author_name: varchar({ length: 255 }),
    body: text().notNull(),
    created_at: timestamp().notNull().defaultNow(),
    edited_at: timestamp(),
    id: bigserial({ mode: "number" }).primaryKey(),
    /** A note between agents. Never shown to the requester, never sent. */
    internal: boolean().notNull().default(false),
    kind: varchar({ length: 16 })
      .$type<MessageKind>()
      .notNull()
      .default("reply"),
    meta: jsonb().$type<MessageMeta>(),
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

/** Evidence on a ticket: what the requester showed, or the agents' proof
 *  of a fix. The file lives wherever the application stores files; this
 *  is where it is. */
export const ATTACHMENT_PURPOSES = ["report", "fix"] as const;
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];

export const supportAttachments = pgTable(
  "support_attachments",
  {
    created_at: timestamp().notNull().defaultNow(),
    id: uuid().primaryKey().defaultRandom(),
    /** `image`, `video`, `audio`, `file`. */
    kind: varchar({ length: 16 }).notNull(),
    name: varchar({ length: 255 }),
    purpose: varchar({ length: 8 })
      .$type<AttachmentPurpose>()
      .notNull()
      .default("report"),
    size_bytes: integer(),
    ticket_id: uuid()
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    uploaded_by: varchar({ length: 320 }),
    url: text().notNull(),
  },
  (table) => [index("support_attachments_ticket_idx").on(table.ticket_id)],
);

/** A browser's diagnostic capture sent with a report (an
 *  `@absolutejs/diagnostics` support bundle), kept until it expires. */
export const supportDiagnostics = pgTable(
  "support_diagnostics",
  {
    bundle: jsonb().$type<Record<string, unknown>>().notNull(),
    capture_id: varchar({ length: 128 }).notNull(),
    created_at: timestamp().notNull().defaultNow(),
    expires_at: timestamp().notNull(),
    id: uuid().primaryKey().defaultRandom(),
    size_bytes: integer().notNull().default(0),
    ticket_id: uuid()
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("support_diagnostics_capture_idx").on(
      table.ticket_id,
      table.capture_id,
    ),
  ],
);

/** Who hears about a new ticket: everyone listed for `all`, or for its
 *  category. */
export const supportRecipients = pgTable(
  "support_recipients",
  {
    created_at: timestamp().notNull().defaultNow(),
    email: varchar({ length: 320 }).notNull(),
    id: uuid().primaryKey().defaultRandom(),
    /** `all`, or one category. */
    scope: varchar({ length: 40 }).notNull().default("all"),
  },
  (table) => [uniqueIndex("support_recipients_email_idx").on(table.email)],
);

export const supportDrizzleSchema = {
  supportAttachments,
  supportDiagnostics,
  supportEvents,
  supportMessages,
  supportRecipients,
  supportTickets,
};
