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
const GUILD_MEMBER_PAGE_LIMIT = 1000;
const MEMBER_SEARCH_LIMIT = 1000;
const MEMBERS_SEARCH_PAGE_LIMIT = 1000;
const MEMBER_ROW_HEIGHT = 56;
const SEARCH_DEBOUNCE_MS = 250;

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

const enum ExplicitRoleMemberSource {
    RoleMemberIds = "roleMemberIds",
    MembersSearch = "membersSearch",
    GuildMembers = "guildMembers"
}

const roleMemberSourceLabels: Record<ExplicitRoleMemberSource, string> = {
    [ExplicitRoleMemberSource.RoleMemberIds]: "Role Member IDs API",
    [ExplicitRoleMemberSource.MembersSearch]: "Experimental members-search role filter",
    [ExplicitRoleMemberSource.GuildMembers]: "Paginated Guild Members API + local role filtering"
};

const settings = definePluginSettings({
    memberSource: {
        description: "How explicit role members should be loaded. The experimental and paginated endpoints are likely to fail for regular users.",
        type: OptionType.SELECT,
        options: [
            { label: roleMemberSourceLabels[ExplicitRoleMemberSource.RoleMemberIds], value: ExplicitRoleMemberSource.RoleMemberIds, default: true },
            { label: roleMemberSourceLabels[ExplicitRoleMemberSource.MembersSearch], value: ExplicitRoleMemberSource.MembersSearch },
            { label: roleMemberSourceLabels[ExplicitRoleMemberSource.GuildMembers], value: ExplicitRoleMemberSource.GuildMembers }
        ] as const
    },
    useMembersSearchApi: {
        description: "When using the Role Member IDs API source, query Discord's Search Guild Members API and intersect the results with the selected role",
        type: OptionType.BOOLEAN,
        default: true
    },
    requestMissingMemberDetails: {
        description: "When the Role Member IDs API returns uncached user ids, request their guild member objects through Discord's gateway",
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
    memberIds: string[];
    error?: string;
    totalResultCount?: number | null;
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
    roleUsesRemoteSource: boolean;
    searchState: MemberSearchState;
    selectedSource: ExplicitRoleMemberSource;
    selectedSourceLabel: string;
    shouldUseRemoteSearch: boolean;
    refreshSelectedRole(): void;
}

interface MemberPaginationFilter {
    user_id: string;
    guild_joined_at: number;
}

interface MembersSearchPage {
    entries: any[];
    members: MemberDetails[];
    pageResultCount: number;
    totalResultCount: number | null;
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

function getRawMemberId(raw: any) {
    const member = raw?.member ?? raw;
    const user = member?.user ?? raw?.user;
    return user?.id ?? member?.user_id ?? member?.userId ?? raw?.user_id ?? null;
}

function getRawMemberJoinedAtMs(raw: any) {
    const member = raw?.member ?? raw;
    const joinedAt = raw?.guild_joined_at ?? member?.joined_at ?? member?.joinedAt;
    if (typeof joinedAt === "number" && Number.isFinite(joinedAt)) return joinedAt;

    if (typeof joinedAt === "string") {
        const parsed = Date.parse(joinedAt);
        if (Number.isFinite(parsed)) return parsed;
    }

    return null;
}

function getMembersSearchPaginationFilter(raw: any): MemberPaginationFilter | null {
    const userId = getRawMemberId(raw);
    const guildJoinedAt = getRawMemberJoinedAtMs(raw);
    if (!userId || guildJoinedAt == null) return null;

    return {
        user_id: userId,
        guild_joined_at: guildJoinedAt
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

function normalizeGuildMembersResponse(guildId: string, response: any): MemberDetails[] {
    const body = response?.body ?? response;
    const entries = Array.isArray(body)
        ? body
        : Array.isArray(body?.members)
            ? body.members
            : [];

    return entries
        .map((entry: any) => makeMemberDetailsFromApi(guildId, entry))
        .filter((member): member is MemberDetails => member != null);
}

function normalizeMembersSearchResponse(guildId: string, response: any): MembersSearchPage {
    const body = response?.body ?? response;

    if ((response?.status ?? response?.statusCode) === 202 || body?.code === 110000) {
        const retryAfter = body?.retry_after;
        throw new Error(
            typeof retryAfter === "number"
                ? `Index not yet available. Retry after ${retryAfter}s.`
                : "Index not yet available. Try again later."
        );
    }

    const entries =
        Array.isArray(body?.members) ? body.members
            : Array.isArray(body?.results) ? body.results
                : Array.isArray(body) ? body
                    : [];

    return {
        entries,
        members: entries
            .map((entry: any) => makeMemberDetailsFromApi(guildId, entry))
            .filter((member): member is MemberDetails => member != null),
        pageResultCount: typeof body?.page_result_count === "number"
            ? body.page_result_count
            : entries.length,
        totalResultCount: typeof body?.total_result_count === "number"
            ? body.total_result_count
            : null
    };
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

async function fetchGuildMembersPage(guildId: string, after?: string) {
    const response = await RestAPI.get({
        url: `/guilds/${guildId}/members`,
        query: {
            limit: GUILD_MEMBER_PAGE_LIMIT,
            ...(after ? { after } : {})
        },
        oldFormErrors: true,
        retries: 2
    });

    return normalizeGuildMembersResponse(guildId, response);
}

async function fetchAllGuildMembers(guildId: string) {
    const membersById = new Map<string, MemberDetails>();
    let after: string | undefined;

    for (;;) {
        const members = await fetchGuildMembersPage(guildId, after);
        if (!members.length) break;

        for (const member of members) {
            membersById.set(member.id, member);
        }

        if (members.length < GUILD_MEMBER_PAGE_LIMIT) break;

        const nextAfter = members[members.length - 1]?.id;
        if (!nextAfter || nextAfter === after) break;

        after = nextAfter;
    }

    return [...membersById.values()];
}

async function fetchMembersSearchPage(guildId: string, roleId: string, memberQuery?: string, after?: MemberPaginationFilter) {
    const response = await RestAPI.post({
        url: `/guilds/${guildId}/members-search`,
        body: {
            limit: MEMBERS_SEARCH_PAGE_LIMIT,
            sort: 1,
            and_query: {
                role_ids: {
                    or_query: [roleId]
                },
                ...(memberQuery
                    ? {
                        usernames: {
                            or_query: [memberQuery]
                        }
                    }
                    : {})
            },
            ...(after ? { after } : {})
        },
        oldFormErrors: true,
        retries: 2
    });

    return normalizeMembersSearchResponse(guildId, response);
}

async function fetchAllMembersSearchMembers(guildId: string, roleId: string, memberQuery?: string) {
    const membersById = new Map<string, MemberDetails>();
    let totalResultCount: number | null = null;
    let after: MemberPaginationFilter | undefined;

    for (;;) {
        const page = await fetchMembersSearchPage(guildId, roleId, memberQuery, after);
        if (!page.members.length) {
            totalResultCount = page.totalResultCount;
            break;
        }

        totalResultCount = page.totalResultCount;

        for (const member of page.members) {
            membersById.set(member.id, member);
        }

        const loadedCount = membersById.size;
        if (page.pageResultCount < MEMBERS_SEARCH_PAGE_LIMIT) break;
        if (totalResultCount != null && loadedCount >= totalResultCount) break;

        const nextAfter = getMembersSearchPaginationFilter(page.entries[page.entries.length - 1]);
        if (!nextAfter) break;

        if (after?.user_id === nextAfter.user_id && after.guild_joined_at === nextAfter.guild_joined_at) {
            break;
        }

        after = nextAfter;
    }

    return {
        members: [...membersById.values()],
        totalResultCount
    };
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
    memberSource: ExplicitRoleMemberSource,
    useMembersSearchApi: boolean,
    requestMissingMemberDetails: boolean
): RoleMemberLookup {
    const [roleMemberIdsState, setRoleMemberIdsState] = useState<Record<string, RoleApiState>>({});
    const [membersSearchState, setMembersSearchState] = useState<Record<string, RoleApiState>>({});
    const [guildMembersState, setGuildMembersState] = useState<RoleApiState>({
        status: RemoteState.Idle,
        memberIds: []
    });
    const [searchState, setSearchState] = useState<MemberSearchState>({
        status: RemoteState.Idle,
        memberIds: []
    });
    const [apiMembersById, setApiMembersById] = useState<Record<string, MemberDetails>>({});

    const requestedMemberDetailsRef = useRef<Set<string>>(new Set());
    const roleMemberIdsStateRef = useRef<Record<string, RoleApiState>>({});
    const membersSearchStateRef = useRef<Record<string, RoleApiState>>({});
    const guildMembersStateRef = useRef<RoleApiState>({
        status: RemoteState.Idle,
        memberIds: []
    });
    const roleMemberIdsRequestTokenRef = useRef(new Map<string, number>());
    const membersSearchRequestTokenRef = useRef(new Map<string, number>());
    const guildMembersRequestTokenRef = useRef(0);
    const searchRequestTokenRef = useRef(0);

    useEffect(() => {
        roleMemberIdsStateRef.current = roleMemberIdsState;
    }, [roleMemberIdsState]);

    useEffect(() => {
        membersSearchStateRef.current = membersSearchState;
    }, [membersSearchState]);

    useEffect(() => {
        guildMembersStateRef.current = guildMembersState;
    }, [guildMembersState]);

    useEffect(() => {
        requestedMemberDetailsRef.current.clear();
        roleMemberIdsStateRef.current = {};
        membersSearchStateRef.current = {};
        guildMembersStateRef.current = {
            status: RemoteState.Idle,
            memberIds: []
        };
        roleMemberIdsRequestTokenRef.current.clear();
        membersSearchRequestTokenRef.current.clear();
        guildMembersRequestTokenRef.current += 1;
        searchRequestTokenRef.current += 1;
        setRoleMemberIdsState({});
        setMembersSearchState({});
        setGuildMembersState({
            status: RemoteState.Idle,
            memberIds: []
        });
        setSearchState({
            status: RemoteState.Idle,
            memberIds: []
        });
        setApiMembersById({});
    }, [guild.id]);

    const roleUsesRemoteSource = effectiveRoleId != null && effectiveRoleId !== guild.id;
    const selectedRoleApi = useMemo(() => {
        if (!effectiveRoleId || !roleUsesRemoteSource) return void 0;

        switch (memberSource) {
            case ExplicitRoleMemberSource.RoleMemberIds:
                return roleMemberIdsState[effectiveRoleId];
            case ExplicitRoleMemberSource.MembersSearch:
                return membersSearchState[effectiveRoleId];
            case ExplicitRoleMemberSource.GuildMembers:
                return guildMembersState;
        }
    }, [effectiveRoleId, guildMembersState, memberSource, membersSearchState, roleMemberIdsState, roleUsesRemoteSource]);

    const cancelRoleMemberIdRequest = useCallback((roleId: string) => {
        roleMemberIdsRequestTokenRef.current.set(roleId, (roleMemberIdsRequestTokenRef.current.get(roleId) ?? 0) + 1);
    }, []);

    const cancelMembersSearchRoleRequest = useCallback((roleId: string) => {
        membersSearchRequestTokenRef.current.set(roleId, (membersSearchRequestTokenRef.current.get(roleId) ?? 0) + 1);
    }, []);

    const cancelGuildMembersRequest = useCallback(() => {
        guildMembersRequestTokenRef.current += 1;
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
            const current = roleMemberIdsStateRef.current[roleId];
            if (current?.status === RemoteState.Loading || current?.status === RemoteState.Loaded) {
                return current?.status === RemoteState.Loaded;
            }
        }

        const requestToken = (roleMemberIdsRequestTokenRef.current.get(roleId) ?? 0) + 1;
        roleMemberIdsRequestTokenRef.current.set(roleId, requestToken);

        setRoleMemberIdsState(previous => ({
            ...previous,
            [roleId]: {
                status: RemoteState.Loading,
                memberIds: previous[roleId]?.memberIds ?? []
            }
        }));

        try {
            const memberIds = await fetchRoleMemberIds(guild.id, roleId);
            if (roleMemberIdsRequestTokenRef.current.get(roleId) !== requestToken) return false;

            setRoleMemberIdsState(previous => ({
                ...previous,
                [roleId]: {
                    status: RemoteState.Loaded,
                    memberIds
                }
            }));

            return true;
        } catch (error) {
            if (roleMemberIdsRequestTokenRef.current.get(roleId) !== requestToken) return false;

            setRoleMemberIdsState(previous => ({
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

    const loadMembersSearchRoleMembers = useCallback(async (roleId: string, force = false) => {
        if (!force) {
            const current = membersSearchStateRef.current[roleId];
            if (current?.status === RemoteState.Loading || current?.status === RemoteState.Loaded) {
                return current?.status === RemoteState.Loaded;
            }
        }

        const requestToken = (membersSearchRequestTokenRef.current.get(roleId) ?? 0) + 1;
        membersSearchRequestTokenRef.current.set(roleId, requestToken);

        setMembersSearchState(previous => ({
            ...previous,
            [roleId]: {
                status: RemoteState.Loading,
                memberIds: previous[roleId]?.memberIds ?? [],
                totalResultCount: previous[roleId]?.totalResultCount ?? null
            }
        }));

        try {
            const result = await fetchAllMembersSearchMembers(guild.id, roleId);
            if (membersSearchRequestTokenRef.current.get(roleId) !== requestToken) return false;

            mergeApiMembers(result.members);

            setMembersSearchState(previous => ({
                ...previous,
                [roleId]: {
                    status: RemoteState.Loaded,
                    memberIds: result.members.map(member => member.id),
                    totalResultCount: result.totalResultCount
                }
            }));

            return true;
        } catch (error) {
            if (membersSearchRequestTokenRef.current.get(roleId) !== requestToken) return false;

            setMembersSearchState(previous => ({
                ...previous,
                [roleId]: {
                    status: RemoteState.Error,
                    memberIds: previous[roleId]?.memberIds ?? [],
                    error: getErrorMessage(error),
                    totalResultCount: previous[roleId]?.totalResultCount ?? null
                }
            }));

            return false;
        }
    }, [guild.id, mergeApiMembers]);

    const loadGuildMembers = useCallback(async (force = false) => {
        if (!force) {
            const { status } = guildMembersStateRef.current;
            if (status === RemoteState.Loading || status === RemoteState.Loaded) {
                return status === RemoteState.Loaded;
            }
        }

        const requestToken = guildMembersRequestTokenRef.current + 1;
        guildMembersRequestTokenRef.current = requestToken;

        setGuildMembersState(previous => ({
            ...previous,
            status: RemoteState.Loading,
            error: void 0
        }));

        try {
            const members = await fetchAllGuildMembers(guild.id);
            if (guildMembersRequestTokenRef.current !== requestToken) return false;

            mergeApiMembers(members);

            setGuildMembersState({
                status: RemoteState.Loaded,
                memberIds: members.map(member => member.id)
            });

            return true;
        } catch (error) {
            if (guildMembersRequestTokenRef.current !== requestToken) return false;

            setGuildMembersState(previous => ({
                status: RemoteState.Error,
                memberIds: previous.memberIds,
                error: getErrorMessage(error)
            }));

            return false;
        }
    }, [guild.id, mergeApiMembers]);

    useEffect(() => {
        if (!effectiveRoleId || !roleUsesRemoteSource) {
            return;
        }

        switch (memberSource) {
            case ExplicitRoleMemberSource.RoleMemberIds:
                void loadRoleMemberIds(effectiveRoleId);

                return () => {
                    cancelRoleMemberIdRequest(effectiveRoleId);
                };
            case ExplicitRoleMemberSource.MembersSearch:
                void loadMembersSearchRoleMembers(effectiveRoleId);

                return () => {
                    cancelMembersSearchRoleRequest(effectiveRoleId);
                };
            case ExplicitRoleMemberSource.GuildMembers:
                void loadGuildMembers();

                return () => {
                    cancelGuildMembersRequest();
                };
        }
    }, [
        cancelGuildMembersRequest,
        cancelMembersSearchRoleRequest,
        cancelRoleMemberIdRequest,
        effectiveRoleId,
        loadGuildMembers,
        loadMembersSearchRoleMembers,
        loadRoleMemberIds,
        memberSource,
        roleUsesRemoteSource
    ]);

    useEffect(() => {
        if (!effectiveRoleId || !roleUsesRemoteSource || !requestMissingMemberDetails || memberSource !== ExplicitRoleMemberSource.RoleMemberIds) {
            return;
        }

        const apiIds = roleMemberIdsState[effectiveRoleId]?.memberIds;
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
        memberSource,
        requestMissingMemberDetails,
        roleMemberIdsState,
        roleUsesRemoteSource
    ]);

    const memberQueryValue = memberQuery.trim();
    const shouldUseRemoteSearch = roleUsesRemoteSource
        && memberQueryValue.length > 0
        && (
            memberSource === ExplicitRoleMemberSource.MembersSearch
            || (
                memberSource === ExplicitRoleMemberSource.RoleMemberIds
                && useMembersSearchApi
                && selectedRoleApi?.status === RemoteState.Loaded
            )
        );

    useEffect(() => {
        if (!effectiveRoleId || !roleUsesRemoteSource || !shouldUseRemoteSearch) {
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

            const searchPromise = memberSource === ExplicitRoleMemberSource.MembersSearch
                ? fetchAllMembersSearchMembers(guild.id, effectiveRoleId, memberQueryValue)
                    .then(result => result.members)
                : searchGuildMembers(guild.id, memberQueryValue);

            void searchPromise
                .then(members => {
                    if (searchRequestTokenRef.current !== requestToken) return;

                    mergeApiMembers(members);

                    setSearchState({
                        status: RemoteState.Loaded,
                        memberIds: memberSource === ExplicitRoleMemberSource.RoleMemberIds
                            ? members
                                .map(member => member.id)
                                .filter(id => new Set(selectedRoleApi?.memberIds ?? []).has(id))
                            : members.map(member => member.id)
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
        }, SEARCH_DEBOUNCE_MS);

        return () => {
            searchRequestTokenRef.current += 1;
            window.clearTimeout(timeout);
        };
    }, [effectiveRoleId, guild.id, memberQueryValue, memberSource, mergeApiMembers, roleUsesRemoteSource, selectedRoleApi?.memberIds, shouldUseRemoteSearch]);

    const guildRoleMemberIds = useMemo(() => {
        if (!effectiveRoleId || !roleUsesRemoteSource || memberSource !== ExplicitRoleMemberSource.GuildMembers) {
            return [];
        }

        return guildMembersState.memberIds.filter(memberId => {
            const member = getResolvedMemberDetails(guild.id, memberId, apiMembersById);
            return member.roleIds.includes(effectiveRoleId);
        });
    }, [apiMembersById, effectiveRoleId, guild.id, guildMembersState.memberIds, memberSource, roleUsesRemoteSource]);

    const effectiveMemberIds = useMemo(() => {
        if (!effectiveRoleId) return [];
        if (!roleUsesRemoteSource) return cachedRoleMemberIds;

        switch (memberSource) {
            case ExplicitRoleMemberSource.RoleMemberIds:
            case ExplicitRoleMemberSource.MembersSearch:
                return selectedRoleApi?.memberIds ?? [];
            case ExplicitRoleMemberSource.GuildMembers:
                return guildRoleMemberIds;
        }
    }, [cachedRoleMemberIds, effectiveRoleId, guildRoleMemberIds, memberSource, roleUsesRemoteSource, selectedRoleApi?.memberIds]);

    const displayedMemberIds = shouldUseRemoteSearch && searchState.status === RemoteState.Loaded
        ? searchState.memberIds
        : effectiveMemberIds;

    const roleStatusText = useMemo(() => {
        if (!effectiveRoleId) return "";

        if (!roleUsesRemoteSource) {
            return `${countFormat.format(displayedMemberIds.length)} cached members for @everyone. Explicit-role source: ${roleMemberSourceLabels[memberSource]}.`;
        }

        const searchSuffix = shouldUseRemoteSearch
            ? searchState.status === RemoteState.Loading
                ? memberSource === ExplicitRoleMemberSource.MembersSearch
                    ? " • searching via experimental members-search..."
                    : " • searching matching members..."
                : searchState.status === RemoteState.Error
                    ? memberSource === ExplicitRoleMemberSource.MembersSearch
                        ? ` • experimental members-search failed: ${searchState.error}`
                        : ` • member search failed: ${searchState.error}`
                    : searchState.status === RemoteState.Loaded
                        ? memberSource === ExplicitRoleMemberSource.MembersSearch
                            ? ` • ${countFormat.format(searchState.memberIds.length)} members matched your search via experimental members-search`
                            : ` • ${countFormat.format(searchState.memberIds.length)} members matched your search`
                        : ""
            : "";

        switch (memberSource) {
            case ExplicitRoleMemberSource.RoleMemberIds:
                if (selectedRoleApi?.status === RemoteState.Loading) {
                    return "Loading role member ids from the API...";
                }

                if (selectedRoleApi?.status === RemoteState.Error) {
                    return `Role Member IDs API failed: ${selectedRoleApi.error}`;
                }

                if (selectedRoleApi?.status === RemoteState.Loaded) {
                    return `${countFormat.format(selectedRoleApi.memberIds.length)} member ids loaded from the role API${searchSuffix}`;
                }

                return "Waiting for the Role Member IDs API to load...";
            case ExplicitRoleMemberSource.MembersSearch:
                if (selectedRoleApi?.status === RemoteState.Loading) {
                    return "Loading members via experimental members-search role filter...";
                }

                if (selectedRoleApi?.status === RemoteState.Error) {
                    return `Experimental members-search failed: ${selectedRoleApi.error}`;
                }

                if (selectedRoleApi?.status === RemoteState.Loaded) {
                    const { totalResultCount, memberIds } = selectedRoleApi;
                    const loadedCount = memberIds.length;
                    const countLabel = totalResultCount != null && totalResultCount > loadedCount
                        ? `${countFormat.format(loadedCount)} / ${countFormat.format(totalResultCount)} members loaded from experimental members-search`
                        : `${countFormat.format(loadedCount)} members loaded from experimental members-search`;

                    return `${countLabel}${searchSuffix}`;
                }

                return "Waiting for experimental members-search to load...";
            case ExplicitRoleMemberSource.GuildMembers:
                if (selectedRoleApi?.status === RemoteState.Loading) {
                    return "Loading paginated guild members API and filtering the selected role locally...";
                }

                if (selectedRoleApi?.status === RemoteState.Error) {
                    return `Paginated guild members API failed: ${selectedRoleApi.error}`;
                }

                if (selectedRoleApi?.status === RemoteState.Loaded) {
                    return `${countFormat.format(effectiveMemberIds.length)} members matched this role from ${countFormat.format(selectedRoleApi.memberIds.length)} paginated guild members`;
                }

                return "Waiting for the paginated guild members API to load...";
        }
    }, [displayedMemberIds.length, effectiveMemberIds.length, effectiveRoleId, memberSource, roleUsesRemoteSource, searchState.error, searchState.memberIds.length, searchState.status, selectedRoleApi?.error, selectedRoleApi?.memberIds, selectedRoleApi?.status, selectedRoleApi?.totalResultCount, shouldUseRemoteSearch]);

    const refreshSelectedRole = useCallback(() => {
        requestGuildMembers(guild.id);

        if (!effectiveRoleId || !roleUsesRemoteSource) {
            showToast("Guild members refresh requested", Toasts.Type.SUCCESS);
            return;
        }

        const refreshPromise = memberSource === ExplicitRoleMemberSource.RoleMemberIds
            ? loadRoleMemberIds(effectiveRoleId, true)
            : memberSource === ExplicitRoleMemberSource.MembersSearch
                ? loadMembersSearchRoleMembers(effectiveRoleId, true)
                : loadGuildMembers(true);

        const successMessage = memberSource === ExplicitRoleMemberSource.RoleMemberIds
            ? "Role member ids refreshed"
            : memberSource === ExplicitRoleMemberSource.MembersSearch
                ? "Experimental members-search data refreshed"
                : "Paginated guild members refreshed";

        const failureMessage = memberSource === ExplicitRoleMemberSource.RoleMemberIds
            ? "Role member ids refresh failed"
            : memberSource === ExplicitRoleMemberSource.MembersSearch
                ? "Experimental members-search refresh failed"
                : "Paginated guild members refresh failed";

        void refreshPromise
            .then(success => showToast(
                success ? successMessage : failureMessage,
                success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE
            ))
            .catch(() => { });
    }, [effectiveRoleId, guild.id, loadGuildMembers, loadMembersSearchRoleMembers, loadRoleMemberIds, memberSource, roleUsesRemoteSource]);

    return {
        apiMembersById,
        displayedMemberIds,
        roleStatusText,
        roleApiState: selectedRoleApi,
        roleUsesRemoteSource,
        searchState,
        selectedSource: memberSource,
        selectedSourceLabel: roleMemberSourceLabels[memberSource],
        shouldUseRemoteSearch,
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

    const { memberSource, useMembersSearchApi, requestMissingMemberDetails } = settings.use(["memberSource", "useMembersSearchApi", "requestMissingMemberDetails"]);
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
        memberSource as ExplicitRoleMemberSource,
        useMembersSearchApi,
        requestMissingMemberDetails
    );

    const filteredMemberIds = useMemo(() => {
        const query = normalize(memberQuery);
        const shouldClientFilter = !(roleLookup.shouldUseRemoteSearch && roleLookup.searchState.status === RemoteState.Loaded);

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
    }, [guild.id, memberQuery, roleLookup.apiMembersById, roleLookup.displayedMemberIds, roleLookup.searchState.status, roleLookup.shouldUseRemoteSearch]);

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

    const sourceStatusText = memberSource === ExplicitRoleMemberSource.MembersSearch
        ? "Experimental. Discord documents this endpoint as requiring Manage Server, and it may return 202 while the search index builds."
        : memberSource === ExplicitRoleMemberSource.GuildMembers
            ? "Experimental. Discord documents this endpoint as not usable by user accounts."
            : useMembersSearchApi
                ? "Member search is using Discord's Search Guild Members API when you type."
                : "Member search is currently filtering locally from the loaded role data.";

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
                            View every server role and the members your client can resolve for that role. Current explicit-role source: {roleLookup.selectedSourceLabel}.
                        </Forms.FormText>
                        <Forms.FormText>{sourceStatusText}</Forms.FormText>
                        <Forms.FormText className={cl("toolbar-status")}>
                            {cacheStatus}{isFullyCached ? " • cache hydrated" : " • cache still hydrating"}
                        </Forms.FormText>
                    </div>

                    <Button
                        onClick={roleLookup.refreshSelectedRole}
                        color={Button.Colors.BRAND}
                        aria-label={`Refresh ${roleLookup.selectedSourceLabel} data and guild member cache`}
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
                                                    : roleLookup.roleUsesRemoteSource && roleLookup.roleApiState?.status === RemoteState.Loaded
                                                        ? memberQuery.trim()
                                                            ? "No role members matched that search."
                                                            : "The selected source returned no members for this role."
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
