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
  toSupportTicket,
  type AnyPgDatabase,
  type CreateSupportDeskOptions,
  type OpenTicketInput,
  type ReplyInput,
  type SupportDesk,
  type SupportEvent,
  type SupportMessage,
  type SupportTicket,
  type TicketChange,
  type TicketListQuery,
} from "./desk";
export {
  MESSAGE_AUTHORS,
  supportDrizzleSchema,
  supportEvents,
  supportMessages,
  supportTickets,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type MessageAuthor,
  type TicketContext,
  type TicketPriority,
  type TicketStatus,
} from "./drizzle";
