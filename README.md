# RoleManager

A Vencord custom plugin that adds a `Role Manager` entry to a server's context menu so you can:

- see every role in the server
- inspect which members have a selected role
- request more guild members without needing moderation permissions
- use Discord's role member ids API instead of relying on a cache-only mode

## Install

Place this folder in your Vencord checkout as:

```text
src/userplugins/roleManager/
```

Then rebuild Vencord.

## Use

Right-click a server icon, or open the server header popout, then click `Role Manager`.

The plugin now always uses the role member ids API for explicit roles. In plugin settings you can still control:

- whether member search should use Discord's guild member search API
- whether missing member details should be requested through the gateway so names and avatars resolve

## Current Limitations

- Explicit roles use Discord's `GET /guilds/{guild.id}/roles/{role.id}/member-ids` endpoint.
- Discord caps that endpoint at 100 member IDs, so roles with more than 100 members will be truncated.
- The default `@everyone` role still uses the local guild member cache instead of the role member IDs endpoint.
- Missing names and avatars still depend on gateway hydration, so some users can remain partially unresolved until the client cache fills in.
- Member search only works against the members the plugin has already loaded for the selected role.
