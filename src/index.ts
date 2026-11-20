/**
 * Support tickets for AbsoluteJS applications.
 *
 * A report becomes a ticket with the context it was made in (the page, the
 * browser, the release, the error and the session replay recorded with it),
 * then a conversation between the person who reported it and the people
 * answering, with notes only agents see. Status, priority and assignee are
 * events, so a ticket's history is readable, and the desk reports the
 * numbers a support team is judged on.
 */
export {
  createSupportDesk,
  forRequesterMessage,
  forRequesterTicket,
  toSupportMessage,
  toSupportTicket,
  type AnyPgDatabase,
  type CreateSupportDeskOptions,
  type OpenTicketInput,
  type ReplyInput,
  type SupportAttachment,
  type SupportDesk,
  type SupportDiagnostic,
  type SupportEvent,
  type SupportMessage,
  type SupportRecipient,
  type SupportTicket,
  type TicketChange,
  type TicketListQuery,
  type TicketSort,
} from "./desk";
export {
  ATTACHMENT_PURPOSES,
  MESSAGE_AUTHORS,
  MESSAGE_KINDS,
  RETEST_RESULTS,
  supportAttachments,
  supportDiagnostics,
  supportDrizzleSchema,
  supportEvents,
  supportMessages,
  supportRecipients,
  supportTickets,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type AttachmentPurpose,
  type MessageAuthor,
  type MessageKind,
  type MessageMeta,
  type RetestResult,
  type TicketContext,
  type TicketReport,
  type TicketPriority,
  type TicketStatus,
} from "./drizzle";
