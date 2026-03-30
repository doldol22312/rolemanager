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
    ListScrollerThin,
    Menu,
    RestAPI,
    ScrollerThin,
    showToast,
    SnowflakeUtils,
    Text,
    TextInput,
    Toasts,
    useCallback,
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
const MEMBER_ROW_HEIGHT = 56;

const authors = [
    {
        name: "cones",
        id: 0n
    }
];

const enum RemoteState {
    Idle = "idle",
    Loading = "loading",
    Loaded = "loaded",
    Error = "error"
}

const settings = definePluginSettings({
    useMembersSearchApi: {
        description: "When searching members, query Discord's Search Guild Members API and intersect the results with the selected role",
        type: OptionType.BOOLEAN,
        default: true
    },
    requestMissingMemberDetails: {
        description: "When the API returns uncached user ids, request their guild member objects through Discord's gateway",
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

interface RoleCatalog {
    roles: Role[];
    cachedMemberCount: number;
    totalMemberCount: number | null;
    cachedRoleMembers: Map<string, string[]>;
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

interface RoleMemberLookup {
    apiMembersById: Record<string, MemberDetails>;
    displayedMemberIds: string[];
    roleStatusText: string;
    roleApiState?: RoleApiState;
    roleUsesMemberIdsApi: boolean;
    searchState: MemberSearchState;
    shouldUseSearchApi: boolean;
    refreshSelectedRole(): void;
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

function getResolvedMemberDetails(guildId: string, memberId: string, apiMembersById: Record<string, MemberDetails>) {
    return makeMemberDetailsFromStore(guildId, memberId) ?? apiMembersById[memberId] ?? makeUnknownMemberDetails(memberId);
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

function buildCachedRoleMembers(guildId: string, roles: Role[]) {
    const memberIds = GuildMemberStore.getMemberIds(guildId) ?? [];
    const cachedRoleMembers = new Map<string, string[]>();

    for (const role of roles) {
        cachedRoleMembers.set(role.id, []);
    }

    if (!cachedRoleMembers.has(guildId)) {
        cachedRoleMembers.set(guildId, []);
    }

    for (const memberId of memberIds) {
        const member = GuildMemberStore.getMember(guildId, memberId);
        if (!member) continue;

        cachedRoleMembers.get(guildId)?.push(memberId);

        for (const roleId of member.roles ?? []) {
            const members = cachedRoleMembers.get(roleId);
            if (members) members.push(memberId);
            else cachedRoleMembers.set(roleId, [memberId]);
        }
    }

    return {
        cachedMemberCount: memberIds.length,
        cachedRoleMembers
    };
}

function useRoleCatalog(guild: Guild): RoleCatalog {
    return useStateFromStores(
        [GuildRoleStore, GuildMemberStore, GuildMemberCountStore],
        () => {
            const roles = orderRoles(guild.id, GuildRoleStore.getSortedRoles(guild.id) ?? []);
            const { cachedMemberCount, cachedRoleMembers } = buildCachedRoleMembers(guild.id, roles);

            return {
                roles,
                cachedMemberCount,
                totalMemberCount: GuildMemberCountStore.getMemberCount(guild.id) ?? null,
                cachedRoleMembers
            };
        }
    );
}

function useRoleMemberLookup(
    guild: Guild,
    effectiveRoleId: string | null,
    cachedRoleMemberIds: string[],
    memberQuery: string,
    useMembersSearchApi: boolean,
    requestMissingMemberDetails: boolean
): RoleMemberLookup {
    const [roleApiState, setRoleApiState] = useState<Record<string, RoleApiState>>({});
    const [searchState, setSearchState] = useState<MemberSearchState>({
        status: RemoteState.Idle,
        memberIds: []
    });
    const [apiMembersById, setApiMembersById] = useState<Record<string, MemberDetails>>({});

    const requestedMemberDetailsRef = useRef<Set<string>>(new Set());
    const roleApiStateRef = useRef<Record<string, RoleApiState>>({});
    const roleRequestTokenRef = useRef(new Map<string, number>());
    const searchRequestTokenRef = useRef(0);

    useEffect(() => {
        roleApiStateRef.current = roleApiState;
    }, [roleApiState]);

    useEffect(() => {
        requestedMemberDetailsRef.current.clear();
        roleApiStateRef.current = {};
        roleRequestTokenRef.current.clear();
        searchRequestTokenRef.current += 1;
        setRoleApiState({});
        setSearchState({
            status: RemoteState.Idle,
            memberIds: []
        });
        setApiMembersById({});
    }, [guild.id]);

    const roleUsesMemberIdsApi = effectiveRoleId != null && effectiveRoleId !== guild.id;
    const selectedRoleApi = effectiveRoleId ? roleApiState[effectiveRoleId] : void 0;

    const cancelRoleMemberIdRequest = useCallback((roleId: string) => {
        roleRequestTokenRef.current.set(roleId, (roleRequestTokenRef.current.get(roleId) ?? 0) + 1);
    }, []);

    const mergeApiMembers = useCallback((members: MemberDetails[]) => {
        setApiMembersById(previous => {
            const next = { ...previous };

            for (const member of members) {
                next[member.id] = member;
            }

            return next;
        });
    }, []);

    const loadRoleMemberIds = useCallback(async (roleId: string, force = false) => {
        if (!force) {
            const current = roleApiStateRef.current[roleId];
            if (current?.status === RemoteState.Loading || current?.status === RemoteState.Loaded) {
                return current?.status === RemoteState.Loaded;
            }
        }

        const requestToken = (roleRequestTokenRef.current.get(roleId) ?? 0) + 1;
        roleRequestTokenRef.current.set(roleId, requestToken);

        setRoleApiState(previous => ({
            ...previous,
            [roleId]: {
                status: RemoteState.Loading,
                memberIds: previous[roleId]?.memberIds ?? []
            }
        }));

        try {
            const memberIds = await fetchRoleMemberIds(guild.id, roleId);
            if (roleRequestTokenRef.current.get(roleId) !== requestToken) return false;

            setRoleApiState(previous => ({
                ...previous,
                [roleId]: {
                    status: RemoteState.Loaded,
                    memberIds
                }
            }));

            return true;
        } catch (error) {
            if (roleRequestTokenRef.current.get(roleId) !== requestToken) return false;

            setRoleApiState(previous => ({
                ...previous,
                [roleId]: {
                    status: RemoteState.Error,
                    memberIds: previous[roleId]?.memberIds ?? [],
                    error: getErrorMessage(error)
                }
            }));

            return false;
        }
    }, [guild.id]);

    useEffect(() => {
        if (!effectiveRoleId || !roleUsesMemberIdsApi) {
            return;
        }

        void loadRoleMemberIds(effectiveRoleId);

        return () => {
            cancelRoleMemberIdRequest(effectiveRoleId);
        };
    }, [cancelRoleMemberIdRequest, effectiveRoleId, loadRoleMemberIds, roleUsesMemberIdsApi]);

    useEffect(() => {
        if (!effectiveRoleId || !roleUsesMemberIdsApi || !requestMissingMemberDetails) {
            return;
        }

        const apiIds = roleApiState[effectiveRoleId]?.memberIds;
        if (!apiIds?.length) return;

        const missingIds = apiIds.filter(id =>
            GuildMemberStore.getMember(guild.id, id) == null
            && apiMembersById[id] == null
            && !requestedMemberDetailsRef.current.has(id)
        );

        if (!missingIds.length) return;

        for (const missingId of missingIds) {
            requestedMemberDetailsRef.current.add(missingId);
        }

        requestGuildMembersByIds(guild.id, missingIds);
    }, [
        apiMembersById,
        effectiveRoleId,
        guild.id,
        requestMissingMemberDetails,
        roleApiState,
        roleUsesMemberIdsApi
    ]);

    const memberQueryValue = memberQuery.trim();
    const shouldUseSearchApi = roleUsesMemberIdsApi
        && useMembersSearchApi
        && memberQueryValue.length > 0
        && !!selectedRoleApi?.memberIds;

    useEffect(() => {
        if (!shouldUseSearchApi) {
            searchRequestTokenRef.current += 1;
            setSearchState({
                status: RemoteState.Idle,
                memberIds: []
            });
            return;
        }

        const requestToken = searchRequestTokenRef.current + 1;
        searchRequestTokenRef.current = requestToken;

        const timeout = window.setTimeout(() => {
            setSearchState(previous => ({
                ...previous,
                status: RemoteState.Loading,
                error: void 0
            }));

            void searchGuildMembers(guild.id, memberQueryValue)
                .then(members => {
                    if (searchRequestTokenRef.current !== requestToken) return;

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
                    if (searchRequestTokenRef.current !== requestToken) return;

                    setSearchState({
                        status: RemoteState.Error,
                        memberIds: [],
                        error: getErrorMessage(error)
                    });
                });
        }, 250);

        return () => {
            searchRequestTokenRef.current += 1;
            window.clearTimeout(timeout);
        };
    }, [guild.id, memberQueryValue, mergeApiMembers, selectedRoleApi?.memberIds, shouldUseSearchApi]);

    const effectiveMemberIds = roleUsesMemberIdsApi && selectedRoleApi?.memberIds
        ? selectedRoleApi.memberIds
        : cachedRoleMemberIds;

    const displayedMemberIds = shouldUseSearchApi && searchState.status === RemoteState.Loaded
        ? searchState.memberIds
        : effectiveMemberIds;

    const roleStatusText = useMemo(() => {
        if (!effectiveRoleId) return "";

        if (!roleUsesMemberIdsApi) {
            return `${countFormat.format(displayedMemberIds.length)} cached members for @everyone. The role API only applies to explicit roles.`;
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
    }, [displayedMemberIds.length, effectiveRoleId, roleUsesMemberIdsApi, searchState.error, searchState.memberIds.length, searchState.status, selectedRoleApi?.error, selectedRoleApi?.memberIds, selectedRoleApi?.status, shouldUseSearchApi]);

    const refreshSelectedRole = useCallback(() => {
        requestGuildMembers(guild.id);

        if (!effectiveRoleId || !roleUsesMemberIdsApi) {
            showToast("Guild members refresh requested", Toasts.Type.SUCCESS);
            return;
        }

        void loadRoleMemberIds(effectiveRoleId, true)
            .then(success => showToast(
                success ? "Role member ids refreshed" : "Role member ids refresh failed",
                success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE
            ))
            .catch(() => { });
    }, [effectiveRoleId, guild.id, loadRoleMemberIds, roleUsesMemberIdsApi]);

    return {
        apiMembersById,
        displayedMemberIds,
        roleStatusText,
        roleApiState: selectedRoleApi,
        roleUsesMemberIdsApi,
        searchState,
        shouldUseSearchApi,
        refreshSelectedRole
    };
}

function RoleList({
    effectiveRoleId,
    guildId,
    onRoleSelect,
    roles,
    roleMembers
}: {
    effectiveRoleId: string | null;
    guildId: string;
    onRoleSelect(roleId: string): void;
    roles: Role[];
    roleMembers: Map<string, string[]>;
}) {
    return (
        <ScrollerThin className={cl("list")} orientation="auto">
            {roles.map(role => {
                const memberCount = roleMembers.get(role.id)?.length ?? 0;
                const isSelected = role.id === effectiveRoleId;
                const roleLabel = role.id === guildId ? "@everyone" : role.name;

                return (
                    <button
                        key={role.id}
                        type="button"
                        className={cl("row-button")}
                        onClick={() => onRoleSelect(role.id)}
                        aria-label={`Select role ${roleLabel}`}
                    >
                        <div className={cl("row", { "row-selected": isSelected })}>
                            <span
                                className={cl("role-dot")}
                                style={{ backgroundColor: role.colorString ?? "var(--interactive-normal)" }}
                            />

                            <div className={cl("row-copy")}>
                                <Text variant="text-md/medium">{roleLabel}</Text>
                                <Text variant="text-xs/normal" className={cl("row-subtitle")}>
                                    {countFormat.format(memberCount)} cached members
                                </Text>
                            </div>
                        </div>
                    </button>
                );
            })}
        </ScrollerThin>
    );
}

function MemberRow({
    apiMembersById,
    guildId,
    memberId
}: {
    apiMembersById: Record<string, MemberDetails>;
    guildId: string;
    memberId: string;
}) {
    const member = useStateFromStores(
        [GuildMemberStore, UserStore],
        () => getResolvedMemberDetails(guildId, memberId, apiMembersById)
    );

    return (
        <button
            type="button"
            className={cl("row-button")}
            onClick={() => void openUserProfile(member.id)}
            aria-label={`Open profile for ${member.displayName}`}
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
    );
}

function MemberVirtualList({
    apiMembersById,
    guildId,
    memberIds,
    roleLabel
}: {
    apiMembersById: Record<string, MemberDetails>;
    guildId: string;
    memberIds: string[];
    roleLabel: string;
}) {
    return (
        <ListScrollerThin
            className={cl("list")}
            sections={[memberIds.length]}
            sectionHeight={0}
            rowHeight={MEMBER_ROW_HEIGHT}
            renderSection={() => null}
            renderRow={({ row }) => (
                <MemberRow
                    key={memberIds[row]}
                    apiMembersById={apiMembersById}
                    guildId={guildId}
                    memberId={memberIds[row]}
                />
            )}
            paddingBottom={8}
            innerRole="list"
            innerAriaLabel={`Members with role ${roleLabel}`}
        />
    );
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

    const { useMembersSearchApi, requestMissingMemberDetails } = settings.use(["useMembersSearchApi", "requestMissingMemberDetails"]);
    const { roles, cachedMemberCount, totalMemberCount, cachedRoleMembers } = useRoleCatalog(guild);

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

    const effectiveRoleId = useMemo(() => {
        if (selectedRoleId && filteredRoles.some(role => role.id === selectedRoleId)) {
            return selectedRoleId;
        }

        return filteredRoles[0]?.id ?? null;
    }, [filteredRoles, selectedRoleId]);

    const selectedRole = useMemo(
        () => roles.find(role => role.id === effectiveRoleId) ?? null,
        [effectiveRoleId, roles]
    );

    const cachedSelectedRoleMemberIds = selectedRole
        ? cachedRoleMembers.get(selectedRole.id) ?? []
        : [];

    const roleLookup = useRoleMemberLookup(
        guild,
        effectiveRoleId,
        cachedSelectedRoleMemberIds,
        memberQuery,
        useMembersSearchApi,
        requestMissingMemberDetails
    );

    const filteredMemberIds = useMemo(() => {
        const query = normalize(memberQuery);
        const shouldClientFilter = !(roleLookup.shouldUseSearchApi && roleLookup.searchState.status === RemoteState.Loaded);

        const memberIds = shouldClientFilter && query
            ? roleLookup.displayedMemberIds.filter(memberId => {
                const member = getResolvedMemberDetails(guild.id, memberId, roleLookup.apiMembersById);

                return normalize(member.displayName).includes(query)
                    || normalize(member.username).includes(query)
                    || member.id.includes(query);
            })
            : roleLookup.displayedMemberIds;

        return [...memberIds].sort((memberAId, memberBId) => {
            const memberA = getResolvedMemberDetails(guild.id, memberAId, roleLookup.apiMembersById);
            const memberB = getResolvedMemberDetails(guild.id, memberBId, roleLookup.apiMembersById);
            return memberA.displayName.localeCompare(memberB.displayName, void 0, { sensitivity: "base" });
        });
    }, [guild.id, memberQuery, roleLookup.apiMembersById, roleLookup.displayedMemberIds, roleLookup.searchState.status, roleLookup.shouldUseSearchApi]);

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

    const roleLabel = selectedRole
        ? selectedRole.id === guild.id
            ? "@everyone"
            : selectedRole.name
        : "selected role";

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
                            View every server role and the members your client can resolve for that role using Discord's role member ids API.
                        </Forms.FormText>
                        <Forms.FormText className={cl("toolbar-status")}>
                            {cacheStatus}{isFullyCached ? " • cache hydrated" : " • cache still hydrating"}
                        </Forms.FormText>
                    </div>

                    <Button
                        onClick={roleLookup.refreshSelectedRole}
                        color={Button.Colors.BRAND}
                        aria-label="Refresh role member ids and guild member cache"
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
                            aria-label="Search roles"
                        />

                        {filteredRoles.length
                            ? (
                                <RoleList
                                    effectiveRoleId={effectiveRoleId}
                                    guildId={guild.id}
                                    onRoleSelect={roleId => {
                                        setSelectedRoleId(roleId);
                                        setMemberQuery("");
                                    }}
                                    roles={filteredRoles}
                                    roleMembers={cachedRoleMembers}
                                />
                            )
                            : (
                                <div className={cl("empty")}>
                                    <Text variant="text-sm/normal">No roles match that search.</Text>
                                </div>
                            )}
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
                                            <Text variant="heading-md/semibold">{roleLabel}</Text>
                                            <Forms.FormText>{roleLookup.roleStatusText}</Forms.FormText>
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
                                    aria-label={`Search members in ${roleLabel}`}
                                />

                                {filteredMemberIds.length
                                    ? (
                                        <MemberVirtualList
                                            apiMembersById={roleLookup.apiMembersById}
                                            guildId={guild.id}
                                            memberIds={filteredMemberIds}
                                            roleLabel={roleLabel}
                                        />
                                    )
                                    : (
                                        <div className={cl("empty")}>
                                            <Text variant="text-sm/normal">
                                                {roleLookup.searchState.status === RemoteState.Loading
                                                    ? "Searching members..."
                                                    : roleLookup.roleUsesMemberIdsApi && roleLookup.roleApiState?.status === RemoteState.Loaded
                                                        ? memberQuery.trim()
                                                            ? "No role members matched that search."
                                                            : "The API returned no members for this role."
                                                        : roleLookup.displayedMemberIds.length
                                                            ? "No members match that search."
                                                            : "No members have been loaded for this role yet."}
                                            </Text>
                                        </div>
                                    )}
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
