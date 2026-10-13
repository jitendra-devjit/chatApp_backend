# Adda — backend

REST API and realtime server for [Adda](https://github.com/jitendra-devjit/chatApp_frontend), a chat app with one-to-one and group conversations.

**Stack:** Node.js, Express 5, MongoDB (Mongoose), Socket.IO, JWT, Cloudinary.

## Run it

Try it with no setup at all. This starts an in-memory database with a few demo users:

```bash
npm install
npm run demo
```

Log in from the frontend with `jitendra@demo.dev` / `demo1234`. Data is gone when the process stops.

To run against your own database, copy `.env.example` to `.env`, fill it in, then:

```bash
npm run server   # restarts on file changes
npm start        # production
```

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Signs login tokens. At least 32 characters in production |
| `CLIENT_URL` | Frontend origin(s) allowed to call the API, comma separated |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Image storage |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | A Cloudflare Realtime TURN key. The server asks Cloudflare for short-lived logins and hands them to the browsers |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Alternative: any TURN server with a fixed login |
| `CALL_MAX_MINUTES`, `CALL_MONTHLY_HOURS` | Optional, default 60 and 150. The limits that keep the TURN relay inside its free allowance, see Calls |
| `PORT` | Defaults to `5000` |

## API

Protected routes need `Authorization: Bearer <token>`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | | Create an account. Body: `fullName`, `email`, `password`, `bio` (optional) |
| POST | `/api/auth/login` | | Returns the user and a token valid for 7 days |
| GET | `/api/auth/check` | yes | The logged in user |
| PUT | `/api/auth/update-profile` | yes | Update `fullName`, `bio`, `profilePic` (base64 image, or `""` to remove it) |
| PUT | `/api/auth/chat-prefs` | yes | Pin, mute or archive a chat: `chatId` plus `pinned`, `muted` or `archived` as true or false |
| GET | `/api/messages/users` | yes | Everyone else, with unread counts and the last message per conversation |
| GET | `/api/messages/:id` | yes | Messages with a user, newest page first. `?limit=` and `?before=<ISO date>` page backwards, `?since=<ISO date>` returns everything from that date |
| GET | `/api/messages/search/:id` | yes | Messages with a user whose text contains `?q=` |
| POST | `/api/messages/send/:id` | yes | Send `text`, `attachments` (see Files) and/or `image` (base64). `replyTo` quotes a message of the same conversation |
| PUT | `/api/messages/mark/:id` | yes | Mark a received message as seen |
| PUT | `/api/messages/:id` | yes | Edit the `text` of your own message, within 15 minutes |
| DELETE | `/api/messages/:id` | yes | Delete your own message for both people |
| PUT | `/api/messages/:id/reaction` | yes | React with one `emoji`. The same emoji again removes it |

### Files

Photos, videos, voice notes and documents do not pass through this server. The browser uploads them straight to Cloudinary:

1. `POST /api/uploads/ticket` with `{ kind }` (`image`, `video`, `audio` or `file`) returns a signed permission: the upload `url` and the `fields` to send with the file.
2. The browser posts the file to that url and gets a receipt from Cloudinary.
3. The message is sent with `attachments: [{ kind, upload: <receipt>, name }]`, at most 10. The server checks the signature of every receipt, so only files that really went to this app's folder are accepted.

| Kind | Formats | Limit |
| --- | --- | --- |
| `image` | png, jpg, jpeg, webp, gif | 10 MB |
| `video` | mp4, webm, mov | 100 MB (the most Cloudinary's free plan takes) |
| `audio` | webm, ogg, mp3, m4a, mp4, wav, aac | 10 MB |
| `file` | pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, zip | 10 MB |

`npm run check:storage` uploads, verifies and deletes a tiny file with the account from `.env`, to prove the setup works.
Cloudinary blocks links to PDF and ZIP files until "Allow delivery of PDF and ZIP files" is switched on under Settings, Security.

### Groups

Every route needs a token and, apart from creating, membership of the group. Outsiders get 404.

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/groups` | My groups with members, unread counts and the last message of each |
| POST | `/api/groups` | Create a group: `name`, `memberIds`, optional `description` and `avatar`. The creator is admin |
| PUT | `/api/groups/:id` | Change `name`, `description` or `avatar` (admins) |
| GET | `/api/groups/:id/messages` | Messages of the group, same paging as one-to-one. Members only see messages sent after they joined |
| POST | `/api/groups/:id/messages` | Send `text` and/or `image`, optional `replyTo` |
| GET | `/api/groups/:id/search` | Messages of the group whose text contains `?q=` |
| PUT | `/api/groups/:id/read` | Mark the group as read |
| POST | `/api/groups/:id/members` | Add `userIds` (admins) |
| DELETE | `/api/groups/:id/members/:userId` | Remove somebody (admins), or leave when it is your own id |
| PUT | `/api/groups/:id/members/:userId` | Set `role` to `admin` or `member` (admins) |

Editing, deleting and reacting use the `/api/messages/:id` routes for group messages too.

Errors always look like `{ "success": false, "message": "..." }` with a matching HTTP status.

### Socket.IO

Connect with `io(url, { auth: { token } })`. A connection without a valid token is refused.

| Event | Direction | Payload |
| --- | --- | --- |
| `getOnlineUsers` | server → client | Array of user ids that are online |
| `newMessage` | server → client | The message, sent to every open tab of the receiver |
| `typing` | client → server | `{ to, isTyping }`, passed on to that user. With `isGroup: true`, `to` is a group |
| `typing` | server → client | `{ from, isTyping }`, plus `groupId` for a group |
| `messagesSeen` | server → client | `{ by }`, the user who just read your messages |
| `messageUpdated` | server → client | A message that was edited, deleted or reacted to |
| `lastSeen` | server → client | `{ userId, lastSeen }` when somebody goes offline |
| `groupUpdated` | server → client | The group, after it was created or changed |
| `groupRead` | server → client | `{ groupId, userId, lastReadAt }` when a member read the group |
| `groupRemoved` | server → client | `{ groupId }` when you left or were removed |
| `call:start` | client → server | `{ to, kind }`, kind is `audio` or `video`. Answered with `{ ok, callId }` or `{ ok: false, reason, message }` (`offline`, `busy`, `in_call`, `rate_limited`, ...) |
| `call:incoming` | server → client | `{ callId, kind, from }`, on every open tab of the person being called |
| `call:accept` | client → server | `{ callId }`, answered with `{ ok }`. The tab that accepts holds the call |
| `call:accepted` | server → client | `{ callId }`, to the caller, who then sends the WebRTC offer |
| `call:decline`, `call:end` | client → server | `{ callId }`. `call:end` with `failed: true` says the two browsers never reached each other |
| `call:signal` | both ways | `{ callId, data }`: offers, answers and ICE candidates, passed to the other person untouched once the call is answered |
| `call:ended` | server → client | `{ callId, reason }`: `declined`, `cancelled`, `missed`, `ended`, `failed`, `limit`, `disconnected` or `answered_elsewhere` |

### Calls

Voice and video calls are one-to-one and peer to peer (WebRTC). The server only rings, relays the signaling above and keeps the state of running calls in memory, so it has to run as a single instance.

- `GET /api/calls/ice` returns the `iceServers` for `RTCPeerConnection`: public STUN servers, plus the TURN server from the environment when one is set. `relay` tells the client whether a TURN server is among them.
- **A TURN server is needed in practice.** STUN alone only connects two people whose networks allow a direct path. Phones on mobile data are usually behind a NAT that does not: the call rings and is answered, but no sound or picture arrives. With TURN the call is relayed.
- A call rings for 35 seconds. Somebody who is offline or on another call is not rung.
- When a call ends the server writes it into the conversation as a message with a `call` field: `{ kind, status, duration }`, status is `completed`, `missed` or `declined`. `senderId` is the caller. Only a missed call counts as unread. These messages cannot be edited, deleted or reacted to.
- A user can start at most 10 calls a minute.
- **Cost guard.** A TURN relay is billed by the gigabyte after a free monthly amount (Cloudflare: 1,000 GB). Three limits keep the app below it: a call ends by itself after `CALL_MAX_MINUTES` (reason `limit`), the browsers send at most 0.9 Mbit/s of video, and once the answered calls of the month add up to `CALL_MONTHLY_HOURS` the server stops handing out the relay until the next month (direct calls keep working). `GET /api/calls/usage` returns `{ hours, limit, exceeded }`. Every answered call counts, relayed or not, so the real usage is lower than the count.

## Security

- Passwords are hashed with bcrypt and never leave the database: the field is excluded from every query by default.
- Sockets are authenticated with the same JWT as the API, so nobody can listen as another user.
- Every input is type-checked before it reaches a query, which blocks NoSQL operator injection.
- Profile and group pictures must be real PNG, JPG, WEBP or GIF images (the file signature is checked) under 3 MB.
- Message files are uploaded with a signed ticket that fixes the folder and the allowed formats, and every upload receipt is verified before it is attached.
- Only the sender can edit or delete a message, and only the two people in a conversation can react or reply to it.
- Group routes answer 404 to anybody who is not a member, and only admins manage members.
- Pictures are deleted from storage when their message, profile or group no longer uses them.
- Login and signup are rate limited per IP, sending messages per user.
- `helmet` headers, CORS restricted to `CLIENT_URL`, and no internal error details in responses.

## Tests

```bash
npm test
```

141 tests run the real app against an in-memory MongoDB: auth, validation, access control, groups, files, search, pagination, realtime delivery, calls and rate limits.
