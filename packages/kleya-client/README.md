# @centerforagenticai/kleya-client

The Kleya client for browsers and product frontends: Feed catch-up by cursor, reconnect, a cache interface and the wire protocol types. It has no runtime dependency.

Status: in progress. Every subpath exists and loads; only `./protocol` has its contents: the ids, conversation refs, cursors, wire types, error codes and limits that the server's turn API speaks. `.` and `./indexeddb` are still empty.

| Subpath | Holds |
|---|---|
| `.` | Feed client |
| `./protocol` | ids, conversation refs, cursors, wire types, error codes |
| `./indexeddb` | IndexedDB cache |

Licence: MIT.
