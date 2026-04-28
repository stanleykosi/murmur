/**
 * Unit tests for the Clerk user-sync service.
 *
 * These tests focus on the pure normalization rules plus the delete flow that
 * detaches room ownership before removing a local user row.
 */

import type { UserJSON } from "@clerk/backend";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const findUserByClerkIdMock = vi.fn();
const findActiveRoomListenersMock = vi.fn();
const insertValuesMock = vi.fn();
const insertOnConflictDoUpdateMock = vi.fn();
const insertReturningMock = vi.fn();
const redisSaddMock = vi.fn();
const redisSremMock = vi.fn();
const transactionUpdateWhereMock = vi.fn();
const transactionUpdateSetMock = vi.fn(() => ({
  where: transactionUpdateWhereMock,
}));
const transactionUpdateMock = vi.fn(() => ({
  set: transactionUpdateSetMock,
}));
const transactionDeleteWhereMock = vi.fn();
const transactionDeleteMock = vi.fn(() => ({
  where: transactionDeleteWhereMock,
}));
const transactionMock = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    query: {
      roomListeners: {
        findMany: findActiveRoomListenersMock,
      },
      users: {
        findFirst: findUserByClerkIdMock,
      },
    },
    insert: vi.fn(() => ({
      values: insertValuesMock,
    })),
    transaction: transactionMock,
  },
}));

vi.mock("../lib/redis.js", () => ({
  redis: {
    sadd: redisSaddMock,
    srem: redisSremMock,
  },
}));

type AuthServiceModule = typeof import("./auth.service.js");

let authServiceModule: AuthServiceModule;

/**
 * Creates a representative Clerk user payload for normalization tests.
 *
 * Only the fields used by Murmur's normalization logic are populated here.
 *
 * @param overrides - Partial overrides for the fixture.
 * @returns A Clerk-like user payload fixture.
 */
function createClerkUserFixture(
  overrides: Partial<UserJSON> = {},
): UserJSON {
  return {
    backup_code_enabled: false,
    banned: false,
    created_at: 0,
    delete_self_enabled: false,
    email_addresses: [
      {
        email_address: "primary@example.com",
        id: "email_primary",
      },
      {
        email_address: "secondary@example.com",
        id: "email_secondary",
      },
    ],
    external_accounts: [],
    external_id: null,
    first_name: "Nova",
    has_image: true,
    id: "user_123",
    image_url: "https://img.example.com/nova.png",
    last_active_at: null,
    last_name: "Prime",
    last_sign_in_at: null,
    lockout_expires_in_seconds: null,
    locked: false,
    object: "user",
    organization_memberships: null,
    password_enabled: true,
    password_last_updated_at: null,
    phone_numbers: [],
    primary_email_address_id: "email_primary",
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    private_metadata: {},
    profile_image_url: "https://img.example.com/nova-profile.png",
    public_metadata: {},
    saml_accounts: [],
    two_factor_enabled: false,
    unsafe_metadata: {},
    updated_at: 0,
    username: "nova-prime",
    verification_attempts_remaining: null,
    web3_wallets: [],
    ...overrides,
  } as unknown as UserJSON;
}

beforeAll(async () => {
  vi.resetModules();
  authServiceModule = await import("./auth.service.js");
});

beforeEach(() => {
  findUserByClerkIdMock.mockReset();
  findActiveRoomListenersMock.mockReset();
  insertOnConflictDoUpdateMock.mockReset();
  insertOnConflictDoUpdateMock.mockImplementation(() => ({
    returning: insertReturningMock,
  }));
  insertReturningMock.mockReset();
  insertValuesMock.mockReset();
  insertValuesMock.mockImplementation(() => ({
    onConflictDoUpdate: insertOnConflictDoUpdateMock,
  }));
  redisSaddMock.mockReset();
  redisSremMock.mockReset();
  transactionDeleteMock.mockReset();
  transactionDeleteMock.mockImplementation(() => ({
    where: transactionDeleteWhereMock,
  }));
  transactionDeleteWhereMock.mockReset();
  transactionMock.mockReset();
  transactionMock.mockImplementation(async (callback: (transaction: {
    delete: typeof transactionDeleteMock;
    update: typeof transactionUpdateMock;
  }) => Promise<unknown>) =>
    callback({
      delete: transactionDeleteMock,
      update: transactionUpdateMock,
    }));
  transactionUpdateMock.mockReset();
  transactionUpdateMock.mockImplementation(() => ({
    set: transactionUpdateSetMock,
  }));
  transactionUpdateSetMock.mockReset();
  transactionUpdateSetMock.mockImplementation(() => ({
    where: transactionUpdateWhereMock,
  }));
  transactionUpdateWhereMock.mockReset();
});

describe("normalizeClerkUserSyncInput", () => {
  /**
   * The primary Clerk email should be selected when available.
   */
  it("prefers the primary email address", () => {
    const normalizedUser = authServiceModule.normalizeClerkUserSyncInput(
      createClerkUserFixture(),
    );

    expect(normalizedUser.email).toBe("primary@example.com");
  });

  /**
   * Clerk users must point at one canonical primary email address.
   */
  it("rejects users without a matching primary email address", () => {
    expect(() =>
      authServiceModule.normalizeClerkUserSyncInput(
        createClerkUserFixture({
          primary_email_address_id: "missing_email",
        }),
      ),
    ).toThrow(/primary email address/i);
  });

  /**
   * Username is used when the user has no first or last name.
   */
  it("falls back to username when no full name is present", () => {
    const normalizedUser = authServiceModule.normalizeClerkUserSyncInput(
      createClerkUserFixture({
        first_name: null,
        last_name: null,
        username: "skeptical-rex",
      }),
    );

    expect(normalizedUser.displayName).toBe("skeptical-rex");
  });

  /**
   * The email local-part becomes the final display-name fallback.
   */
  it("falls back to the email local-part when no name or username exists", () => {
    const normalizedUser = authServiceModule.normalizeClerkUserSyncInput(
      createClerkUserFixture({
        email_addresses: [
          {
            email_address: "sage@example.com",
            id: "email_sage",
          },
        ],
        first_name: null,
        last_name: null,
        primary_email_address_id: "email_sage",
        username: null,
      }),
    );

    expect(normalizedUser.displayName).toBe("sage");
  });

  /**
   * Public metadata roles are mirrored into the local user row when valid.
   */
  it("mirrors supported role metadata from Clerk public metadata", () => {
    const normalizedUser = authServiceModule.normalizeClerkUserSyncInput(
      createClerkUserFixture({
        public_metadata: {
          role: "admin",
        },
      }),
    );

    expect(normalizedUser.role).toBe("admin");
  });

  /**
   * Invalid role metadata should fail fast so Clerk configuration can be fixed.
   */
  it("rejects unsupported public metadata roles", () => {
    expect(() =>
      authServiceModule.normalizeClerkUserSyncInput(
        createClerkUserFixture({
          public_metadata: {
            role: "moderator",
          },
        }),
      ),
    ).toThrow(/unsupported role/i);
  });
});

describe("upsertUser", () => {
  /**
   * The canonical sync path inserts or updates by Clerk id only.
   */
  it("upserts a user by clerk id", async () => {
    insertReturningMock.mockResolvedValueOnce([
      {
        avatarUrl: "https://img.example.com/nova.png",
        clerkId: "user_123",
        createdAt: "2026-03-29T00:00:00.000Z",
        displayName: "Nova Prime",
        email: "primary@example.com",
        id: "local-user-123",
        role: "listener",
        updatedAt: "2026-03-29T00:00:05.000Z",
      },
    ]);

    const persistedUser = await authServiceModule.upsertUser(
      createClerkUserFixture(),
    );

    expect(insertOnConflictDoUpdateMock).toHaveBeenCalledWith({
      target: expect.anything(),
      set: {
        avatarUrl: "https://img.example.com/nova.png",
        displayName: "Nova Prime",
        email: "primary@example.com",
        role: "listener",
        updatedAt: expect.any(String),
      },
    });
    expect(persistedUser.clerkId).toBe("user_123");
    expect(persistedUser.email).toBe("primary@example.com");
  });
});

describe("deleteUser", () => {
  /**
   * Room ownership is cleared and active Redis presence is removed before the
   * local user row is deleted.
   */
  it("clears active presence before deleting the user row", async () => {
    findUserByClerkIdMock.mockResolvedValue({
      id: "local-user-123",
    });
    findActiveRoomListenersMock.mockResolvedValue([
      {
        roomId: "room-a",
      },
      {
        roomId: "room-b",
      },
    ]);
    redisSremMock.mockResolvedValueOnce(1);
    redisSremMock.mockResolvedValueOnce(0);
    transactionUpdateWhereMock.mockResolvedValue(undefined);
    transactionDeleteWhereMock.mockResolvedValue(undefined);

    await authServiceModule.deleteUser("clerk-user-123");

    expect(findUserByClerkIdMock).toHaveBeenCalledTimes(1);
    expect(findActiveRoomListenersMock).toHaveBeenCalledTimes(1);
    expect(redisSremMock).toHaveBeenNthCalledWith(
      1,
      "room:room-a:listeners",
      "local-user-123",
    );
    expect(redisSremMock).toHaveBeenNthCalledWith(
      2,
      "room:room-b:listeners",
      "local-user-123",
    );
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionUpdateMock).toHaveBeenCalledTimes(1);
    expect(transactionUpdateSetMock).toHaveBeenCalledWith({
      createdBy: null,
    });
    expect(transactionDeleteMock).toHaveBeenCalledTimes(1);
    expect(redisSremMock.mock.invocationCallOrder[1]).toBeLessThan(
      transactionDeleteWhereMock.mock.invocationCallOrder[0],
    );
  });

  /**
   * Redis presence is restored if the database mutation fails after presence
   * was already removed.
   */
  it("restores removed presence when the database delete flow fails", async () => {
    const deleteError = new Error("database unavailable");

    findUserByClerkIdMock.mockResolvedValue({
      id: "local-user-123",
    });
    findActiveRoomListenersMock.mockResolvedValue([
      {
        roomId: "room-a",
      },
      {
        roomId: "room-b",
      },
    ]);
    redisSremMock.mockResolvedValueOnce(1);
    redisSremMock.mockResolvedValueOnce(0);
    transactionUpdateWhereMock.mockResolvedValue(undefined);
    transactionDeleteWhereMock.mockRejectedValue(deleteError);
    redisSaddMock.mockResolvedValue(1);

    await expect(
      authServiceModule.deleteUser("clerk-user-123"),
    ).rejects.toThrow(deleteError);

    expect(redisSaddMock).toHaveBeenCalledTimes(1);
    expect(redisSaddMock).toHaveBeenCalledWith(
      "room:room-a:listeners",
      "local-user-123",
    );
  });
});
