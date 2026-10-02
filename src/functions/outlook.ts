import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { type RedisClientType } from "redis";
import { type FastifyBaseLogger } from "fastify";
import { PrismaClient } from "../generated/prisma/client.js";
import config from "../config.js";
import { OutlookError } from "../errors/index.js";

// Delegated Graph scopes requested by the "Connect Outlook" flow. Kept separate
// from the login scopes so students never see a calendar consent prompt.
export const OUTLOOK_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
];

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const ACCESS_TOKEN_CACHE_PREFIX = "outlook_at:";

export function isOutlookConfigured(): boolean {
  return Boolean(config.OUTLOOK_TOKEN_KEY);
}

function tokenKey(): Buffer {
  if (!config.OUTLOOK_TOKEN_KEY) {
    throw new OutlookError({
      message: "Outlook integration is not configured on this server.",
    });
  }
  return Buffer.from(config.OUTLOOK_TOKEN_KEY, "base64");
}

// AES-256-GCM; stored as base64 "iv:tag:ciphertext".
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((b) => b.toString("base64"))
    .join(":");
}

function decryptToken(stored: string): string {
  const [iv, tag, ciphertext] = stored
    .split(":")
    .map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

async function cacheAccessToken(
  redisClient: RedisClientType,
  netId: string,
  accessToken: string,
  expiresIn: number,
) {
  const ttl = Math.max(expiresIn - 60, 1);
  await redisClient.set(`${ACCESS_TOKEN_CACHE_PREFIX}${netId}`, accessToken, {
    EX: ttl,
  });
}

// Called from the OAuth callback once a staff member grants calendar access.
export async function saveOutlookGrant({
  prismaClient,
  redisClient,
  netId,
  refreshToken,
  accessToken,
  expiresIn,
  scopes,
}: {
  prismaClient: PrismaClient;
  redisClient: RedisClientType;
  netId: string;
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  scopes: string;
}) {
  const encryptedRefreshToken = encryptToken(refreshToken);
  await prismaClient.outlookCalendarGrant.upsert({
    where: { netId },
    create: { netId, encryptedRefreshToken, scopes, lastError: null },
    update: {
      encryptedRefreshToken,
      scopes,
      connectedAt: new Date(),
      lastError: null,
    },
  });
  await cacheAccessToken(redisClient, netId, accessToken, expiresIn);
}

export async function getOutlookStatus(
  prismaClient: PrismaClient,
  netId: string,
): Promise<{ configured: boolean; connected: boolean; lastError: string | null }> {
  const grant = await prismaClient.outlookCalendarGrant.findUnique({
    where: { netId },
    select: { lastError: true },
  });
  return {
    configured: isOutlookConfigured(),
    connected: Boolean(grant) && !grant?.lastError,
    lastError: grant?.lastError ?? null,
  };
}

// Returns a Graph access token for the staff member, refreshing (and rotating
// the stored refresh token) when the cached one has expired.
export async function getGraphAccessToken({
  prismaClient,
  redisClient,
  netId,
}: {
  prismaClient: PrismaClient;
  redisClient: RedisClientType;
  netId: string;
}): Promise<string> {
  const cached = await redisClient.get(`${ACCESS_TOKEN_CACHE_PREFIX}${netId}`);
  if (cached) {
    return cached;
  }
  const grant = await prismaClient.outlookCalendarGrant.findUnique({
    where: { netId },
  });
  if (!grant) {
    throw new OutlookError({
      message: `${netId} has not connected their Outlook calendar.`,
    });
  }
  const response = await fetch(
    `https://login.microsoftonline.com/${config.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.AZURE_CLIENT_ID,
        client_secret: config.AZURE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: decryptToken(grant.encryptedRefreshToken),
        scope: OUTLOOK_SCOPES.join(" "),
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    const lastError =
      body.error === "invalid_grant"
        ? "Outlook access expired or was revoked. Please reconnect Outlook."
        : `Token refresh failed: ${body.error || response.status}`;
    await prismaClient.outlookCalendarGrant.update({
      where: { netId },
      data: { lastError },
    });
    throw new OutlookError({ message: lastError });
  }
  await prismaClient.outlookCalendarGrant.update({
    where: { netId },
    data: {
      ...(body.refresh_token
        ? { encryptedRefreshToken: encryptToken(body.refresh_token) }
        : {}),
      ...(body.scope ? { scopes: body.scope } : {}),
      lastError: null,
    },
  });
  await cacheAccessToken(
    redisClient,
    netId,
    body.access_token,
    body.expires_in ?? 3600,
  );
  return body.access_token;
}

async function graphRequest(
  accessToken: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  return fetch(`${GRAPH_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function graphErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return `Graph ${response.status}: ${body.error?.message || body.error?.code || response.statusText}`;
}

// Graph expects a wall-clock dateTime paired with a timeZone; send UTC.
function graphDateTime(date: Date) {
  return { dateTime: date.toISOString().replace("Z", ""), timeZone: "UTC" };
}

// Creates the event on the organizer's calendar; Graph emails invites to the
// attendees. transactionId makes a retried create idempotent.
export async function createClinicEvent({
  prismaClient,
  redisClient,
  organizerNetId,
  transactionId,
  subject,
  bodyHtml,
  startAt,
  endAt,
  room,
  attendees,
}: {
  prismaClient: PrismaClient;
  redisClient: RedisClientType;
  organizerNetId: string;
  transactionId: string;
  subject: string;
  bodyHtml: string;
  startAt: Date;
  endAt: Date;
  room: string;
  attendees: { email: string; name: string | null }[];
}): Promise<string> {
  const accessToken = await getGraphAccessToken({
    prismaClient,
    redisClient,
    netId: organizerNetId,
  });
  const response = await graphRequest(accessToken, "/me/events", {
    method: "POST",
    body: {
      subject,
      body: { contentType: "HTML", content: bodyHtml },
      start: graphDateTime(startAt),
      end: graphDateTime(endAt),
      location: { displayName: room },
      attendees: attendees.map((a) => ({
        emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
        type: "required",
      })),
      allowNewTimeProposals: false,
      transactionId,
    },
  });
  if (!response.ok) {
    throw new OutlookError({ message: await graphErrorMessage(response) });
  }
  const event = (await response.json()) as { id: string };
  return event.id;
}

// Cancels the event and notifies attendees. A missing event is treated as
// already cancelled.
export async function cancelClinicEvent({
  prismaClient,
  redisClient,
  organizerNetId,
  eventId,
  comment,
  logger,
}: {
  prismaClient: PrismaClient;
  redisClient: RedisClientType;
  organizerNetId: string;
  eventId: string;
  comment: string;
  logger?: FastifyBaseLogger;
}): Promise<void> {
  const accessToken = await getGraphAccessToken({
    prismaClient,
    redisClient,
    netId: organizerNetId,
  });
  const response = await graphRequest(
    accessToken,
    `/me/events/${encodeURIComponent(eventId)}/cancel`,
    { method: "POST", body: { comment } },
  );
  if (response.status === 404) {
    logger?.warn({ organizerNetId, eventId }, "Outlook event already gone");
    return;
  }
  if (!response.ok) {
    throw new OutlookError({ message: await graphErrorMessage(response) });
  }
}
