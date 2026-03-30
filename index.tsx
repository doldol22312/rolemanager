/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { getUniqueUsername, openUserProfile } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Guild, Role } from "@vencord/discord-types";
import {
    Button,
    FluxDispatcher,
    Forms,
    GuildMemberCountStore,
    GuildMemberStore,
    GuildRoleStore,
    IconUtils,
    Menu,
    ScrollerThin,
    SnowflakeUtils,
    Text,
    TextInput,
    useEffect,
    useMemo,
    UserStore,
    useState,
    useStateFromStores
} from "@webpack/common";

const cl = classNameFactory("vc-role-manager-");
const countFormat = new Intl.NumberFormat();

const authors = [
    {
        name: "cones",
        id: 0n
    }
];

interface MemberDetails {
    id: string;
    displayName: string;
    username: string;
    avatarUrl: string | null;
    roleIds: string[];
}

interface StoreSnapshot {
    roles: Role[];
    cachedMemberCount: number;
    totalMemberCount: number | null;
    roleMembers: Map<string, string[]>;
    membersById: Map<string, MemberDetails>;
}

function normalize(value: string) {
    return value.trim().toLowerCase();
}

function orderRoles(guildId: string, roles: Role[]) {
    const everyoneRole = roles.find(role => role.id === guildId);
    if (!everyoneRole) return roles;

    return [...roles.filter(role => role.id !== guildId), everyoneRole];
}

function requestGuildMembers(guildId: string) {
    FluxDispatcher.dispatch({
        type: "GUILD_MEMBERS_REQUEST",
        guildIds: [guildId],
        query: "",
        limit: 0,
        presences: false,
        nonce: SnowflakeUtils.fromTimestamp(Date.now())
    });
}

function makeStoreSnapshot(guild: Guild): StoreSnapshot {
    const roles = orderRoles(guild.id, GuildRoleStore.getSortedRoles(guild.id) ?? []);
    const memberIds = GuildMemberStore.getMemberIds(guild.id) ?? [];
    const roleMembers = new Map<string, string[]>();
    const membersById = new Map<string, MemberDetails>();

    for (const role of roles) {
        roleMembers.set(role.id, []);
    }

    if (!roleMembers.has(guild.id)) {
        roleMembers.set(guild.id, []);
    }

    for (const memberId of memberIds) {
        const member = GuildMemberStore.getMember(guild.id, memberId);
        if (!member) continue;

        const user = UserStore.getUser(memberId);
        const avatarUrl = member.avatar
            ? IconUtils.getGuildMemberAvatarURLSimple({
                userId: memberId,
                avatar: member.avatar,
                guildId: guild.id,
                canAnimate: true
            })
            : user?.getAvatarURL(void 0, 40, true) ?? null;

        const displayName = member.nick ?? user?.globalName ?? user?.username ?? user?.tag ?? memberId;
        const username = user ? getUniqueUsername(user) : memberId;
        const roleIds = member.roles ?? [];

        membersById.set(memberId, {
            id: memberId,
            displayName,
            username,
            avatarUrl,
            roleIds
        });

        roleMembers.get(guild.id)?.push(memberId);

        for (const roleId of roleIds) {
            const members = roleMembers.get(roleId);
            if (members) members.push(memberId);
            else roleMembers.set(roleId, [memberId]);
        }
    }

    return {
        roles,
        cachedMemberCount: memberIds.length,
        totalMemberCount: GuildMemberCountStore.getMemberCount(guild.id) ?? null,
        roleMembers,
        membersById
    };
}

function openRoleManagerModal(guild: Guild) {
    openModal(modalProps => (
        <ErrorBoundary>
            <RoleManagerModal guild={guild} modalProps={modalProps} />
        </ErrorBoundary>
    ));
}

function RoleManagerModal({ guild, modalProps }: { guild: Guild; modalProps: ModalProps; }) {
    const [roleQuery, setRoleQuery] = useState("");
    const [memberQuery, setMemberQuery] = useState("");
    const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

    const { roles, cachedMemberCount, totalMemberCount, roleMembers, membersById } = useStateFromStores(
        [GuildRoleStore, GuildMemberStore, GuildMemberCountStore, UserStore],
        () => makeStoreSnapshot(guild)
    );

    useEffect(() => {
        requestGuildMembers(guild.id);
    }, [guild.id]);

    const filteredRoles = useMemo(() => {
        const query = normalize(roleQuery);
        if (!query) return roles;

        return roles.filter(role => {
            const roleName = role.id === guild.id ? "@everyone" : role.name;
            return normalize(roleName).includes(query);
        });
    }, [guild.id, roleQuery, roles]);

    useEffect(() => {
        if (!filteredRoles.length) {
            setSelectedRoleId(null);
            return;
        }

        if (!selectedRoleId || !filteredRoles.some(role => role.id === selectedRoleId)) {
            setSelectedRoleId(filteredRoles[0].id);
        }
    }, [filteredRoles, selectedRoleId]);

    const selectedRole = roles.find(role => role.id === selectedRoleId) ?? filteredRoles[0] ?? null;
    const selectedRoleMemberIds = selectedRole ? roleMembers.get(selectedRole.id) ?? [] : [];

    const filteredMembers = useMemo(() => {
        const query = normalize(memberQuery);

        return selectedRoleMemberIds
            .map(memberId => membersById.get(memberId))
            .filter((member): member is MemberDetails => member != null)
            .filter(member => {
                if (!query) return true;

                return normalize(member.displayName).includes(query)
                    || normalize(member.username).includes(query)
                    || member.id.includes(query);
            })
            .sort((memberA, memberB) => memberA.displayName.localeCompare(memberB.displayName, void 0, { sensitivity: "base" }));
    }, [memberQuery, membersById, selectedRoleMemberIds]);

    const isFullyCached = totalMemberCount != null && cachedMemberCount >= totalMemberCount;
    const cacheStatus = totalMemberCount == null
        ? `${countFormat.format(cachedMemberCount)} cached members`
        : `${countFormat.format(cachedMemberCount)} / ${countFormat.format(totalMemberCount)} cached members`;

    const selectedRoleFlags = selectedRole
        ? [
            selectedRole.managed && "Managed",
            selectedRole.hoist && "Shown separately",
            selectedRole.mentionable && "Mentionable"
        ].filter(Boolean).join(" • ")
        : "";

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <div className={cl("header-copy")}>
                    <Text variant="heading-lg/semibold">Role Manager</Text>
                    <Forms.FormText>{guild.name}</Forms.FormText>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent className={cl("content")}>
                <div className={cl("toolbar")}>
                    <div className={cl("toolbar-copy")}>
                        <Forms.FormText>
                            View every server role and the members your client has loaded for that role. This does not require moderation permissions,
                            but very large servers can stay partially cached.
                        </Forms.FormText>
                        <Forms.FormText className={cl("toolbar-status")}>
                            {cacheStatus}{isFullyCached ? " • cache complete" : " • requesting more members"}
                        </Forms.FormText>
                    </div>

                    <Button
                        onClick={() => requestGuildMembers(guild.id)}
                        color={Button.Colors.BRAND}
                    >
                        Refresh Members
                    </Button>
                </div>

                <div className={cl("layout")}>
                    <section className={cl("panel")}>
                        <div className={cl("panel-header")}>
                            <Forms.FormTitle tag="h4">Roles</Forms.FormTitle>
                            <Text variant="text-sm/normal">{countFormat.format(filteredRoles.length)}</Text>
                        </div>

                        <TextInput
                            placeholder="Search roles"
                            value={roleQuery}
                            onChange={setRoleQuery}
                            className={cl("search")}
                        />

                        <ScrollerThin className={cl("list")} orientation="auto">
                            {filteredRoles.map(role => {
                                const memberCount = roleMembers.get(role.id)?.length ?? 0;
                                const isSelected = role.id === selectedRole?.id;

                                return (
                                    <button
                                        key={role.id}
                                        type="button"
                                        className={cl("row-button")}
                                        onClick={() => {
                                            setSelectedRoleId(role.id);
                                            setMemberQuery("");
                                        }}
                                    >
                                        <div className={cl("row", { "row-selected": isSelected })}>
                                            <span
                                                className={cl("role-dot")}
                                                style={{ backgroundColor: role.colorString ?? "var(--interactive-normal)" }}
                                            />

                                            <div className={cl("row-copy")}>
                                                <Text variant="text-md/medium">
                                                    {role.id === guild.id ? "@everyone" : role.name}
                                                </Text>
                                                <Text variant="text-xs/normal" className={cl("row-subtitle")}>
                                                    {countFormat.format(memberCount)} cached members
                                                </Text>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}

                            {!filteredRoles.length && (
                                <div className={cl("empty")}>
                                    <Text variant="text-sm/normal">No roles match that search.</Text>
                                </div>
                            )}
                        </ScrollerThin>
                    </section>

                    <section className={cl("panel")}>
                        {!selectedRole && (
                            <div className={cl("empty-state")}>
                                <Text variant="heading-md/semibold">No role selected</Text>
                                <Forms.FormText>Pick a role from the left to see its members.</Forms.FormText>
                            </div>
                        )}

                        {selectedRole && (
                            <>
                                <div className={cl("selected-role")}>
                                    <div className={cl("selected-role-top")}>
                                        <span
                                            className={cl("selected-role-dot")}
                                            style={{ backgroundColor: selectedRole.colorString ?? "var(--interactive-active)" }}
                                        />

                                        <div className={cl("selected-role-copy")}>
                                            <Text variant="heading-md/semibold">
                                                {selectedRole.id === guild.id ? "@everyone" : selectedRole.name}
                                            </Text>
                                            <Forms.FormText>
                                                {countFormat.format(selectedRoleMemberIds.length)} cached members with this role
                                            </Forms.FormText>
                                        </div>
                                    </div>

                                    {selectedRoleFlags && (
                                        <Forms.FormText>{selectedRoleFlags}</Forms.FormText>
                                    )}
                                </div>

                                <TextInput
                                    placeholder="Search members"
                                    value={memberQuery}
                                    onChange={setMemberQuery}
                                    className={cl("search")}
                                />

                                <ScrollerThin className={cl("list")} orientation="auto">
                                    {filteredMembers.map(member => (
                                        <button
                                            key={member.id}
                                            type="button"
                                            className={cl("row-button")}
                                            onClick={() => void openUserProfile(member.id)}
                                        >
                                            <div className={cl("member-row")}>
                                                {member.avatarUrl
                                                    ? (
                                                        <img
                                                            className={cl("avatar")}
                                                            src={member.avatarUrl}
                                                            alt=""
                                                        />
                                                    )
                                                    : (
                                                        <div className={cl("avatar-fallback")} aria-hidden="true" />
                                                    )}

                                                <div className={cl("row-copy")}>
                                                    <Text variant="text-md/medium">{member.displayName}</Text>
                                                    <Text variant="text-xs/normal" className={cl("row-subtitle")}>
                                                        {member.username === member.displayName ? member.id : member.username}
                                                    </Text>
                                                </div>
                                            </div>
                                        </button>
                                    ))}

                                    {!filteredMembers.length && (
                                        <div className={cl("empty")}>
                                            <Text variant="text-sm/normal">
                                                {selectedRoleMemberIds.length
                                                    ? "No cached members match that search."
                                                    : "No cached members have been loaded for this role yet."}
                                            </Text>
                                        </div>
                                    )}
                                </ScrollerThin>
                            </>
                        )}
                    </section>
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

const contextMenuPatch: NavContextMenuPatchCallback = (children, { guild }: { guild: Guild; }) => {
    const item = (
        <Menu.MenuItem
            id="vc-role-manager"
            label="Role Manager"
            action={() => openRoleManagerModal(guild)}
        />
    );

    const group = findGroupChildrenByChildId("privacy", children);
    if (group) {
        group.push(item);
        return;
    }

    children.splice(-1, 0, <Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

export default definePlugin({
    name: "RoleManager",
    description: "Browse server roles and see which loaded members have them without needing moderation permissions.",
    authors,
    tags: ["guild", "roles", "members"],
    contextMenus: {
        "guild-context": contextMenuPatch,
        "guild-header-popout": contextMenuPatch
    }
});
