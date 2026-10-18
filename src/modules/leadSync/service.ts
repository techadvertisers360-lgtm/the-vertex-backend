import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors";
import { logger } from "../../lib/misc";
import { maskPhone } from "../../lib/phone";
import { audit, systemActor, type Actor } from "../../services/audit";
import { notifyUsers } from "../../services/notifications";
import { publish, userRoom } from "../../services/realtime";
import { getSetting } from "../../services/settings";
import {
  a1,
  serviceAccountEmail,
  SheetsApiError,
  sheetsApi,
  startRowOf,
} from "../../services/googleSheets";
import {
  columnMapSchema,
  parseRow,
  resolveColumns,
  type ColumnMap,
  type ParsedRow,
} from "./parse";

/**
 * Google Sheets → leads sync (Phase 9b, D-039).
 * - Only assigned, active sheets with a Google Sheet ID are polled (`meta.syncIntervalMin`, default 3).
 * - A DB lease on the sheet row means one sync per sheet at a time across the API ("Sync now") and any number of
 *   workers; the `(sheetId, externalRowId)` unique key + createMany(skipDuplicates) guarantees no duplicate leads
 *   even if a lease expires mid-run.
 * - Only new rows become leads; existing leads are never updated, so app-side status / remarks are never overwritten.
 * - Every run writes a SheetSyncRun (sync log). After `meta.syncFailureAlertAfter` (3) failures in a row Hamza
 *   Zafar and Muaz Tahir are alerted once per failure streak.
 */

const LEASE_MS = 2 * 60_000;
/** With an id column, re-read this many rows before the cursor so rows shifted by deletions are not missed. */
const ID_OVERLAP_ROWS = 200;
/** New leads per run; the rest come on the next run (keeps the transaction short). */
const MAX_NEW_PER_RUN = 500;

export class SyncError extends Error {}

export interface SyncResult {
  runId: string;
  status: "SUCCESS" | "FAILED";
  imported: number;
  alreadyImported: number;
  duplicatePhones: number;
  skipped: number;
  rowsRead: number;
  error: string | null;
  more: boolean;
}

/** Claim the sheet's lease. Scheduled runs also require the interval to have passed since the last attempt. */
export async function claimSheet(
  sheetId: string,
  owner: string,
  now: Date,
  intervalMin: number | null,
): Promise<boolean> {
  const where: Prisma.MetaSheetWhereInput = {
    id: sheetId,
    OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
  };
  if (intervalMin !== null)
    where.AND = [
      {
        OR: [
          { lastSyncAttemptAt: null },
          {
            lastSyncAttemptAt: {
              lte: new Date(now.getTime() - intervalMin * 60_000),
            },
          },
        ],
      },
    ];
  const r = await prisma.metaSheet.updateMany({
    where,
    data: {
      syncLeaseUntil: new Date(now.getTime() + LEASE_MS),
      syncLeaseOwner: owner,
      lastSyncAttemptAt: now,
    },
  });
  return r.count === 1;
}

async function currentMember(sheetId: string) {
  return prisma.sheetAssignment.findFirst({
    where: { sheetId, unassignedAt: null },
    select: { memberId: true },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof SheetsApiError || err instanceof SyncError)
    return err.message;
  logger.error({ err }, "sheet sync unexpected error");
  return "Sync mein ghair-mutawaqqa masla — agli sync mein dobara koshish hogi.";
}

/** Hamza Zafar (MARKETING_DIRECTOR) and Muaz Tahir (MARKETING_LEAD). */
async function alertRecipients() {
  const [hamza, muaz] = await Promise.all([
    prisma.user.findMany({
      where: { role: "MARKETING_DIRECTOR", active: true },
      select: { id: true },
    }),
    prisma.user.findMany({
      where: { role: "MARKETING_LEAD", active: true },
      select: { id: true },
    }),
  ]);
  return [...hamza, ...muaz].map((u) => u.id);
}

/**
 * Run one sync for a sheet whose lease the caller holds. Never throws for sheet / Google problems: they are
 * recorded as a FAILED run and returned.
 */
export async function runSync(
  sheetId: string,
  opts: {
    trigger: "SCHEDULED" | "MANUAL";
    actor?: Actor;
    owner: string;
    now?: Date;
  },
): Promise<SyncResult> {
  const startedAt = opts.now ?? new Date();
  const actor = opts.actor ?? systemActor;
  const runId = randomUUID();
  const sheet = await prisma.metaSheet.findUnique({ where: { id: sheetId } });
  if (!sheet) throw new NotFoundError("Sheet");
  const base = {
    id: runId,
    sheetId,
    trigger: opts.trigger,
    actorId: actor.id,
    workerId: opts.owner,
    startedAt,
  } as const;
  let fromRow: number | null = null;
  let rowsRead = 0;

  try {
    const map = columnMapSchema.safeParse(sheet.columnMap);
    if (!sheet.googleSheetId || !sheet.tabName || !map.success)
      throw new SyncError(
        "Google Sheet ID, tab ya columns set nahi — sheet edit karein.",
      );
    const member = await currentMember(sheetId);
    if (!member)
      throw new SyncError(
        "Sheet kisi member ko assign nahi — leads import nahi hue.",
      );
    const api = sheetsApi();

    const header =
      (await api.values(sheet.googleSheetId, a1(sheet.tabName, "1:1")))
        .values[0] ?? [];
    const { cols, missing } = resolveColumns(header, map.data);
    if (!cols)
      throw new SyncError(
        `Header row mein columns nahi mile: ${missing.join(", ")}`,
      );

    const overlap = cols.id !== null ? ID_OVERLAP_ROWS : 0;
    const requestStart = Math.max(2, sheet.syncCursorRow + 1 - overlap);
    fromRow = requestStart;
    const data = await api.values(
      sheet.googleSheetId,
      a1(sheet.tabName, `A${requestStart}:ZZZ`),
    );
    const firstRow = startRowOf(data.range) ?? requestStart;
    rowsRead = data.values.length;
    const lastRowInSheet = rowsRead ? firstRow + rowsRead - 1 : null;

    const parsed: ParsedRow[] = data.values.map((cells, i) =>
      parseRow(cells, firstRow + i, cols),
    );
    const leadsInRange = parsed.filter(
      (p): p is Extract<ParsedRow, { kind: "lead" }> => p.kind === "lead",
    );
    // Two writers inserting the same keys can deadlock in InnoDB: retry; the next attempt sees the rows already there.
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const existing = new Set(
          leadsInRange.length
            ? (
                await prisma.lead.findMany({
                  where: {
                    sheetId,
                    externalRowId: { in: leadsInRange.map((l) => l.key) },
                  },
                  select: { externalRowId: true },
                })
              ).map((l) => l.externalRowId!)
            : [],
        );

        // Walk rows in order; stop after MAX_NEW_PER_RUN new leads so the cursor never skips unprocessed rows.
        const fresh: Extract<ParsedRow, { kind: "lead" }>[] = [];
        const skippedRows: { row: number; reason: string }[] = [];
        const seenKeys = new Set<string>();
        let alreadyImported = 0;
        let cursor = sheet.syncCursorRow;
        let more = false;
        for (const p of parsed) {
          if (fresh.length >= MAX_NEW_PER_RUN) {
            more = true;
            break;
          }
          cursor = Math.max(cursor, p.row);
          if (p.kind === "blank") continue;
          // Rows before the old cursor were already handled (overlap window only re-checks ids).
          if (p.kind === "invalid") {
            if (p.row > sheet.syncCursorRow)
              skippedRows.push({ row: p.row, reason: p.reason });
            continue;
          }
          if (existing.has(p.key) || seenKeys.has(p.key)) {
            if (p.row > sheet.syncCursorRow) alreadyImported++;
            continue;
          }
          seenKeys.add(p.key);
          fresh.push(p);
        }
        // id-keyed sheets may shrink after deletions: follow the sheet's real end so new rows are re-read.
        if (!more && cols.id !== null && lastRowInSheet !== null)
          cursor = lastRowInSheet;
        if (!more && cols.id !== null && lastRowInSheet === null)
          cursor = Math.min(cursor, requestStart - 1);

        // Duplicate-phone flag (spec §8): point at the oldest lead with the same phone (any sheet), or an earlier row of this batch.
        const phones = [...new Set(fresh.map((f) => f.phone))];
        const firstByPhone = new Map<string, string>();
        if (phones.length) {
          const prior = await prisma.lead.findMany({
            where: { phone: { in: phones } },
            select: { id: true, phone: true },
            orderBy: { createdAt: "asc" },
          });
          for (const p of prior)
            if (!firstByPhone.has(p.phone)) firstByPhone.set(p.phone, p.id);
        }
        let duplicatePhones = 0;
        const rows = fresh.map((f) => {
          const id = randomUUID();
          const dup = firstByPhone.get(f.phone) ?? null;
          if (dup) duplicatePhones++;
          else firstByPhone.set(f.phone, id);
          return {
            id,
            sheetId,
            assignedMemberId: member.memberId,
            name: f.name,
            phone: f.phone,
            phoneRaw: f.phoneRaw,
            remarks: f.remarks,
            externalRowId: f.key,
            sheetRowNumber: f.row,
            duplicateOfId: dup,
          };
        });

        const imported = await prisma.$transaction(
          async (tx) => {
            const created = rows.length
              ? (await tx.lead.createMany({ data: rows, skipDuplicates: true }))
                  .count
              : 0;
            await tx.metaSheet.update({
              where: { id: sheetId },
              data: {
                syncCursorRow: cursor,
                lastSyncAt: new Date(),
                lastSyncStatus: "SUCCESS",
                lastSyncError: null,
                consecutiveFailures: 0,
              },
            });
            await tx.sheetSyncRun.create({
              data: {
                ...base,
                status: "SUCCESS",
                fromRow,
                toRow: lastRowInSheet,
                rowsRead,
                imported: created,
                alreadyImported,
                duplicatePhones,
                skipped: skippedRows.length,
                details: skippedRows.length
                  ? skippedRows.slice(0, 20)
                  : Prisma.JsonNull,
              },
            });
            if (created || opts.trigger === "MANUAL") {
              await audit(tx, actor, {
                action: "SHEET_SYNC",
                recordType: "MetaSheet",
                recordId: sheetId,
                after: {
                  runId,
                  trigger: opts.trigger,
                  imported: created,
                  duplicatePhones,
                  skipped: skippedRows.length,
                  cursor,
                },
              });
            }
            if (created) {
              const names = rows
                .slice(0, 3)
                .map((r) => r.name)
                .join(", ");
              await notifyUsers(tx, [member.memberId], {
                type: "NEW_LEADS",
                subject: `${created} naya lead${created > 1 ? "s" : ""} — ${sheet.campaign}`,
                body: `${names}${created > 3 ? ` +${created - 3}` : ""} · ${sheet.title}`,
                recordType: "MetaSheet",
                recordId: sheetId,
                priority: 1,
                dedupeKey: `sheetsync:${runId}`,
              });
              await publish(tx, [userRoom(member.memberId)], "queue:changed", {
                sheetId,
              });
            }
            return created;
          },
          { timeout: 60_000 },
        );
        await releaseLease(sheetId, opts.owner);
        return {
          runId,
          status: "SUCCESS",
          imported,
          alreadyImported,
          duplicatePhones,
          skipped: skippedRows.length,
          rowsRead,
          error: null,
          more,
        };
      } catch (err) {
        if (
          attempt < 4 &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2034"
        ) {
          await new Promise((r) =>
            setTimeout(r, 40 * attempt + Math.floor(Math.random() * 40)),
          );
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    const message = errorMessage(err);
    await recordFailure(
      sheetId,
      { ...base, fromRow, rowsRead },
      message,
      actor,
      opts.trigger,
    );
    await releaseLease(sheetId, opts.owner);
    return {
      runId,
      status: "FAILED",
      imported: 0,
      alreadyImported: 0,
      duplicatePhones: 0,
      skipped: 0,
      rowsRead,
      error: message,
      more: false,
    };
  }
}

async function releaseLease(sheetId: string, owner: string) {
  await prisma.metaSheet.updateMany({
    where: { id: sheetId, syncLeaseOwner: owner },
    data: { syncLeaseUntil: null, syncLeaseOwner: null },
  });
}

async function recordFailure(
  sheetId: string,
  run: {
    id: string;
    sheetId: string;
    trigger: "SCHEDULED" | "MANUAL";
    actorId: string | null;
    workerId: string;
    startedAt: Date;
    fromRow: number | null;
    rowsRead: number;
  },
  message: string,
  actor: Actor,
  trigger: "SCHEDULED" | "MANUAL",
) {
  const alertAfter = await getSetting("meta.syncFailureAlertAfter");
  const recipients = await alertRecipients();
  await prisma.$transaction(async (tx) => {
    const s = await tx.metaSheet.update({
      where: { id: sheetId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "FAILED",
        lastSyncError: message,
        consecutiveFailures: { increment: 1 },
      },
    });
    await tx.sheetSyncRun.create({
      data: { ...run, status: "FAILED", error: message },
    });
    if (trigger === "MANUAL")
      await audit(tx, actor, {
        action: "SHEET_SYNC_FAILED",
        recordType: "MetaSheet",
        recordId: sheetId,
        after: { runId: run.id, error: message },
      });
    // Exactly once per failure streak: when the streak reaches the threshold.
    if (s.consecutiveFailures === alertAfter) {
      await audit(tx, systemActor, {
        action: "SHEET_SYNC_ALERT",
        recordType: "MetaSheet",
        recordId: sheetId,
        after: { failures: s.consecutiveFailures, error: message },
      });
      await notifyUsers(tx, recipients, {
        type: "SHEET_SYNC_FAILING",
        subject: `Lead sync fail: ${s.campaign} (${s.consecutiveFailures} dafa)`,
        body: `${s.title} — ${message}`,
        recordType: "MetaSheet",
        recordId: sheetId,
        priority: 2,
        dedupeKey: `sheetsync:fail:${sheetId}:${run.id}`,
      });
    }
  });
}

/** Worker watcher: sync every due sheet. Returns the number of sheets synced this pass. */
export async function runSheetSync(now: Date, owner: string): Promise<number> {
  if ((await getSetting("meta.syncMethod")) !== "google_sheets") return 0;
  const intervalMin = await getSetting("meta.syncIntervalMin");
  const due = await prisma.metaSheet.findMany({
    where: {
      active: true,
      googleSheetId: { not: null },
      tabName: { not: null },
      assignments: { some: { unassignedAt: null } },
      OR: [
        { lastSyncAttemptAt: null },
        {
          lastSyncAttemptAt: {
            lte: new Date(now.getTime() - intervalMin * 60_000),
          },
        },
      ],
      AND: [
        { OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }] },
      ],
    },
    select: { id: true },
    orderBy: { lastSyncAttemptAt: "asc" },
  });
  let n = 0;
  for (const s of due) {
    if (!(await claimSheet(s.id, owner, now, intervalMin))) continue;
    const r = await runSync(s.id, { trigger: "SCHEDULED", owner, now });
    if (r.imported || r.status === "FAILED")
      logger.info({ sheetId: s.id, ...r }, "sheet sync");
    n++;
  }
  return n;
}

// ───────────── Admin (Hamza / Usama, `leads:admin`) ─────────────

/** "Sync now" — runs in the API process under the same lease as the workers. */
export async function syncNow(
  actor: Actor,
  sheetId: string,
): Promise<SyncResult> {
  const sheet = await prisma.metaSheet.findUnique({
    where: { id: sheetId },
    select: { googleSheetId: true, tabName: true, active: true },
  });
  if (!sheet) throw new NotFoundError("Sheet");
  if (!sheet.googleSheetId || !sheet.tabName)
    throw new ValidationError("Pehle Google Sheet ID aur tab set karein.");
  if (!(await currentMember(sheetId)))
    throw new ValidationError("Pehle sheet kisi member ko assign karein.");
  const owner = `api:${actor.id}:${randomUUID().slice(0, 8)}`;
  if (!(await claimSheet(sheetId, owner, new Date(), null)))
    throw new ConflictError(
      "SYNC_BUSY",
      "Is sheet ki sync abhi chal rahi hai — thori der baad dekhein.",
    );
  return runSync(sheetId, { trigger: "MANUAL", actor, owner });
}

export async function syncConfig() {
  const [method, intervalMin, alertAfter] = await Promise.all([
    getSetting("meta.syncMethod"),
    getSetting("meta.syncIntervalMin"),
    getSetting("meta.syncFailureAlertAfter"),
  ]);
  const email = serviceAccountEmail();
  return {
    configured: !!email,
    serviceAccountEmail: email,
    method,
    intervalMin,
    alertAfter,
  };
}

/** Per linked sheet: last sync, status, error, failure streak — for Hamza / Muaz / MD (read-only). */
export async function syncStatus() {
  const [sheets, intervalMin, method] = await Promise.all([
    prisma.metaSheet.findMany({
      where: { googleSheetId: { not: null }, active: true },
      select: { id: true, title: true, campaign: true, lastSyncAt: true, lastSyncStatus: true, lastSyncError: true, consecutiveFailures: true, assignments: { where: { unassignedAt: null }, select: { memberId: true } } },
      orderBy: [{ consecutiveFailures: 'desc' }, { title: 'asc' }],
    }),
    getSetting('meta.syncIntervalMin'),
    getSetting('meta.syncMethod'),
  ]);
  const members = await prisma.user.findMany({ where: { id: { in: sheets.flatMap((s) => s.assignments.map((a) => a.memberId)) } }, select: { id: true, displayName: true } });
  return {
    intervalMin,
    paused: method !== 'google_sheets',
    items: sheets.map(({ assignments, ...s }) => ({ ...s, member: members.find((m) => m.id === assignments[0]?.memberId)?.displayName ?? null })),
  };
}

export async function syncRuns(sheetId: string) {
  const rows = await prisma.sheetSyncRun.findMany({
    where: { sheetId },
    orderBy: { startedAt: "desc" },
    take: 30,
  });
  const actors = await prisma.user.findMany({
    where: {
      id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) },
    },
    select: { id: true, displayName: true },
  });
  return {
    items: rows.map((r) => ({
      ...r,
      actor: actors.find((a) => a.id === r.actorId)?.displayName ?? null,
    })),
  };
}

/**
 * Test connection before / after saving: spreadsheet title + tabs, header row, missing columns, data row count
 * and two sample rows (phone masked). Google problems come back as `{ ok: false, error }`, not as an HTTP error.
 */
export async function testConnection(input: {
  googleSheetId: string;
  tabName: string;
  columnMap: ColumnMap;
}) {
  const serviceAccount = serviceAccountEmail();
  try {
    const api = sheetsApi();
    const meta = await api.spreadsheet(input.googleSheetId);
    if (!meta.tabs.includes(input.tabName))
      return {
        ok: false as const,
        serviceAccount,
        title: meta.title,
        tabs: meta.tabs,
        error: `Tab "${input.tabName}" nahi mila. Tabs: ${meta.tabs.join(", ")}`,
      };
    const header =
      (await api.values(input.googleSheetId, a1(input.tabName, "1:1")))
        .values[0] ?? [];
    const { cols, missing } = resolveColumns(header, input.columnMap);
    if (!cols)
      return {
        ok: false as const,
        serviceAccount,
        title: meta.title,
        tabs: meta.tabs,
        headers: header,
        missing,
        error: `Header row mein columns nahi mile: ${missing.join(", ")}`,
      };
    const data = await api.values(
      input.googleSheetId,
      a1(input.tabName, "A2:ZZZ"),
    );
    const first = startRowOf(data.range) ?? 2;
    const parsed = data.values.map((c, i) => parseRow(c, first + i, cols));
    const leads = parsed.filter(
      (p): p is Extract<ParsedRow, { kind: "lead" }> => p.kind === "lead",
    );
    return {
      ok: true as const,
      serviceAccount,
      title: meta.title,
      tabs: meta.tabs,
      headers: header,
      missing: [],
      dataRows: leads.length,
      invalidRows: parsed.filter((p) => p.kind === "invalid").length,
      idColumn: cols.id !== null,
      sample: leads
        .slice(0, 2)
        .map((l) => ({ row: l.row, name: l.name, phone: maskPhone(l.phone) })),
    };
  } catch (err) {
    return { ok: false as const, serviceAccount, error: errorMessage(err) };
  }
}
