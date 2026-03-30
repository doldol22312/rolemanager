/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { getUniqueUsername, openUserProfile } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
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
    RestAPI,
    ScrollerThin,
    showToast,
    SnowflakeUtils,
    Text,
    TextInput,
    Toasts,
    useEffect,
    useMemo,
    useRef,
    UserStore,
    useState,
    useStateFromStores
} from "@webpack/common";

const cl = classNameFactory("vc-role-manager-");
const countFormat = new Intl.NumberFormat();
const MEMBER_REQUEST_CHUNK_SIZE = 100;
const MEMBER_SEARCH_LIMIT = 1000;

const authors = [
    {
        name: "cones",
        id: 0n
    }
];

const enum MemberSource {
    Cache = "cache",
    RoleMemberIdsApi = "roleMemberIdsApi"
}

const enum RemoteState {
    Idle = "idle",
    Loading = "loading",
    Loaded = "loaded",
    Error = "error"
}

const settings = definePluginSettings({
    memberSource: {
        description: "How to build the member list for a selected role",
        type: OptionType.SELECT,
        options: [
            { label: "Gateway Cache", value: MemberSource.Cache, default: true },
            { label: "Role Member IDs API", value: MemberSource.RoleMemberIdsApi }
        ]
    },
    useMembersSearchApi: {
        description: "When using the API source and searching members, query Discord's Search Guild Members API and intersect the results with the selected role",
        type: OptionType.BOOLEAN,
        default: true
    },
    requestMissingMemberDetails: {
        description: "When the API source returns uncached user ids, request their guild member objects through Discord's gateway",
        type: OptionType.BOOLEAN,
        default: true
    }
});

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

interface RoleApiState {
    status: RemoteState;
    memberIds?: string[];
    error?: string;
}

interface MemberSearchState {
    status: RemoteState;
    memberIds: string[];
    error?: string;
}

function normalize(value: string) {
    return value.trim().toLowerCase();
}

function orderRoles(guildId: string, roles: Role[]) {
    const everyoneRole = roles.find(role => role.id === guildId);
    if (!everyoneRole) return roles;

    return [...roles.filter(role => role.id !== guildId), everyoneRole];
}

function chunk<T>(values: T[], size: number) {
    const chunks: T[][] = [];

    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }

    return chunks;
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;

    const body = (error as any)?.body;
    if (typeof body?.message === "string") return body.message;

    const message = (error as any)?.message;
    if (typeof message === "string") return message;

    return "Unknown error";
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

function requestGuildMembersByIds(guildId: string, userIds: string[]) {
    const nonce = SnowflakeUtils.fromTimestamp(Date.now());

    for (const chunkIds of chunk(userIds, MEMBER_REQUEST_CHUNK_SIZE)) {
        FluxDispatcher.dispatch({
            type: "GUILD_MEMBERS_REQUEST",
            guildIds: [guildId],
            userIds: chunkIds,
            presences: false,
            nonce
        });
    }
}

function getRawUserAvatarUrl(user: any, size = 40) {
    if (!user?.id || !user?.avatar) return null;

    const extension = String(user.avatar).startsWith("a_") ? "gif" : "png";
    return `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/avatars/${user.id}/${user.avatar}.${extension}?size=${size}`;
}

function makeUnknownMemberDetails(id: string): MemberDetails {
    return {
        id,
        displayName: "Unknown User",
        username: id,
        avatarUrl: null,
        roleIds: []
    };
}

function makeMemberDetailsFromStore(guildId: string, memberId: string): MemberDetails | null {
    const member = GuildMemberStore.getMember(guildId, memberId);
    if (!member) return null;

    const user = UserStore.getUser(memberId);
    const avatarUrl = member.avatar
        ? IconUtils.getGuildMemberAvatarURLSimple({
            userId: memberId,
            avatar: member.avatar,
            guildId,
            canAnimate: true
        })
        : user?.getAvatarURL(void 0, 40, true) ?? null;

    return {
        id: memberId,
        displayName: member.nick ?? user?.globalName ?? user?.username ?? user?.tag ?? memberId,
        username: user ? getUniqueUsername(user) : memberId,
        avatarUrl,
        roleIds: member.roles ?? []
    };
}

function makeMemberDetailsFromApi(guildId: string, raw: any): MemberDetails | null {
    const member = raw?.member ?? raw;
    const user = member?.user ?? raw?.user;
    const userId = user?.id ?? member?.user_id ?? member?.userId;
    if (!userId) return null;

    const avatarUrl = member?.avatar
        ? IconUtils.getGuildMemberAvatarURLSimple({
            userId,
            avatar: member.avatar,
            guildId,
            canAnimate: true
        })
        : getRawUserAvatarUrl(user);

    return {
        id: userId,
        displayName: member?.nick ?? user?.global_name ?? user?.globalName ?? user?.username ?? userId,
        username: user?.discriminator === "0" || user?.discriminator == null
            ? user?.username ?? userId
            : `${user.username}#${user.discriminator}`,
        avatarUrl,
        roleIds: member?.roles ?? []
    };
}

function normalizeRoleMemberIdsResponse(response: any): string[] {
    const body = response?.body ?? response;

    if (Array.isArray(body)) {
        return body.filter((entry): entry is string => typeof entry === "string");
    }

    if (Array.isArray(body?.member_ids)) {
        return body.member_ids.filter((entry: unknown): entry is string => typeof entry === "string");
    }

    if (Array.isArray(body?.user_ids)) {
        return body.user_ids.filter((entry: unknown): entry is string => typeof entry === "string");
    }

    return [];
}

function normalizeSearchMembersResponse(guildId: string, response: any): MemberDetails[] {
    const body = response?.body ?? response;
    const entries =
        Array.isArray(body) ? body
            : Array.isArray(body?.members) ? body.members
                : Array.isArray(body?.results) ? body.results
                    : [];

    return entries
        .map((entry: any) => makeMemberDetailsFromApi(guildId, entry))
        .filter((member): member is MemberDetails => member != null);
}

async function fetchRoleMemberIds(guildId: string, roleId: string) {
    const response = await RestAPI.get({
        url: `/guilds/${guildId}/roles/${roleId}/member-ids`,
        oldFormErrors: true,
        retries: 2
    });

    return normalizeRoleMemberIdsResponse(response);
}

async function searchGuildMembers(guildId: string, query: string) {
    const response = await RestAPI.get({
        url: `/guilds/${guildId}/members/search`,
        query: {
            query,
            limit: MEMBER_SEARCH_LIMIT
        },
        oldFormErrors: true,
        retries: 2
    });

    return normalizeSearchMembersResponse(guildId, response);
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
        const memberDetails = makeMemberDetailsFromStore(guild.id, memberId);
        if (!memberDetails) continue;

        membersById.set(memberId, memberDetails);
        roleMembers.get(guild.id)?.push(memberId);

        for (const roleId of memberDetails.roleIds) {
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
    const [roleApiState, setRoleApiState] = useState<Record<string, RoleApiState>>({});
    const [searchState, setSearchState] = useState<MemberSearchState>({
        status: RemoteState.Idle,
        memberIds: []
    });
    const [apiMembersById, setApiMembersById] = useState<Record<string, MemberDetails>>({});

    const requestedMemberDetails = useRef<Set<string>>(new Set());

    const { roles, cachedMemberCount, totalMemberCount, roleMembers, membersById } = useStateFromStores(
        [GuildRoleStore, GuildMemberStore, GuildMemberCountStore, UserStore],
        () => makeStoreSnapshot(guild)
    );

    const usingRoleApi = settings.store.memberSource === MemberSource.RoleMemberIdsApi;

    useEffect(() => {
        requestGuildMembers(guild.id);
    }, [guild.id]);

    useEffect(() => {
        requestedMemberDetails.current.clear();
        setRoleApiState({});
        setSearchState({
            status: RemoteState.Idle,
            memberIds: []
        });
        setApiMembersById({});
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
    const selectedRoleApi = selectedRole ? roleApiState[selectedRole.id] : void 0;
    const cachedSelectedRoleMemberIds = selectedRole ? roleMembers.get(selectedRole.id) ?? [] : [];
    const roleApiSupported = !!selectedRole && selectedRole.id !== guild.id;

    const selectedRoleMemberIds = useMemo(() => {
        if (usingRoleApi && roleApiSupported && selectedRoleApi?.memberIds) {
            return selectedRoleApi.memberIds;
        }

        return cachedSelectedRoleMemberIds;
    }, [cachedSelectedRoleMemberIds, roleApiSupported, selectedRoleApi?.memberIds, usingRoleApi]);

    const mergeApiMembers = (members: MemberDetails[]) => {
        setApiMembersById(previous => {
            const next = { ...previous };

            for (const member of members) {
                next[member.id] = member;
            }

            return next;
        });
    };

    const loadRoleMemberIds = async (roleId: string, force = false) => {
        if (!force) {
            const current = roleApiState[roleId];
            if (current?.status === RemoteState.Loading || current?.status === RemoteState.Loaded) {
                return true;
            }
        }

        setRoleApiState(previous => ({
            ...previous,
            [roleId]: {
                status: RemoteState.Loading,
                memberIds: previous[roleId]?.memberIds ?? []
            }
        }));

        try {
            const memberIds = await fetchRoleMemberIds(guild.id, roleId);

            setRoleApiState(previous => ({
                ...previous,
                [roleId]: {
                    status: RemoteState.Loaded,
                    memberIds
                }
            }));

            return true;
        } catch (error) {
            const message = getErrorMessage(error);

            setRoleApiState(previous => ({
                ...previous,
                [roleId]: {
                    status: RemoteState.Error,
                    memberIds: previous[roleId]?.memberIds ?? [],
                    error: message
                }
            }));

            return false;
        }
    };

    useEffect(() => {
        if (!usingRoleApi || !selectedRole || !roleApiSupported) {
            return;
        }

        void loadRoleMemberIds(selectedRole.id);
    }, [roleApiSupported, selectedRole?.id, usingRoleApi]);

    useEffect(() => {
        if (!usingRoleApi || !settings.store.requestMissingMemberDetails || !selectedRole || !roleApiSupported) {
            return;
        }

        const apiIds = roleApiState[selectedRole.id]?.memberIds;
        if (!apiIds?.length) return;

        const missingIds = apiIds.filter(id =>
            !membersById.has(id)
            && apiMembersById[id] == null
            && !requestedMemberDetails.current.has(id)
        );

        if (!missingIds.length) return;

        for (const missingId of missingIds) {
            requestedMemberDetails.current.add(missingId);
        }

        requestGuildMembersByIds(guild.id, missingIds);
    }, [
        apiMembersById,
        guild.id,
        membersById,
        roleApiState,
        roleApiSupported,
        selectedRole?.id,
        usingRoleApi
    ]);

    const memberQueryValue = memberQuery.trim();
    const shouldUseSearchApi = usingRoleApi
        && roleApiSupported
        && settings.store.useMembersSearchApi
        && memberQueryValue.length > 0
        && !!selectedRoleApi?.memberIds;

    useEffect(() => {
        if (!shouldUseSearchApi) {
            setSearchState({
                status: RemoteState.Idle,
                memberIds: []
            });
            return;
        }

        let cancelled = false;

        const timeout = window.setTimeout(() => {
            setSearchState(previous => ({
                ...previous,
                status: RemoteState.Loading,
                error: void 0
            }));

            void searchGuildMembers(guild.id, memberQueryValue)
                .then(members => {
                    if (cancelled) return;

                    mergeApiMembers(members);

                    const allowedIds = new Set(selectedRoleApi?.memberIds ?? []);
                    const filteredIds = members
                        .map(member => member.id)
                        .filter(id => allowedIds.has(id));

                    setSearchState({
                        status: RemoteState.Loaded,
                        memberIds: filteredIds
                    });
                })
                .catch(error => {
                    if (cancelled) return;

                    setSearchState({
                        status: RemoteState.Error,
                        memberIds: [],
                        error: getErrorMessage(error)
                    });
                });
        }, 250);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [guild.id, memberQueryValue, selectedRoleApi?.memberIds, shouldUseSearchApi]);

    const displayedMemberIds = shouldUseSearchApi && searchState.status === RemoteState.Loaded
        ? searchState.memberIds
        : selectedRoleMemberIds;

    const filteredMembers = useMemo(() => {
        const query = normalize(memberQuery);
        const shouldClientFilter = !(shouldUseSearchApi && searchState.status === RemoteState.Loaded);

        return displayedMemberIds
            .map(memberId => membersById.get(memberId) ?? apiMembersById[memberId] ?? makeUnknownMemberDetails(memberId))
            .filter(member => {
                if (!shouldClientFilter || !query) return true;

                return normalize(member.displayName).includes(query)
                    || normalize(member.username).includes(query)
                    || member.id.includes(query);
            })
            .sort((memberA, memberB) => memberA.displayName.localeCompare(memberB.displayName, void 0, { sensitivity: "base" }));
    }, [apiMembersById, displayedMemberIds, memberQuery, membersById, searchState.status, shouldUseSearchApi]);

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

    const selectedRoleStatus = (() => {
        if (!selectedRole) return "";

        if (!usingRoleApi) {
            return `${countFormat.format(selectedRoleMemberIds.length)} cached members with this role`;
        }

        if (!roleApiSupported) {
            return `${countFormat.format(selectedRoleMemberIds.length)} cached members for @everyone. The role API only applies to explicit roles.`;
        }

        if (selectedRoleApi?.status === RemoteState.Loading) {
            return "Loading role member ids from the API...";
        }

        if (selectedRoleApi?.status === RemoteState.Error) {
            return `Role member API failed: ${selectedRoleApi.error}`;
        }

        if (selectedRoleApi?.status === RemoteState.Loaded) {
            const suffix = shouldUseSearchApi
                ? searchState.status === RemoteState.Loading
                    ? " • searching matching members..."
                    : searchState.status === RemoteState.Error
                        ? ` • member search failed: ${searchState.error}`
                        : searchState.status === RemoteState.Loaded
                            ? ` • ${countFormat.format(searchState.memberIds.length)} members matched your search`
                            : ""
                : "";

            return `${countFormat.format(selectedRoleApi.memberIds?.length ?? 0)} member ids loaded from the role API${suffix}`;
        }

        return "Waiting for the role API to load...";
    })();

    const handleRefresh = () => {
        requestGuildMembers(guild.id);

        if (usingRoleApi && selectedRole && roleApiSupported) {
            void loadRoleMemberIds(selectedRole.id, true)
                .then(success => showToast(
                    success ? "Role member ids refreshed" : "Role member ids refresh failed",
                    success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE
                ))
                .catch(() => { });
            return;
        }

        showToast("Guild members refresh requested", Toasts.Type.SUCCESS);
    };

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
                            View every server role and the members your client can resolve for that role. Source: {usingRoleApi ? "Role Member IDs API" : "Gateway Cache"}.
                        </Forms.FormText>
                        <Forms.FormText className={cl("toolbar-status")}>
                            {cacheStatus}{isFullyCached ? " • cache complete" : " • cache partial"}
                        </Forms.FormText>
                    </div>

                    <Button
                        onClick={handleRefresh}
                        color={Button.Colors.BRAND}
                    >
                        Refresh Data
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
                                            <Forms.FormText>{selectedRoleStatus}</Forms.FormText>
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
                                                {searchState.status === RemoteState.Loading
                                                    ? "Searching members..."
                                                    : usingRoleApi && roleApiSupported && selectedRoleApi?.status === RemoteState.Loaded
                                                        ? memberQueryValue
                                                            ? "No role members matched that search."
                                                            : "The API returned no members for this role."
                                                        : selectedRoleMemberIds.length
                                                            ? "No members match that search."
                                                            : "No members have been loaded for this role yet."}
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
    description: "Browse server roles and see which members have them without needing moderation permissions.",
    authors,
    settings,
    tags: ["guild", "roles", "members"],
    contextMenus: {
        "guild-context": contextMenuPatch,
        "guild-header-popout": contextMenuPatch
    }
});
