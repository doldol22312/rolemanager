# RoleManager

A Vencord custom plugin that adds a `Role Manager` entry to a server's context menu so you can:

- see every role in the server
- inspect which loaded members have a selected role
- request more guild members without needing moderation permissions

## Install

Place this folder in your Vencord checkout as:

```text
src/userplugins/roleManager/
```

Then rebuild Vencord.

## Use

Right-click a server icon, or open the server header popout, then click `Role Manager`.

## Limitation

Discord only exposes the members your client can currently cache. The plugin automatically requests more guild members and includes a `Refresh Members` button, but very large servers can still remain partial. That means role counts and member lists are best-effort unless the cache is fully loaded.
