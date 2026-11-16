# @absolutejs/support

Support tickets for AbsoluteJS applications, Drizzle-native.

A report becomes a **ticket** with the context it was made in (the page, the
browser, the release, the `@absolutejs/errors` issue and the session replay
recorded with it), then a **conversation** between the person who reported it
and the people answering, with **notes** only agents see. Status, priority and
assignee changes are **events**, so a ticket's history is readable later, and
the desk reports the numbers a support team is judged on.

## Install

```bash
bun add @absolutejs/support
```

Peer: `drizzle-orm` >= 1.0.0-rc.4. Postgres.

## Schema

Three tables, exported as Drizzle definitions; register them in your own schema
so your migrations own them:

```ts
export {
  supportTickets,
  supportMessages,
  supportEvents,
} from "@absolutejs/support";
```

## The desk

```ts
const desk = createSupportDesk({
  db,
  onChange: async (change) => {
    // send the emails and live signals your application wants
  },
});

const ticket = await desk.open({
  subject: "Deploy does nothing",
  body: "I click Deploy and nothing happens.",
  requester: { email, id: user.id, name: user.name },
  context: { url: location.pathname, userAgent: navigator.userAgent },
  replayId, // the session replay recorded with the report
  errorFingerprint, // the @absolutejs/errors issue it is about
  submissionId, // a retried POST returns the same ticket
});

await desk.reply({
  ticketId,
  author: { kind: "agent", id: admin.email },
  body,
});
await desk.reply({
  ticketId,
  author: { kind: "agent", id },
  body,
  internal: true,
});
await desk.setStatus({
  ticketId,
  status: "resolved",
  closeReason: "fixed",
  actor,
});
await desk.setPriority({ ticketId, priority: "high", actor });
await desk.assign({ ticketId, assignee: admin.email, actor });

await desk.list({ status: "active", query: "deploy", limit: 25 });
await desk.list({ requester: { id: user.id } }); // a person's own tickets
await desk.get(ticketId, { forRequester: true }); // no notes, no history
await desk.analytics(30);
```

### The rules

- `open` waits on the agents, `pending` waits on the requester, `resolved` is
  answered (the requester can reopen), `closed` is done.
- An agent's first **public** reply starts the response clock, once; it hands
  the ticket to the requester (`pending`). A note changes nothing but the
  thread, and the requester never sees it.
- A requester's reply hands the ticket back (`open`), reopening a resolved or
  closed one and clearing how it was closed.
- Resolving or closing stamps when, and with a reason, how.
- `analytics` reports medians, not means: one ticket left open for a month
  should not hide that most were answered within the hour.

## Licence

BSL 1.1, changing to Apache 2.0 on the change date in `LICENSE`. Production
use is permitted except offering it as a hosted support or ticketing service.
