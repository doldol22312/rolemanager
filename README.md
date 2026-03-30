# RoleManager

A Vencord custom plugin that adds a `Role Manager` entry to a server's context menu so you can:

- see every role in the server
- inspect which loaded members have a selected role
- request more guild members without needing moderation permissions
- optionally use Discord's role member ids API instead of only the local member cache

## Install

Place this folder in your Vencord checkout as:

```text
src/userplugins/roleManager/
```

Then rebuild Vencord.

## Use

Right-click a server icon, or open the server header popout, then click `Role Manager`.

In the plugin settings you can switch the member source between:

- `Gateway Cache`: uses the members your client has already loaded
- `Role Member IDs API`: fetches member ids for the selected role and can also use Discord's guild member search API when you type in the member search box

## Limitation

Discord still does not expose every member object up front. Even with the API-backed option, the plugin may need to request extra member details and some very large servers can still stay partially resolved for names and avatars.
