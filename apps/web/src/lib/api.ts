/**
 * Typed Fastify API client for the Murmur web application.
 *
 * This module provides the canonical frontend data-access layer for room and
 * admin requests. It is intentionally isomorphic so both App Router server
 * components and client components can call the same helpers, with protected
 * requests receiving either a Clerk token getter or a previously resolved
 * bearer token via dependency injection.
 */

import { AGENT_ROLES, ROOM_FORMATS, ROOM_STATUSES } from "@murmur/shared";

import type {
  AgentSummary,
  AdminAgentMutationResponse,
  ApiAuthContext,
  ApiErrorShape,
  EndRoomResponse,
  JoinRoomResponse,
  LeaveRoomResponse,
  Room,
  RoomStatus,
} from "@/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_REQUEST_ID = "unknown";

/**
 * Options accepted by the shared JSON request helper.
 */
interface JsonRequestOptions {
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string | undefined>;
  body?: unknown;
  auth?: ApiAuthContext;
  cache?: RequestCache;
  keepalive?: boolean;
}

/**
 * `GET /api/rooms` response contract.
 */
interface RoomsListResponse {
  rooms: Room[];
}

/**
 * `GET /api/rooms/:id` response contract.
 */
interface RoomDetailsResponse {
  room: Room;
}

/**
 * `GET /api/admin/rooms` response contract.
 */
interface AdminRoomsResponse {
  rooms: Room[];
}

/**
 * Construction options for `ApiClientError`.
 */
interface ApiClientErrorOptions {
  code: string;
  statusCode: number;
  requestId: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Typed request error thrown for network failures, auth failures, malformed
 * responses, and canonical API error envelopes.
 */
export class ApiClientError extends Error {
  public readonly code: string;

  public readonly statusCode: number;

  public readonly requestId: string;

  public readonly details?: unknown;

  /**
   * Creates a new API client error instance.
   *
   * @param message - Human-readable description of the failure.
   * @param options - Structured error metadata for callers and logging.
   */
  public constructor(message: string, options: ApiClientErrorOptions) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ApiClientError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.details = options.details;

    Error.captureStackTrace?.(this, ApiClientError);
  }
}

/**
 * Narrows an unknown value to a plain JSON-like record.
 *
 * @param value - Candidate value to inspect.
 * @returns True when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads and validates the canonical frontend API base URL from the environment.
 *
 * @returns The normalized API base URL without a trailing slash.
 * @throws {Error} When the environment variable is missing, blank, or invalid.
 */
function getApiBaseUrl(): string {
  const rawBaseUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

  if (!rawBaseUrl) {
    throw new Error(
      "NEXT_PUBLIC_API_URL must be configured before the Murmur web app can call the API.",
    );
  }

  const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, "");

  try {
    return new URL(normalizedBaseUrl).toString().replace(/\/+$/, "");
  } catch (error) {
    throw new Error(
      "NEXT_PUBLIC_API_URL must be a valid absolute URL.",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

/**
 * Normalizes a UUID-like identifier used in room and agent routes.
 *
 * @param value - Raw identifier supplied by the caller.
 * @param label - Human-readable field label for error messages.
 * @returns The trimmed identifier string.
 * @throws {TypeError} When the identifier is not a string.
 * @throws {Error} When the identifier is blank or not UUID-shaped.
 */
function normalizeUuid(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  if (!UUID_PATTERN.test(normalizedValue)) {
    throw new Error(`${label} must be a valid UUID.`);
  }

  return normalizedValue;
}

/**
 * Normalizes a required non-empty string.
 *
 * @param value - Raw string supplied by the caller or API response.
 * @param label - Human-readable field label for error messages.
 * @returns The trimmed string value.
 * @throws {TypeError} When the value is not a string.
 * @throws {Error} When the string is blank.
 */
function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalizedValue;
}

/**
 * Normalizes an optional bearer token supplied by the caller.
 *
 * @param value - Candidate token string or nullable value.
 * @returns The trimmed token or `null` when the value is absent/blank.
 */
function normalizeOptionalToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim();

  return normalizedValue.length > 0 ? normalizedValue : null;
}

/**
 * Creates a typed client error for malformed responses and local request issues.
 *
 * @param message - Human-readable description of the failure.
 * @param options - Structured metadata for the typed error instance.
 * @returns A typed API client error.
 */
function createApiClientError(
  message: string,
  options: ApiClientErrorOptions,
): ApiClientError {
  return new ApiClientError(message, options);
}

/**
 * Parses a response body as JSON and rejects empty or malformed payloads.
 *
 * @param response - Fetch response whose body should contain JSON.
 * @param code - Stable machine-readable error code for malformed payloads.
 * @param message - Human-readable failure message for malformed payloads.
 * @returns The parsed JSON value.
 * @throws {ApiClientError} When the body is empty or not valid JSON.
 */
async function parseJsonBody(
  response: Response,
  code: string,
  message: string,
): Promise<unknown> {
  const rawBody = await response.text();

  if (rawBody.trim().length === 0) {
    throw createApiClientError(message, {
      code,
      statusCode: response.status,
      requestId: UNKNOWN_REQUEST_ID,
    });
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw createApiClientError(message, {
      code,
      statusCode: response.status,
      requestId: UNKNOWN_REQUEST_ID,
      cause: error,
    });
  }
}

/**
 * Checks whether a parsed value matches the API's canonical error envelope.
 *
 * @param value - Parsed JSON payload to inspect.
 * @returns True when the payload matches the known error shape.
 */
function isApiErrorShape(value: unknown): value is ApiErrorShape {
  if (!isRecord(value) || !isRecord(value.error)) {
    return false;
  }

  return (
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    typeof value.error.statusCode === "number" &&
    typeof value.error.requestId === "string"
  );
}

/**
 * Converts a non-2xx response into the canonical typed client error.
 *
 * @param response - Failed fetch response from the API.
 * @throws {ApiClientError} Always throws with either parsed or synthetic metadata.
 */
async function throwApiError(response: Response): Promise<never> {
  const errorPayload = await parseJsonBody(
    response,
    "invalid_error_response",
    "The Murmur API returned an empty or non-JSON error response.",
  );

  if (!isApiErrorShape(errorPayload)) {
    throw createApiClientError(
      "The Murmur API returned a malformed error payload.",
      {
        code: "invalid_error_response",
        statusCode: response.status,
        requestId: UNKNOWN_REQUEST_ID,
        details: errorPayload,
      },
    );
  }

  throw createApiClientError(errorPayload.error.message, {
    code: errorPayload.error.code,
    statusCode: errorPayload.error.statusCode,
    requestId: errorPayload.error.requestId,
    details: errorPayload.error.details,
  });
}

/**
 * Resolves the authorization header value for a protected request.
 *
 * @param auth - Auth context supplying either a resolved bearer token or a Clerk token getter.
 * @returns A fully formed Bearer authorization header value.
 * @throws {ApiClientError} When the auth context is missing or produces no token.
 */
async function getAuthorizationHeader(auth: ApiAuthContext | undefined): Promise<string> {
  if (!auth) {
    throw createApiClientError(
      "Protected API requests require an auth context with either a token or getToken() function.",
      {
        code: "missing_auth_context",
        statusCode: 401,
        requestId: UNKNOWN_REQUEST_ID,
      },
    );
  }

  if ("token" in auth) {
    const normalizedToken = normalizeOptionalToken(auth.token);

    if (!normalizedToken) {
      throw createApiClientError(
        "Protected API requests require a valid Clerk session token.",
        {
          code: "missing_auth_token",
          statusCode: 401,
          requestId: UNKNOWN_REQUEST_ID,
        },
      );
    }

    return `Bearer ${normalizedToken}`;
  }

  if (typeof auth.getToken !== "function") {
    throw createApiClientError(
      "Protected API requests require an auth context with either a token or getToken() function.",
      {
        code: "missing_auth_context",
        statusCode: 401,
        requestId: UNKNOWN_REQUEST_ID,
      },
    );
  }

  const normalizedToken = normalizeOptionalToken(await auth.getToken());

  if (!normalizedToken) {
    throw createApiClientError(
      "Protected API requests require a valid Clerk session token.",
      {
        code: "missing_auth_token",
        statusCode: 401,
        requestId: UNKNOWN_REQUEST_ID,
      },
    );
  }

  return `Bearer ${normalizedToken}`;
}

/**
 * Builds an absolute API URL from a path and optional query-string values.
 *
 * @param path - Absolute API path beginning with `/`.
 * @param query - Optional query-string key/value pairs.
 * @returns An absolute URL targeting the Fastify API.
 */
function buildApiUrl(
  path: string,
  query: Record<string, string | undefined> = {},
): URL {
  const url = new URL(path.replace(/^\//, ""), `${getApiBaseUrl()}/`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}

/**
 * Ensures a success payload includes the named object field.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param field - Required top-level field name.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The nested record stored in the requested field.
 * @throws {ApiClientError} When the payload shape is invalid.
 */
function getRequiredRecordField(
  payload: unknown,
  field: string,
  statusCode: number,
): Record<string, unknown> {
  if (!isRecord(payload) || !isRecord(payload[field])) {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: expected "${field}" to be an object.`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  return payload[field];
}

/**
 * Ensures a success payload includes the named array field.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param field - Required top-level field name.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The array stored in the requested field.
 * @throws {ApiClientError} When the payload shape is invalid.
 */
function getRequiredArrayField(
  payload: unknown,
  field: string,
  statusCode: number,
): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload[field])) {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: expected "${field}" to be an array.`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  return payload[field];
}

/**
 * Ensures a success payload includes the named boolean field.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param field - Required top-level field name.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The boolean stored in the requested field.
 * @throws {ApiClientError} When the payload shape is invalid.
 */
function getRequiredBooleanField(
  payload: unknown,
  field: string,
  statusCode: number,
): boolean {
  if (!isRecord(payload) || typeof payload[field] !== "boolean") {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: expected "${field}" to be a boolean.`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  return payload[field] as boolean;
}

/**
 * Ensures a success payload includes the named finite number field.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param field - Required top-level field name.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The number stored in the requested field.
 * @throws {ApiClientError} When the payload shape is invalid.
 */
function getRequiredNumberField(
  payload: unknown,
  field: string,
  statusCode: number,
): number {
  if (
    !isRecord(payload) ||
    typeof payload[field] !== "number" ||
    !Number.isFinite(payload[field])
  ) {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: expected "${field}" to be a finite number.`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  return payload[field] as number;
}

/**
 * Ensures a success payload includes the named nullable string field.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param field - Required top-level field name.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The string stored in the requested field or `null`.
 * @throws {ApiClientError} When the payload shape is invalid.
 */
function getNullableStringField(
  payload: unknown,
  field: string,
  statusCode: number,
): string | null {
  if (!isRecord(payload)) {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: expected "${field}" on an object response.`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  const fieldValue = payload[field];

  if (fieldValue === null) {
    return null;
  }

  if (typeof fieldValue !== "string") {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: expected "${field}" to be a string or null.`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  return fieldValue;
}

/**
 * Ensures a success payload includes the named string field.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param field - Required top-level field name.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The string stored in the requested field.
 * @throws {ApiClientError} When the payload shape is invalid.
 */
function getRequiredStringField(
  payload: unknown,
  field: string,
  statusCode: number,
): string {
  if (!isRecord(payload) || typeof payload[field] !== "string") {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: expected "${field}" to be a string.`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  return normalizeRequiredString(payload[field], field);
}

/**
 * Validates a serialized room-agent summary nested in a room payload.
 *
 * @param payload - Candidate agent summary value.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns A typed agent summary object.
 */
function parseAgentSummary(
  payload: unknown,
  statusCode: number,
): AgentSummary {
  const role = getRequiredStringField(payload, "role", statusCode);

  if (!AGENT_ROLES.includes(role as (typeof AGENT_ROLES)[number])) {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: unsupported agent role "${role}".`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  const normalizedRole = role as AgentSummary["role"];

  return {
    id: getRequiredStringField(payload, "id", statusCode),
    name: getRequiredStringField(payload, "name", statusCode),
    avatarUrl: getRequiredStringField(payload, "avatarUrl", statusCode),
    role: normalizedRole,
    accentColor: getRequiredStringField(payload, "accentColor", statusCode),
  };
}

/**
 * Validates an array of serialized room-agent summaries.
 *
 * @param payload - Candidate agent-summary array.
 * @param field - Required top-level field name.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns A typed array of agent summaries.
 */
function parseAgentSummaryArray(
  payload: unknown,
  field: string,
  statusCode: number,
): AgentSummary[] {
  return getRequiredArrayField(payload, field, statusCode).map((agentPayload) =>
    parseAgentSummary(agentPayload, statusCode),
  );
}

/**
 * Validates a serialized room object returned by the Fastify API.
 *
 * @param payload - Candidate room payload.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns A typed room object.
 */
function parseRoomRecord(payload: unknown, statusCode: number): Room {
  const format = getRequiredStringField(payload, "format", statusCode);
  const status = getRequiredStringField(payload, "status", statusCode);

  if (!ROOM_FORMATS.includes(format as (typeof ROOM_FORMATS)[number])) {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: unsupported room format "${format}".`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  if (!ROOM_STATUSES.includes(status as (typeof ROOM_STATUSES)[number])) {
    throw createApiClientError(
      `The Murmur API returned an invalid success payload: unsupported room status "${status}".`,
      {
        code: "invalid_response_shape",
        statusCode,
        requestId: UNKNOWN_REQUEST_ID,
        details: payload,
      },
    );
  }

  const normalizedFormat = format as Room["format"];
  const normalizedStatus = status as Room["status"];

  return {
    id: getRequiredStringField(payload, "id", statusCode),
    title: getRequiredStringField(payload, "title", statusCode),
    topic: getRequiredStringField(payload, "topic", statusCode),
    format: normalizedFormat,
    status: normalizedStatus,
    createdBy: getNullableStringField(payload, "createdBy", statusCode),
    createdAt: getRequiredStringField(payload, "createdAt", statusCode),
    endedAt: getNullableStringField(payload, "endedAt", statusCode),
    listenerCount: getRequiredNumberField(payload, "listenerCount", statusCode),
    agents: parseAgentSummaryArray(payload, "agents", statusCode),
  };
}

/**
 * Validates the `GET /api/rooms` and `GET /api/admin/rooms` response payload.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The rooms array.
 */
function parseRoomsListResponse(
  payload: unknown,
  statusCode: number,
): Room[] {
  return getRequiredArrayField(payload, "rooms", statusCode).map((roomPayload) =>
    parseRoomRecord(roomPayload, statusCode),
  );
}

/**
 * Validates the `GET /api/rooms/:id` response payload.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The room payload.
 */
function parseRoomDetailsResponse(
  payload: unknown,
  statusCode: number,
): Room {
  return parseRoomRecord(getRequiredRecordField(payload, "room", statusCode), statusCode);
}

/**
 * Validates the `POST /api/rooms/:id/join` response payload.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The typed join response payload.
 */
function parseJoinRoomResponse(
  payload: unknown,
  statusCode: number,
): JoinRoomResponse {
  return {
    room: parseRoomRecord(getRequiredRecordField(payload, "room", statusCode), statusCode),
    agents: parseAgentSummaryArray(payload, "agents", statusCode),
    livekitToken: getRequiredStringField(payload, "livekitToken", statusCode),
    centrifugoToken: getRequiredStringField(payload, "centrifugoToken", statusCode),
  };
}

/**
 * Validates the `POST /api/rooms/:id/leave` response payload.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The typed leave response payload.
 */
function parseLeaveRoomResponse(
  payload: unknown,
  statusCode: number,
): LeaveRoomResponse {
  return {
    roomId: getRequiredStringField(payload, "roomId", statusCode),
    listenerCount: getRequiredNumberField(payload, "listenerCount", statusCode),
  };
}

/**
 * Validates the mute/unmute admin response payload.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The typed admin agent mutation response payload.
 */
function parseAdminAgentMutationResponse(
  payload: unknown,
  statusCode: number,
): AdminAgentMutationResponse {
  return {
    roomId: getRequiredStringField(payload, "roomId", statusCode),
    agentId: getRequiredStringField(payload, "agentId", statusCode),
    muted: getRequiredBooleanField(payload, "muted", statusCode),
    changed: getRequiredBooleanField(payload, "changed", statusCode),
  };
}

/**
 * Validates the end-room admin response payload.
 *
 * @param payload - Parsed JSON payload returned by the API.
 * @param statusCode - HTTP status code of the response being validated.
 * @returns The typed end-room response payload.
 */
function parseEndRoomResponse(
  payload: unknown,
  statusCode: number,
): EndRoomResponse {
  return {
    alreadyEnded: getRequiredBooleanField(payload, "alreadyEnded", statusCode),
    room: parseRoomRecord(getRequiredRecordField(payload, "room", statusCode), statusCode),
  };
}

/**
 * Executes a JSON API request and validates the returned payload.
 *
 * @param options - Request configuration, including auth and cache controls.
 * @param parser - Success-payload parser specific to the target endpoint.
 * @returns The parsed success payload.
 * @throws {ApiClientError} When the request fails, the caller is unauthenticated,
 * or the response shape is invalid.
 */
async function requestJson<T>(
  options: JsonRequestOptions,
  parser: (payload: unknown, statusCode: number) => T,
): Promise<T> {
  const url = buildApiUrl(options.path, options.query);
  const headers = new Headers({
    Accept: "application/json",
  });
  const requestInit: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };

  if (options.cache !== undefined) {
    requestInit.cache = options.cache;
  }

  if (options.keepalive !== undefined) {
    requestInit.keepalive = options.keepalive;
  }

  if (options.auth !== undefined) {
    headers.set("Authorization", await getAuthorizationHeader(options.auth));
  }

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    requestInit.body = JSON.stringify(options.body);
  }

  let response: Response;

  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    throw createApiClientError(
      "The Murmur API request failed before a response was received.",
      {
        code: "network_error",
        statusCode: 0,
        requestId: UNKNOWN_REQUEST_ID,
        cause: error,
      },
    );
  }

  if (!response.ok) {
    return await throwApiError(response);
  }

  const payload = await parseJsonBody(
    response,
    "invalid_success_response",
    "The Murmur API returned an empty or non-JSON success response.",
  );

  return parser(payload, response.status);
}

/**
 * Fetches rooms for the public lobby, optionally filtered by lifecycle status.
 *
 * @param status - Optional room-status filter applied by the API.
 * @returns The matching rooms returned by the Fastify backend.
 * @throws {Error | ApiClientError} When the status is invalid or the request fails.
 */
export async function fetchRooms(status?: RoomStatus): Promise<Room[]> {
  if (status !== undefined && !ROOM_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${ROOM_STATUSES.join(", ")}.`);
  }

  const payload = await requestJson<RoomsListResponse>(
    {
      path: "/api/rooms",
      query: {
        status,
      },
    },
    (responsePayload, statusCode) => ({
      rooms: parseRoomsListResponse(responsePayload, statusCode),
    }),
  );

  return payload.rooms;
}

/**
 * Fetches a single room and its assigned agents.
 *
 * @param id - UUID of the room to fetch.
 * @returns The requested room payload.
 * @throws {Error | ApiClientError} When the identifier is invalid or the request fails.
 */
export async function fetchRoom(id: string): Promise<Room> {
  const roomId = normalizeUuid(id, "id");
  const payload = await requestJson<RoomDetailsResponse>(
    {
      path: `/api/rooms/${encodeURIComponent(roomId)}`,
    },
    (responsePayload, statusCode) => ({
      room: parseRoomDetailsResponse(responsePayload, statusCode),
    }),
  );

  return payload.room;
}

/**
 * Completes the protected listener join handshake for a room.
 *
 * @param id - UUID of the room being joined.
 * @param auth - Resolved bearer token or Clerk token getter used for authorization.
 * @returns The room payload plus LiveKit and Centrifugo tokens.
 * @throws {Error | ApiClientError} When the identifier is invalid or the request fails.
 */
export async function joinRoom(
  id: string,
  auth: ApiAuthContext,
): Promise<JoinRoomResponse> {
  const roomId = normalizeUuid(id, "id");

  return requestJson<JoinRoomResponse>(
    {
      path: `/api/rooms/${encodeURIComponent(roomId)}/join`,
      method: "POST",
      auth,
    },
    parseJoinRoomResponse,
  );
}

/**
 * Leaves a room for the authenticated listener.
 *
 * @param id - UUID of the room being left.
 * @param auth - Resolved bearer token or Clerk token getter used for authorization.
 * @returns The updated listener count for the room.
 * @throws {Error | ApiClientError} When the identifier is invalid or the request fails.
 */
export async function leaveRoom(
  id: string,
  auth: ApiAuthContext,
): Promise<LeaveRoomResponse> {
  const roomId = normalizeUuid(id, "id");

  return requestJson<LeaveRoomResponse>(
    {
      path: `/api/rooms/${encodeURIComponent(roomId)}/leave`,
      method: "POST",
      auth,
      keepalive: true,
    },
    parseLeaveRoomResponse,
  );
}

/**
 * Fetches all rooms available to administrators, including ended rooms.
 *
 * @param auth - Clerk token getter used for authorization.
 * @returns All rooms returned by the admin API.
 * @throws {ApiClientError} When the request fails or the caller is unauthenticated.
 */
export async function fetchAdminRooms(
  auth: ApiAuthContext,
): Promise<Room[]> {
  const payload = await requestJson<AdminRoomsResponse>(
    {
      path: "/api/admin/rooms",
      auth,
      cache: "no-store",
    },
    (responsePayload, statusCode) => ({
      rooms: parseRoomsListResponse(responsePayload, statusCode),
    }),
  );

  return payload.rooms;
}

/**
 * Mutes an assigned agent in a live room through the admin API.
 *
 * @param roomId - UUID of the room being managed.
 * @param agentId - UUID of the agent being muted.
 * @param auth - Clerk token getter used for authorization.
 * @returns The mutation result from the admin API.
 * @throws {Error | ApiClientError} When identifiers are invalid or the request fails.
 */
export async function muteAgent(
  roomId: string,
  agentId: string,
  auth: ApiAuthContext,
): Promise<AdminAgentMutationResponse> {
  const normalizedRoomId = normalizeUuid(roomId, "roomId");
  const normalizedAgentId = normalizeUuid(agentId, "agentId");

  return requestJson<AdminAgentMutationResponse>(
    {
      path: `/api/admin/rooms/${encodeURIComponent(normalizedRoomId)}/agents/${encodeURIComponent(normalizedAgentId)}/mute`,
      method: "POST",
      auth,
    },
    parseAdminAgentMutationResponse,
  );
}

/**
 * Unmutes an assigned agent in a live room through the admin API.
 *
 * @param roomId - UUID of the room being managed.
 * @param agentId - UUID of the agent being unmuted.
 * @param auth - Clerk token getter used for authorization.
 * @returns The mutation result from the admin API.
 * @throws {Error | ApiClientError} When identifiers are invalid or the request fails.
 */
export async function unmuteAgent(
  roomId: string,
  agentId: string,
  auth: ApiAuthContext,
): Promise<AdminAgentMutationResponse> {
  const normalizedRoomId = normalizeUuid(roomId, "roomId");
  const normalizedAgentId = normalizeUuid(agentId, "agentId");

  return requestJson<AdminAgentMutationResponse>(
    {
      path: `/api/admin/rooms/${encodeURIComponent(normalizedRoomId)}/agents/${encodeURIComponent(normalizedAgentId)}/unmute`,
      method: "POST",
      auth,
    },
    parseAdminAgentMutationResponse,
  );
}

/**
 * Ends a live room through the admin API.
 *
 * @param roomId - UUID of the room being ended.
 * @param auth - Clerk token getter used for authorization.
 * @returns The end-room result returned by the API.
 * @throws {Error | ApiClientError} When the identifier is invalid or the request fails.
 */
export async function endRoom(
  roomId: string,
  auth: ApiAuthContext,
): Promise<EndRoomResponse> {
  const normalizedRoomId = normalizeUuid(roomId, "roomId");

  return requestJson<EndRoomResponse>(
    {
      path: `/api/admin/rooms/${encodeURIComponent(normalizedRoomId)}/end`,
      method: "POST",
      auth,
    },
    parseEndRoomResponse,
  );
}
