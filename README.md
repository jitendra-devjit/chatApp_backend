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
| POST | `/api/messages/send/:id` | yes | Send `text` and/or `image` (base64). `replyTo` quotes a message of the same conversation |
| PUT | `/api/messages/mark/:id` | yes | Mark a received message as seen |
| PUT | `/api/messages/:id` | yes | Edit the `text` of your own message, within 15 minutes |
| DELETE | `/api/messages/:id` | yes | Delete your own message for both people |
| PUT | `/api/messages/:id/reaction` | yes | React with one `emoji`. The same emoji again removes it |

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

## Security

- Passwords are hashed with bcrypt and never leave the database: the field is excluded from every query by default.
- Sockets are authenticated with the same JWT as the API, so nobody can listen as another user.
- Every input is type-checked before it reaches a query, which blocks NoSQL operator injection.
- Uploads must be real PNG, JPG, WEBP or GIF images (the file signature is checked) under 3 MB.
- Only the sender can edit or delete a message, and only the two people in a conversation can react or reply to it.
- Group routes answer 404 to anybody who is not a member, and only admins manage members.
- Pictures are deleted from storage when their message, profile or group no longer uses them.
- Login and signup are rate limited per IP, sending messages per user.
- `helmet` headers, CORS restricted to `CLIENT_URL`, and no internal error details in responses.

## Tests

```bash
npm test
```

107 tests run the real app against an in-memory MongoDB: auth, validation, access control, groups, search, pagination, realtime delivery and rate limits.
