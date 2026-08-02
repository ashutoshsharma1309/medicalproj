import { db } from "./db";

/** Fire-and-forget audit trail. Never throws into the request path. */
export function audit(entry: {
  userId?: string | null;
  action: string;
  resource?: string;
  detail?: string;
  ip?: string;
}) {
  db.auditLog
    .create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        resource: entry.resource,
        detail: entry.detail,
        ip: entry.ip,
      },
    })
    .catch(() => {});
}
