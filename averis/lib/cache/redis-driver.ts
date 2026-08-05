import "server-only";

import { assertSafeKey, memoryDriver, type CacheDriver } from "./cache";
import { log } from "@/lib/observability/logger";

/**
 * Redis cache driver.
 *
 * Used when `REDIS_URL` is set; otherwise the in-process driver stands in. The
 * distinction only matters above one instance — with several, an in-process
 * cache means each holds its own copy and an invalidation on one does not
 * reach the others, so a patient can see a stale summary depending on which
 * container answered.
 *
 * Implemented over the Redis wire protocol directly rather than through a
 * client library. The surface needed is five commands, and a dependency that
 * ships its own connection pooling, cluster support and Lua scripting is a lot
 * of attack surface to accept for GET and SETEX in a system holding health
 * data.
 *
 * Every operation degrades to a miss on failure. See `cached()` — a cache that
 * can take the site down when it misbehaves is a liability.
 */

type Connection = {
  send(command: string[]): Promise<RedisValue>;
  close(): void;
};

type RedisValue = string | number | null | RedisValue[];

/** Redis Serialization Protocol, encoding side. */
function encode(command: string[]): string {
  return (
    `*${command.length}\r\n` +
    command.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")
  );
}

/**
 * Decodes one RESP reply.
 *
 * Returns the value plus how many bytes it consumed, so a partial reply can be
 * detected and waited on rather than parsed as a truncated value.
 */
export function decode(buffer: Buffer, offset = 0): { value: RedisValue; next: number } | null {
  if (offset >= buffer.length) return null;

  const terminator = buffer.indexOf("\r\n", offset);
  if (terminator === -1) return null;

  const type = String.fromCharCode(buffer[offset]);
  const payload = buffer.toString("utf8", offset + 1, terminator);
  const afterLine = terminator + 2;

  switch (type) {
    case "+":
      return { value: payload, next: afterLine };
    case "-":
      throw new Error(`Redis error: ${payload}`);
    case ":":
      return { value: Number(payload), next: afterLine };
    case "$": {
      const length = Number(payload);
      if (length === -1) return { value: null, next: afterLine };
      const end = afterLine + length;
      // The trailing CRLF must have arrived too, or the value is incomplete.
      if (buffer.length < end + 2) return null;
      return { value: buffer.toString("utf8", afterLine, end), next: end + 2 };
    }
    case "*": {
      const count = Number(payload);
      if (count === -1) return { value: null, next: afterLine };

      const items: RedisValue[] = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i += 1) {
        const item = decode(buffer, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`Unsupported Redis reply type "${type}".`);
  }
}

async function connect(url: string): Promise<Connection> {
  const net = await import("node:net");
  const parsed = new URL(url);

  const socket = net.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
  });
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  const waiting: { resolve: (v: RedisValue) => void; reject: (e: Error) => void }[] = [];

  socket.on("data", (chunk: Buffer | string) => {
    // The socket is never set to an encoding, so chunks arrive as Buffers —
    // but the type allows a string, and concatenating one silently corrupts
    // the byte offsets the RESP decoder walks.
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);

    // Replies are answered in order, so the queue head always owns the next
    // complete reply in the buffer.
    while (waiting.length > 0) {
      let decoded: { value: RedisValue; next: number } | null;
      try {
        decoded = decode(buffer, 0);
      } catch (error) {
        waiting.shift()?.reject(error as Error);
        buffer = Buffer.alloc(0);
        continue;
      }
      if (!decoded) break;
      buffer = buffer.subarray(decoded.next);
      waiting.shift()?.resolve(decoded.value);
    }
  });

  const fail = (error: Error) => {
    while (waiting.length > 0) waiting.shift()?.reject(error);
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Redis connection closed")));

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const send = (command: string[]) =>
    new Promise<RedisValue>((resolve, reject) => {
      waiting.push({ resolve, reject });
      socket.write(encode(command));
    });

  if (parsed.password) {
    await send(parsed.username ? ["AUTH", parsed.username, parsed.password] : ["AUTH", parsed.password]);
  }

  return { send, close: () => socket.destroy() };
}

export function redisDriver(url: string): CacheDriver {
  let connection: Promise<Connection> | null = null;

  const conn = async (): Promise<Connection> => {
    connection ??= connect(url).catch((error) => {
      // Cleared so the next call retries rather than reusing a rejected
      // promise for the lifetime of the process.
      connection = null;
      throw error;
    });
    return connection;
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const reply = await (await conn()).send(["GET", key]);
        return reply === null ? null : (JSON.parse(String(reply)) as T);
      } catch (error) {
        log.warn("cache read failed", { key: key.split(":")[0], error });
        return null;
      }
    },

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      assertSafeKey(key);
      try {
        await (await conn()).send([
          "SETEX",
          key,
          String(Math.max(1, Math.floor(ttlSeconds))),
          JSON.stringify(value),
        ]);
      } catch (error) {
        log.warn("cache write failed", { key: key.split(":")[0], error });
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await (await conn()).send(["DEL", key]);
      } catch (error) {
        log.warn("cache delete failed", { key: key.split(":")[0], error });
      }
    },

    async deletePrefix(prefix: string): Promise<void> {
      try {
        const client = await conn();
        let cursor = "0";

        // SCAN rather than KEYS: KEYS blocks the server for the whole sweep,
        // and invalidation runs on the request path after a patient confirms
        // a document.
        do {
          const reply = (await client.send([
            "SCAN",
            cursor,
            "MATCH",
            `${prefix}*`,
            "COUNT",
            "200",
          ])) as [string, string[]];

          cursor = reply[0];
          const keys = reply[1] ?? [];
          if (keys.length > 0) await client.send(["DEL", ...keys]);
        } while (cursor !== "0");
      } catch (error) {
        log.warn("cache prefix delete failed", { prefix: prefix.split(":")[0], error });
      }
    },
  };
}

/** Redis when configured, in-process otherwise. */
export function createCacheDriver(): CacheDriver {
  const url = process.env.REDIS_URL;
  if (!url) {
    log.info("cache using in-process driver", { reason: "REDIS_URL not set" });
    return memoryDriver();
  }
  return redisDriver(url);
}
