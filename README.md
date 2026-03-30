# RoleManager

A Vencord custom plugin that adds a `Role Manager` entry to a server's context menu so you can:

- see every role in the server
- inspect which members have a selected role
- request more guild members without needing moderation permissions
- switch between multiple explicit-role member sources

## Install

Place this folder in your Vencord checkout as:

```text
src/userplugins/roleManager/
```

Then rebuild Vencord.

## Use

Right-click a server icon, or open the server header popout, then click `Role Manager`.

In plugin settings you can choose the explicit-role member source:

- `Role Member IDs API`
- `Experimental members-search role filter`
- `Paginated Guild Members API + local role filtering`

You can also control:

- whether member search should use Discord's guild member search API
- whether missing member details should be requested through the gateway so names and avatars resolve

## Limitation

Discord still does not expose one reliable, unlimited member listing route for regular users. The Role Member IDs endpoint is capped at 100 IDs, and the other two source modes are experimental because Discord documents them as privileged or unavailable for user accounts. Missing names and avatars may still depend on cache hydration.
