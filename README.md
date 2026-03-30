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

## Limitation

Discord still does not expose every member object up front. The plugin may need to request extra member details, and some very large servers can still stay partially resolved for names and avatars while the cache hydrates.
